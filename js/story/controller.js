// Drives the 3D story, which plays in its own full-screen overlay: a position
// from 0 to 2 (0–1 the timeline, 1–2 "who's exposed") comes from the scrubber,
// the step buttons, the keyboard or Play, never from page scroll. The position
// becomes a camera pose, a replay hour and the text on screen. Play never stops
// on its own: it slows through each beat, keeps the camera drifting at each
// neighborhood, and loops back to the start.
//
// Works in three modes:
//   • 3D: the WebGL stage (lazy-loaded the first time the story opens)
//   • stills: pre-rendered images when WebGL is unavailable or the device is low-power
//   • reduced motion: no camera flights or drift; each step cross-fades instead

import { beatAt, buildStory, ntaBlender, playStep, SLR_SHARE, storySteps, storyTime, waterNavdMeters } from './stories.js';
import { clamp01, lerpPose, poseAt, stepAt, stepPath } from './camera.js';
import { nyLocalToUtc, solarPosition } from './sun.js';
import { loadTerrain, ntaElevationIndex, ntaShareBelow } from '../terrain.js';
import { esc } from '../ui.js';

const $ = (id) => document.getElementById(id);
const mobileQuery = window.matchMedia('(max-width: 860px)');
const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

// Camera keyframes (center lon/lat · distance km · compass bearing faced · tilt from straight down),
// the same for every story: framed so all five boroughs fit beside the text,
// Staten Island and the Rockaways included
const CAMERA = {
  hero: { lon: -73.95, lat: 40.69, dist: 80, bearing: 24, tilt: 54 },
  start: { lon: -73.97, lat: 40.67, dist: 84, bearing: 22, tilt: 44 },
  end: { lon: -73.96, lat: 40.68, dist: 76, bearing: 30, tilt: 48 },
  stepDist: 30,
  stepTilt: 47,
};
// while Play stays on a neighborhood, the camera keeps orbiting this far (and moves this much closer)
const STOP_DRIFT = { bearing: 14, zoom: 0.92 };
// when Play loops, the camera glides from the last neighborhood back to the citywide view
const GLIDE_MS = 1800;

// reference line on the timeline strip
const REFERENCE = {
  heat: { value: 105, label: 'Warning 105°F' },
  air: { value: 150, label: 'Unhealthy 150' },
  wind: { value: 58, label: 'Damaging 58 mph' },
  floods: { value: null, label: 'Flood stage' },
};

