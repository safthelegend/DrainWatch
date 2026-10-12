// Drives the scroll story: reads how far the reader has scrolled through each
// section (pin-and-scrub only; scroll speed is never touched) and turns it into
// a camera pose, a replay hour and the text on screen.
//
// Works in three modes:
//   • 3D: the WebGL stage (lazy-loaded)
//   • stills: pre-rendered images when WebGL is unavailable or the device is low-power
//   • reduced motion: no camera flights or drift; each step cross-fades instead

import { buildStory, ntaBlender, storyTime, waterNavdMeters } from './stories.js';
import { clamp01, lerpPose, poseAt, stepAt, stepPath } from './camera.js';
import { nyLocalToUtc, solarPosition } from './sun.js';
import { esc } from '../ui.js';

const $ = (id) => document.getElementById(id);
const mobileQuery = window.matchMedia('(max-width: 860px)');
const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

// Camera keyframes (center lon/lat · distance km · compass bearing faced · tilt from straight down)
const CITY = {
  hero: { lon: -73.94, lat: 40.715, dist: 66, bearing: 28, tilt: 56 },
  start: { lon: -73.94, lat: 40.71, dist: 66, bearing: 29, tilt: 46 },
  end: { lon: -73.93, lat: 40.73, dist: 56, bearing: 40, tilt: 50 },
  stepDist: 30,
  stepTilt: 47,
};
const HARBOR = {
  hero: { lon: -73.88, lat: 40.65, dist: 66, bearing: 58, tilt: 54 },
  start: { lon: -73.95, lat: 40.65, dist: 72, bearing: 10, tilt: 34 },
  end: { lon: -73.95, lat: 40.64, dist: 62, bearing: 20, tilt: 40 },
  stepDist: 32,
  stepTilt: 40,
};
const CAMERAS = { heat: CITY, air: CITY, wind: CITY, floods: HARBOR };
const HANDOFF = { lon: -73.94, lat: 40.7, dist: 70, bearing: 0, tilt: 1 };

// reference line on the timeline strip
const REFERENCE = {
  heat: { value: 105, label: 'Warning 105°F' },
  air: { value: 150, label: 'Unhealthy 150' },
  wind: { value: 58, label: 'Damaging 58 mph' },
  floods: { value: null, label: 'Flood stage' },
};

const SLR_SHARE = 0.22; // the last share of the flood timeline raises the sea instead of the clock