export function createStoryController({ theme, onStoryChange, onPosition } = {}) {
  let stage = null;
  let mode = 'text'; // 'text' until the stage or stills are ready
  let story = null;
  let blend = null;
  let hazard = null;
  let currentTheme = theme;
  const target = { hero: 0, timeline: 0, exposed: 0 };
  const shown = { ...target };
  let pos = 0; // 0–1 the timeline, 1–2 who's exposed
  let playing = false;
  let lastTime = 0;
  let nextStepAt = 0;
  let lastShot = null;
  let running = false;
  let lastStep = -1;
  let lastBeat = -2;
  let attachedAt = 0;
  let lastPose = null;
  let glide = null; // { from, start }: the camera easing home after Play loops

  const reduced = () => reducedQuery.matches;
  const mobile = () => mobileQuery.matches;

  // ---------------- DOM ----------------

  function renderText() {
    $('timeline-kicker').textContent = story.timeline.kicker;
    $('timeline-title').textContent = story.timeline.title;
    $('timeline-dek').textContent = story.timeline.dek;
    $('readout-unit').textContent = story.unit.trim() === 'ft' ? ' ft' : story.unit;
    // the clock shows the time on screen; screen readers get it with each beat instead
    $('beats').innerHTML = story.beats
      .map((b, i) => `<li class="beat" data-i="${i}"><span class="sr-only">${esc(b.slr ? `With ${story.slr.label} seas` : storyTime(story.time[b.index]))}: </span>${esc(b.text)}</li>`)
      .join('');
    $('clock-time').textContent = storyTime(story.time[0]);
    $('readout-num').textContent = story.hazard === 'floods' ? story.citywide[0].toFixed(1) : Math.round(story.citywide[0]);
    // what the city's height and color mean in this story
    const { legend } = story.city;
    $('city-legend-low').textContent = legend.low;
    $('city-legend-high').textContent = legend.high;
    $('city-legend-text').textContent = legend.text;
    $('timeline-note').textContent =
      story.hazard === 'floods'
        ? 'Water level at the Battery, reconstructed from NOAA records. Elevation: USGS 3DEP. Sea level rise: NPCC 2019.'
        : 'Neighborhood values modeled from 39 points. Approximate reconstruction from NOAA, NWS and EPA records.';

    $('exposed-kicker').textContent = story.exposed.kicker;
    $('exposed-title').textContent = story.exposed.title;
    $('exposed-dek').textContent = story.exposed.dek;
    $('exposed-note').textContent = 'Raised and colored: the 39 neighborhoods DrainWatch rates, by risk at the peak. Flat: not rated.';
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
    return { hourF, slr, beat, visible: beatAt(story, hourF, slr) };
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
    stage.setNtaValues(riskNta, [0, 4]);
  }

  function applyData(hourF, slr) {
    if (!stage) return;
    const k = Math.floor(hourF);
    const frac = hourF - k;
    const key = story.time[k];
    const smoke = story.hazard === 'air' ? clamp01((citywideAt(hourF, 0) - 100) / 300) : 0;
    stage.setTime(key, frac, smoke);
    if (story.city.fromTerrain) {
      // floods: the share of each neighborhood's land below the water at this moment
      if (floodIndex) stage.setNtaValues(ntaShareBelow(floodIndex, waterNavdMeters(citywideAt(hourF, slr))), story.city.domain);
    } else if (blend) {
      const a = blend(k);
      const b = blend(Math.min(story.time.length - 1, k + 1));
      const v = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) v[i] = lerp(a[i], b[i], frac);
      stage.setNtaValues(v, story.city.domain);
    }
  }

  function frameFor(section) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    // phones: the city sits in the strip above the text sheet (56svh) and the timeline strip
    if (mobile()) return section === 'hero' ? { x: 0, y: H * 0.4 } : { x: 0, y: -H * 0.27 };
    const side = Math.min(W * 0.36, 540);
    return section === 'hero' ? { x: W * 0.2, y: H * 0.04 } : { x: side / 2, y: -54 };
  }

  function exposedPath() {
    const poses = story.stops.map((e) => ({
      lon: e.area.lon,
      lat: e.area.lat,
      dist: CAMERA.stepDist * (mobile() ? 1.3 : 1),
      bearing: e.bearing,
      tilt: CAMERA.stepTilt - (mobile() ? 10 : 0),
    }));
    return stepPath(poses, { start: timelineEnd(), drift: reduced() ? null : STOP_DRIFT });
  }

  // A portrait phone sees a narrow slice of the city, so citywide shots pull far back to fit its width.
  const adjust = (pose) => (mobile() ? { ...pose, dist: pose.dist * 2.05, tilt: Math.max(1, pose.tilt - 10) } : pose);
  const timelineStart = () => adjust(CAMERA.start);
  const timelineEnd = () => adjust(mobile() ? { ...CAMERA.end, bearing: CAMERA.start.bearing } : CAMERA.end);

  function heroPose(time) {
    const hero = CAMERA.hero;
    // on phones the city sits small in the bottom third, below the headline and search
    const base = mobile() ? { ...hero, dist: hero.dist * 2.2, tilt: hero.tilt - 6 } : hero;
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

    if (p.exposed > 0) {
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
      updateBeats(st.visible, hourF, slr);
    } else {
      const exit = reduced() ? 0 : p.hero;
      pose = lerpPose(heroPose(time), timelineStart(), exit);
      const a = frameFor('hero');
      const b = frameFor('pinned');
      frame = { x: lerp(a.x, b.x, exit), y: lerp(a.y, b.y, exit) };
      hourF = lerp(story.heroIndex, 0, exit);
    }
    if (p.exposed <= 0) hideAnnotation();
    // after a loop the story is already back at the start; the camera glides there
    if (glide) {
      const t = clamp01((time - glide.start) / GLIDE_MS);
      pose = lerpPose(glide.from, pose, t, { arc: 0.25 });
      if (t >= 1) glide = null;
    }
    lastPose = pose;

    if (mode === 'stage') {
      stage.instant = reduced();
      stage.setFrame(Math.round(frame.x), Math.round(frame.y));
      stage.setPose(pose);
      if (p.exposed > 0) {
        applyRisk();
        placeAnnotation(p.exposed);
      } else applyData(hourF, slr);
      $('stage').style.opacity = String(reduced() ? 1 : Math.min(1, (time - attachedAt) / 700));
      stage.render();
    } else if (mode === 'stills') {
      if (shot !== lastShot) showStill(shot);
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
    const bottom = mobile() ? H * 0.44 - 64 : H;
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

  // ---------------- position, steps and playback ----------------

  /** Where each step settles: one per beat of the timeline, then one per neighborhood stop. */
  const steps = () => (story ? storySteps(story) : [0]);

  const chapter = () => (pos > 1 ? 'exposed' : 'timeline');

  function seek(v, { stop = true } = {}) {
    if (stop) playing = false;
    pos = Math.max(0, Math.min(2, v));
    target.hero = 1;
    target.timeline = Math.min(1, pos);
    target.exposed = Math.max(0, pos - 1);
    onPosition?.({ pos, chapter: chapter(), playing, step: currentStep(), steps: steps().length });
  }

  function currentStep() {
    const list = steps();
    let i = 0;
    list.forEach((p, k) => {
      if (pos >= p - 0.0005) i = k;
    });
    return i;
  }

  function go(dir) {
    const list = steps();
    const i = currentStep();
    const atStep = Math.abs(list[i] - pos) < 0.001;
    const next = dir > 0 ? (pos < list[0] - 0.0005 ? 0 : i + 1) : atStep ? i - 1 : i;
    seek(list[Math.max(0, Math.min(list.length - 1, next))]);
  }

  // Play moves continuously (stories.js playStep): quick between beats, slow through
  // each beat so it can be read, steady through the neighborhoods, then back to the
  // start, forever, until the reader pauses, drags, steps or closes. With reduced
  // motion it moves one step every few seconds instead, and loops the same way.
  const STOP_MS = 3500;
  function advance(time) {
    const dt = Math.min(100, time - lastTime);
    if (reduced()) {
      if (time < nextStepAt) return;
      nextStepAt = time + STOP_MS;
      const list = steps();
      const i = currentStep();
      const atEnd = i >= list.length - 1 && pos >= list[list.length - 1] - 0.001;
      seek(atEnd ? list[0] : list[pos < list[0] ? 0 : i + 1], { stop: false });
      return;
    }
    const next = playStep(story, pos, dt);
    if (next.looped) restart(time);
    else seek(next.pos, { stop: false });
  }

  /** Loop: the story jumps back to its first hour while the camera glides home from the last neighborhood. */
  function restart(time) {
    if (mode === 'stage' && lastPose) glide = { from: lastPose, start: time };
    seek(0, { stop: false });
    for (const key of Object.keys(target)) shown[key] = target[key];
    lastBeat = -2;
    lastStep = -2;
  }

  function setPlaying(on) {
    playing = on;
    nextStepAt = 0;
    onPosition?.({ pos, chapter: chapter(), playing, step: currentStep(), steps: steps().length });
  }

  function loop(time) {
    if (!running) return;
    if (playing) advance(time);
    lastTime = time;
    // ease the displayed position toward the target: quick, but never a jump cut
    const k = reduced() ? 1 : 0.16;
    for (const key of Object.keys(target)) {
      const d = target[key] - shown[key];
      shown[key] = Math.abs(d) < 0.0005 ? target[key] : shown[key] + d * k;
    }
    if (story) update(time);
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

  /** Floods: each neighborhood's land elevations, sorted once, for "how much is under water" (terrain.js). */
  let floodIndex = null;

  async function prepareStage() {
    await stage.setHazard(story.hazard);
    const features = await stage.loadNtas().then(() => stage.ntaFeatures);
    riskNta = new Float32Array(features.map((f) => (f.properties.areas.length ? Math.max(...f.properties.areas.map((id) => story.riskByArea[id])) : NaN)));
    blend = story.city.fromTerrain ? null : ntaBlender(features, story);
    if (story.city.fromTerrain && !floodIndex) {
      const grid = await loadTerrain();
      floodIndex = grid ? ntaElevationIndex(grid, features.length) : null;
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
    if (running) seek(steps()[0]);
    return story;
  }

  function setTheme(t) {
    currentTheme = t;
    if (stage) stage.setTheme(t);
    lastShot = null;
  }

  /** Show the story from the top: the camera flies in from the wide hero shot. */
  function open({ autoplay = !reduced() } = {}) {
    for (const key of Object.keys(shown)) shown[key] = 0;
    glide = null;
    lastShot = null;
    lastBeat = -2;
    lastStep = -2;
    if (story) drawStrip();
    seek(steps()[0]);
    if (autoplay) setPlaying(true);
    if (!running) {
      running = true;
      lastTime = performance.now();
      requestAnimationFrame(loop);
    }
  }

  function close() {
    running = false;
    playing = false;
    glide = null;
    hideAnnotation();
  }

  window.addEventListener('resize', () => {
    if (story && running) drawStrip();
  });

  return {
    setHazard,
    setTheme,
    attachStage,
    useStills,
    open,
    close,
    seek,
    next: () => go(1),
    prev: () => go(-1),
    togglePlay: () => setPlaying(!playing),
    get position() {
      return pos;
    },
    get stepPositions() {
      return steps();
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