export function createStoryController({ theme, onStoryChange } = {}) {
  let stage = null;
  let mode = 'text'; // 'text' until the stage or stills are ready
  let story = null;
  let blend = null;
  let hazard = null;
  let currentTheme = theme;
  const target = { hero: 0, timeline: 0, exposed: 0, release: 0 };
  const shown = { ...target };
  let lastShot = null;
  let running = false;
  let lastStep = -1;
  let lastBeat = -2;
  let attachedAt = 0;

  const reduced = () => reducedQuery.matches;
  const mobile = () => mobileQuery.matches;

  // ---------------- DOM ----------------

  function renderText() {
    $('timeline-kicker').textContent = story.timeline.kicker;
    $('timeline-title').textContent = story.timeline.title;
    $('timeline-dek').textContent = story.timeline.dek;
    $('readout-unit').textContent = story.unit.trim() === 'ft' ? ' ft' : story.unit;
    $('beats').innerHTML = story.beats.map((b, i) => `<li class="beat" data-i="${i}">${esc(b.text)}</li>`).join('');
    $('clock-time').textContent = storyTime(story.time[0]);
    $('readout-num').textContent = story.hazard === 'floods' ? story.citywide[0].toFixed(1) : Math.round(story.citywide[0]);
    $('timeline-note').textContent =
      story.hazard === 'floods'
        ? 'Water level at the Battery, reconstructed from NOAA records. Elevation: USGS 3DEP. Sea level rise: NPCC 2019.'
        : 'Neighborhood values modeled from 39 points. Approximate reconstruction from NOAA, NWS and EPA records.';

    $('exposed-kicker').textContent = story.exposed.kicker;
    $('exposed-title').textContent = story.exposed.title;
    $('exposed-dek').textContent = story.exposed.dek;
    $('exposed-note').textContent =
      story.hazard === 'floods'
        ? 'Water at its measured peak. Land below the waterline is shaded by flood depth.'
        : 'Raised and colored: the 39 neighborhoods DrainWatch rates, by risk at the peak. Flat: not rated.';
    $('stops').innerHTML = story.stops
      .map(
        (e, i) => `<li data-i="${i}"><span>${esc(e.area.name)}</span>
          <span class="lv lvl-${e.level}"><span class="swatch"></span>${esc(levelWord(e.level))}</span></li>`,
      )
      .join('');
    drawStrip();
  }

  function levelWord(level) {
    return { low: 'Low', elevated: 'Elevated', high: 'High', severe: 'Severe' }[level];
  }

  // ---------------- the timeline strip ----------------

  let strip = null;
  function drawStrip() {
    const svg = $('timeline-svg');
    const W = svg.clientWidth || 800;
    const H = svg.clientHeight || 100;
    const pad = { l: 16, r: 16, t: 26, b: 22 };
    const n = story.time.length;
    const x = (k) => pad.l + (k / (n - 1)) * (W - pad.l - pad.r);
    const values = story.citywide;
    const ref = REFERENCE[story.hazard];
    const refValue = story.hazard === 'floods' ? 1.8 : ref.value;
    const lo = Math.min(...values, refValue) - (story.hazard === 'floods' ? 0.5 : 2);
    const hi = Math.max(...values, refValue) * (story.hazard === 'floods' ? 1.05 : 1.02);
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);

    // night bands from the real sun
    let nights = '';
    let start = null;
    story.time.forEach((t, k) => {
      const dark = solarPosition(nyLocalToUtc(t)).elevation < -3;
      if (dark && start == null) start = k;
      if ((!dark || k === n - 1) && start != null) {
        nights += `<rect class="t-night" x="${x(Math.max(0, start - 0.5))}" y="0" width="${x(Math.min(n - 1, k - 0.5)) - x(Math.max(0, start - 0.5))}" height="${H - pad.b + 4}" />`;
        start = null;
      }
    });
    let days = '';
    story.time.forEach((t, k) => {
      if (t.endsWith('T00:00') || k === 0) {
        const label = storyTime(t).split(',')[0].slice(0, 3);
        days += `<line class="t-axis" x1="${x(k)}" x2="${x(k)}" y1="${H - pad.b}" y2="${H - pad.b + 5}" /><text class="t-text" x="${x(k) + 3}" y="${H - 6}">${label}</text>`;
      }
    });
    const path = values.map((v, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const yr = y(refValue);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = `${nights}${days}
      <line class="t-ref" x1="${pad.l}" x2="${W - pad.r}" y1="${yr}" y2="${yr}" />
      <text class="t-text" x="${W - pad.r}" y="${yr - 5}" text-anchor="end">${esc(ref.label)}</text>
      <path class="t-line-base" d="${path}" />
      <clipPath id="t-clip"><rect id="t-clip-rect" x="0" y="0" width="0" height="${H}" /></clipPath>
      <path class="t-line" d="${path}" clip-path="url(#t-clip)" />
      <line class="t-cursor" id="t-cursor" x1="0" x2="0" y1="${pad.t - 10}" y2="${H - pad.b}" />
      <circle class="t-dot" id="t-dot" r="4" cx="0" cy="0" />`;
    strip = { x, y, W };
  }

  function updateStrip(hourF, value) {
    if (!strip) return;
    const cx = strip.x(hourF);
    $('t-clip-rect').setAttribute('width', cx);
    $('t-cursor').setAttribute('x1', cx);
    $('t-cursor').setAttribute('x2', cx);
    $('t-dot').setAttribute('cx', cx);
    $('t-dot').setAttribute('cy', strip.y(value));
  }

  // ---------------- per-frame state ----------------

  const lerp = (a, b, t) => a + (b - a) * t;
  function valueAt(series, hourF) {
    const k = Math.floor(hourF);
    const k2 = Math.min(series.length - 1, k + 1);
    return lerp(series[k], series[k2], hourF - k);
  }

  function timelineState(p) {
    const n = story.time.length;
    let hourF;
    let slr = 0;
    if (story.hazard === 'floods') {
      const split = 1 - SLR_SHARE;
      hourF = Math.min(1, p / split) * story.peak.index;
      slr = p > split ? clamp01((p - split) / SLR_SHARE) : 0;
      slr = slr * slr * (3 - 2 * slr);
    } else {
      hourF = p * (n - 1);
    }
    // reduced motion: hold each beat's hour instead of scrubbing continuously
    let beat = -1;
    story.beats.forEach((b, i) => {
      if (b.slr ? slr > 0.05 : hourF >= b.index - 0.001) beat = i;
    });
    if (reduced()) hourF = beat >= 0 && !story.beats[beat].slr ? story.beats[beat].index : beat >= 0 ? story.peak.index : 0;
    return { hourF, slr, beat };
  }

  function citywideAt(hourF, slr) {
    const v = valueAt(story.citywide, hourF);
    return story.hazard === 'floods' ? v + slr * (story.slr.inches / 12) : v;
  }

  /** Risk score at the peak, per NTA: rated neighborhoods only (NaN = not rated). */
  let riskNta = null;
  function applyRisk() {
    if (!stage || !riskNta) return;
    stage.setTime(story.time[story.peak.index], 0, story.hazard === 'air' ? 0.5 * clamp01((story.peak.value - 100) / 300) : 0);
    if (story.hazard === 'floods') stage.setWater(waterNavdMeters(story.peak.value));
    else stage.setNtaValues(riskNta, [0, 4]);
  }

  function applyData(hourF, slr) {
    if (!stage) return;
    const k = Math.floor(hourF);
    const frac = hourF - k;
    const key = story.time[k];
    const smoke = story.hazard === 'air' ? clamp01((citywideAt(hourF, 0) - 100) / 300) : 0;
    stage.setTime(key, frac, smoke);
    if (story.hazard === 'floods') {
      stage.setWater(waterNavdMeters(citywideAt(hourF, slr)));
    } else if (blend) {
      const a = blend(k);
      const b = blend(Math.min(story.time.length - 1, k + 1));
      const v = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) v[i] = lerp(a[i], b[i], frac);
      stage.setNtaValues(v, story.domain);
    }
  }

  function frameFor(section) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (mobile()) return section === 'hero' ? { x: 0, y: H * 0.4 } : { x: 0, y: -H * 0.24 };
    const side = Math.min(W * 0.36, 540);
    return section === 'hero' ? { x: W * (story && story.hazard === 'floods' ? 0.32 : 0.2), y: H * 0.04 } : { x: side / 2, y: -54 };
  }

  function exposedPath() {
    const cam = CAMERAS[story.hazard];
    const poses = story.stops.map((e) => ({
      lon: e.area.lon,
      lat: e.area.lat,
      dist: cam.stepDist * (mobile() ? 1.3 : 1),
      bearing: e.bearing,
      tilt: cam.stepTilt - (mobile() ? 10 : 0),
    }));
    return stepPath(poses, { start: timelineEnd() });
  }

  // A portrait phone sees a narrow slice of the city, so citywide shots pull far back to fit its width.
  const adjust = (pose) => (mobile() ? { ...pose, dist: pose.dist * 2.8, tilt: Math.max(1, pose.tilt - 10) } : pose);
  const timelineStart = () => adjust(CAMERAS[story.hazard].start);
  const timelineEnd = () => adjust(mobile() ? { ...CAMERAS[story.hazard].end, bearing: CAMERAS[story.hazard].start.bearing } : CAMERAS[story.hazard].end);

  function heroPose(time) {
    const hero = CAMERAS[story.hazard].hero;
    // on phones the city sits small in the bottom third, below the headline and search
    const base = mobile() ? { ...hero, dist: hero.dist * 3.2, tilt: hero.tilt - 6 } : hero;
    if (reduced()) return base;
    const t = time / 1000;
    return { ...base, bearing: base.bearing + 6 * Math.sin(t / 20), dist: base.dist * (1 - 0.05 * (0.5 + 0.5 * Math.sin(t / 27))) };
  }

  // ---------------- the main update ----------------

  function update(time) {
    const p = shown;
    let pose;
    let frame;
    let hourF = story.heroIndex;
    let slr = 0;
    let shot = 'hero';

    if (p.release > 0) {
      const ex = exposedPath();
      pose = lerpPose(poseAt(ex, 1), adjust(HANDOFF), reduced() ? 1 : p.release);
      frame = frameFor('pinned');
      hourF = story.peak.index;
      slr = story.hazard === 'floods' ? 1 : 0;
      shot = `stop-${story.stops.length - 1}`;
    } else if (p.exposed > 0) {
      const ex = exposedPath();
      const { index } = stepAt(p.exposed, story.stops.length);
      pose = reduced() ? ex[2 * index + 1].pose : poseAt(ex, p.exposed);
      frame = frameFor('pinned');
      hourF = story.peak.index;
      slr = 0;
      shot = `stop-${index}`;
      updateStops(index);
    } else if (p.timeline > 0) {
      const st = timelineState(p.timeline);
      hourF = st.hourF;
      slr = st.slr;
      pose = reduced() ? timelineStart() : lerpPose(timelineStart(), timelineEnd(), p.timeline, { ease: (t) => t });
      frame = frameFor('pinned');
      shot = st.beat >= 0 ? `beat-${st.beat}` : 'beat-0';
      updateBeats(st.beat, hourF, slr);
    } else {
      const exit = reduced() ? 0 : p.hero;
      pose = lerpPose(heroPose(time), timelineStart(), exit);
      const a = frameFor('hero');
      const b = frameFor('pinned');
      frame = { x: lerp(a.x, b.x, exit), y: lerp(a.y, b.y, exit) };
      hourF = lerp(story.heroIndex, 0, exit);
    }
    if (p.exposed <= 0) hideAnnotation();

    if (mode === 'stage') {
      stage.instant = reduced();
      stage.setFrame(Math.round(frame.x), Math.round(frame.y));
      stage.setPose(pose);
      if (p.exposed > 0 || p.release > 0) applyRisk();
      else applyData(hourF, slr);
      if (p.exposed > 0 && p.release <= 0) placeAnnotation(p.exposed);
      const canvas = $('stage');
      const fadeIn = reduced() ? 1 : Math.min(1, (time - attachedAt) / 700);
      canvas.style.opacity = String(fadeIn * (1 - (reduced() ? (p.release > 0.5 ? 1 : 0) : p.release)));
      stage.render();
    } else if (mode === 'stills') {
      if (shot !== lastShot) showStill(shot);
      $('still').style.opacity = String(1 - p.release);
    }
    lastShot = shot;
  }

  function updateBeats(beat, hourF, slr) {
    if (beat !== lastBeat) {
      document.querySelectorAll('#beats .beat').forEach((li, i) => li.classList.toggle('on', i === beat));
      lastBeat = beat;
      if (reduced() && mode === 'stage') crossfade();
    }
    const k = Math.min(story.time.length - 1, Math.round(hourF));
    let clock = storyTime(story.time[k]);
    if (slr > 0.05) clock += ` · +${Math.round(story.slr.inches * slr)} in of sea level rise`;
    $('clock-time').textContent = clock;
    const v = citywideAt(hourF, slr);
    $('readout-num').textContent = story.hazard === 'floods' ? v.toFixed(1) : Math.round(v);
    updateStrip(hourF, valueAt(story.citywide, hourF));
  }

  function updateStops(index) {
    if (index !== lastStep) {
      document.querySelectorAll('#stops li').forEach((li, i) => li.classList.toggle('on', i === index));
      lastStep = index;
      if (reduced() && mode === 'stage') crossfade();
      const e = story.stops[index];
      $('annotation').className = `annotation lvl-${e.level}`;
      $('annotation').innerHTML = `<p class="lv"><span class="swatch"></span>${levelWord(e.level)} ${esc(story.hazard === 'floods' ? 'flood' : story.hazard === 'air' ? 'air quality' : story.hazard)} risk</p>
        <h3>${esc(e.area.name)}</h3>
        <ul>${e.drivers.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`;
    }
  }

  function placeAnnotation(p) {
    const { index, local } = stepAt(p, story.stops.length);
    const e = story.stops[index];
    const el = $('annotation');
    const leader = $('leader');
    // fade in once the camera has arrived, out just before the next flight
    const fade = reduced() ? 1 : clamp01((local - 0.42) / 0.12) * clamp01((1 - local) / 0.06 + (index === story.stops.length - 1 ? 1 : 0));
    const pt = stage.toScreen(e.area.lon, e.area.lat, stage.areaTop(e.area.id));
    if (!pt.visible || fade <= 0) {
      el.style.opacity = '0';
      leader.style.opacity = '0';
      return;
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = mobile() ? 0 : Math.min(W * 0.36, 540);
    let lx = pt.x > (left + W) / 2 ? pt.x - w - 56 : pt.x + 56;
    lx = Math.max(left + 16, Math.min(W - w - 16, lx));
    const top = mobile() ? 108 : 70;
    const bottom = mobile() ? H * 0.5 : H;
    const ly = Math.max(top, Math.min(bottom - h - 16, pt.y - h - 40));
    el.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px)`;
    el.style.opacity = String(fade);
    const line = leader.querySelector('line');
    const anchorX = lx > pt.x ? lx : lx + w;
    line.setAttribute('x1', pt.x);
    line.setAttribute('y1', pt.y);
    line.setAttribute('x2', anchorX);
    line.setAttribute('y2', ly + h);
    const dot = leader.querySelector('circle');
    dot.setAttribute('cx', pt.x);
    dot.setAttribute('cy', pt.y);
    leader.style.opacity = String(fade);
  }

  function hideAnnotation() {
    $('annotation').style.opacity = '0';
    $('leader').style.opacity = '0';
    if (lastStep !== -1) {
      lastStep = -1;
      document.querySelectorAll('#stops li').forEach((li) => li.classList.remove('on'));
    }
  }

  function crossfade() {
    const c = $('stage');
    c.style.transition = 'none';
    c.style.opacity = '0.15';
    requestAnimationFrame(() => {
      c.style.transition = 'opacity 0.2s';
      c.style.opacity = '1';
    });
  }

  function showStill(shot) {
    const img = $('still');
    img.hidden = false;
    img.style.opacity = '0';
    const src = `assets/stills/${story.hazard}-${currentTheme}-${shot}.jpg`;
    img.onload = () => (img.style.opacity = '1');
    img.onerror = () => (img.hidden = true);
    img.src = src;
  }

  // ---------------- scroll progress ----------------
  // GSAP ScrollTrigger reports how far each section has scrolled. Without it
  // (script blocked), the same numbers come from getBoundingClientRect.

  let triggers = null;
  function useScrollTrigger() {
    const ST = window.ScrollTrigger;
    if (!ST || !window.gsap) return false;
    window.gsap.registerPlugin(ST);
    const set = (key) => (self) => {
      target[key] = self.progress;
    };
    triggers = [
      ST.create({ trigger: '#top', start: 'top top', end: 'bottom top', onUpdate: set('hero') }),
      ST.create({ trigger: '#timeline', start: 'top top', end: 'bottom bottom', onUpdate: set('timeline'), onLeave: () => (target.timeline = 1), onLeaveBack: () => (target.timeline = 0) }),
      ST.create({ trigger: '#exposed', start: 'top top', end: 'bottom bottom', onUpdate: set('exposed'), onLeaveBack: () => (target.exposed = 0) }),
      ST.create({ trigger: '#app', start: 'top bottom', end: 'top top', onUpdate: set('release'), onLeaveBack: () => (target.release = 0) }),
    ];
    return true;
  }

  function measure() {
    const vh = window.innerHeight;
    const prog = (el) => {
      const r = el.getBoundingClientRect();
      return clamp01(-r.top / Math.max(1, r.height - vh));
    };
    const hero = $('top').getBoundingClientRect();
    target.hero = clamp01(-hero.top / Math.max(1, hero.height));
    target.timeline = prog($('timeline'));
    target.exposed = prog($('exposed'));
    const app = $('app').getBoundingClientRect();
    target.release = clamp01((vh - app.top) / vh);
    // the timeline stays "on" only while it's the section in view
    if (target.exposed > 0) target.timeline = 1;
  }

  function loop(time) {
    if (!running) return;
    if (!triggers) measure();
    // ease displayed progress toward the scroll position: smooth, never ahead of the reader
    const k = reduced() ? 1 : 0.2;
    for (const key of Object.keys(target)) {
      const d = target[key] - shown[key];
      shown[key] = Math.abs(d) < 0.0005 ? target[key] : shown[key] + d * k;
    }
    if (story && shown.release < 1) update(time);
    requestAnimationFrame(loop);
  }

  // ---------------- public ----------------

  async function attachStage(createStage) {
    try {
      const canvas = $('stage');
      stage = await createStage(canvas, { theme: currentTheme, mobile: mobile() });
      if (story) await prepareStage();
      attachedAt = performance.now();
      mode = 'stage';
      document.body.classList.add('has-stage');
      return true;
    } catch (err) {
      console.warn('[DrainWatch] 3D unavailable, using stills', err);
      useStills();
      return false;
    }
  }

  function useStills() {
    mode = 'stills';
    document.body.classList.add('no-stage');
    lastShot = null;
  }

  async function prepareStage() {
    await stage.setHazard(story.hazard);
    if (story.hazard !== 'floods') {
      const features = await stage.loadNtas().then(() => stage.ntaFeatures);
      blend = ntaBlender(features, story);
      riskNta = new Float32Array(features.map((f) => (f.properties.areas.length ? Math.max(...f.properties.areas.map((id) => story.riskByArea[id])) : NaN)));
    } else {
      blend = null;
      riskNta = new Float32Array(0);
    }
  }

  async function setHazard(h, { heatDrivers } = {}) {
    hazard = h;
    story = buildStory(h, { heatDrivers });
    lastBeat = -2;
    lastStep = -2;
    lastShot = null;
    renderText();
    if (stage) await prepareStage();
    onStoryChange?.(story);
    if (window.ScrollTrigger) window.ScrollTrigger.refresh();
    return story;
  }

  function setTheme(t) {
    currentTheme = t;
    if (stage) stage.setTheme(t);
    lastShot = null;
  }

  function start() {
    if (running) return;
    running = true;
    if (!triggers) useScrollTrigger();
    else window.ScrollTrigger.refresh();
    if (story) drawStrip(); // the strip may have been measured while hidden
    requestAnimationFrame(loop);
  }

  /** Stop the frame loop while the story is hidden (the dashboard view): no scroll reads, no WebGL frames. */
  function pause() {
    running = false;
  }

  window.addEventListener('resize', () => {
    if (story && running) drawStrip();
  });

  return {
    setHazard,
    setTheme,
    attachStage,
    useStills,
    start,
    pause,
    get running() {
      return running;
    },
    get story() {
      return story;
    },
    get hazard() {
      return hazard;
    },
    get mode() {
      return mode;
    },
  };
}
