// The 3D story's pure parts: projection, sun, camera paths and the
// data-driven story copy. Run with:  node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centroid, idw, inGeometry, kmBetween, project, unproject } from '../js/story/geo.js';
import { daylight, nyLocalToUtc, solarPosition } from '../js/story/sun.js';
import { lerpPose, poseAt, poseToCamera, stepAt, stepPath, turn } from '../js/story/camera.js';
import { beatAt, buildStory, heatHazardSmooth, ntaBlender, playClock, playRate, playStep, SLR_SHARE, storySteps, storyTime, STORIES, waterNavdMeters } from '../js/story/stories.js';
import { extract, parseCsv } from '../scripts/import-heat-drivers.mjs';
import { AREAS } from '../js/config.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

test('projection is in kilometres and round-trips', () => {
  const [x, y] = project(-73.94, 40.7);
  close(x, 0, 1e-9);
  close(y, 0, 1e-9);
  // Battery to Central Park North is about 13.5 km
  close(kmBetween(-74.0142, 40.7006, -73.9524, 40.7968), 12.0, 1.5, 'Battery → 110th St');
  const [lon, lat] = unproject(...project(-74.1, 40.6));
  close(lon, -74.1, 1e-9);
  close(lat, 40.6, 1e-9);
});

test('point-in-polygon honors holes, and centroids land inside squares', () => {
  const square = { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]] };
  assert.equal(inGeometry(3, 3, square), true);
  assert.equal(inGeometry(1.5, 1.5, square), false, 'inside the hole');
  assert.equal(inGeometry(5, 5, square), false);
  const [cx, cy] = centroid({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] });
  close(cx, 1, 1e-9);
  close(cy, 1, 1e-9);
});

test('inverse-distance weighting stays between its inputs', () => {
  const pts = [
    { lon: -74, lat: 40.7, value: 80 },
    { lon: -73.9, lat: 40.7, value: 100 },
  ];
  const mid = idw(-73.95, 40.7, pts);
  close(mid, 90, 0.5);
  assert.equal(idw(-74, 40.7, pts), 80, 'on top of a point → that value');
});

test('the sun over New York on July 20, 2019', () => {
  const noon = solarPosition(nyLocalToUtc('2019-07-20T13:00'));
  close(noon.elevation, 70, 1.5, 'solar noon elevation');
  close(noon.azimuth, 180, 12, 'due south-ish');
  assert.ok(solarPosition(nyLocalToUtc('2019-07-20T05:00')).elevation < 0, 'before sunrise');
  assert.ok(solarPosition(nyLocalToUtc('2019-07-20T21:00')).elevation < 0, 'after sunset');
  const evening = solarPosition(nyLocalToUtc('2019-07-20T19:00'));
  assert.ok(evening.azimuth > 270 && evening.azimuth < 310, 'setting in the west-northwest');
  assert.equal(daylight(-10), 0);
  assert.equal(daylight(30), 1);
});

test('New York local times convert across daylight saving', () => {
  assert.equal(new Date(nyLocalToUtc('2019-07-20T16:00')).toISOString(), '2019-07-20T20:00:00.000Z');
  assert.equal(new Date(nyLocalToUtc('2012-12-01T12:00')).toISOString(), '2012-12-01T17:00:00.000Z');
});

test('camera poses: facing north puts the camera south of the target', () => {
  const { target, position } = poseToCamera({ lon: -73.94, lat: 40.7, dist: 10, bearing: 0, tilt: 45 });
  close(target[0], 0, 1e-9);
  assert.ok(position[2] > target[2], 'camera is south (+z) of the target');
  close(position[1], 10 * Math.cos(Math.PI / 4), 1e-9, 'height');
  assert.equal(turn(350, 10), 20);
  assert.equal(turn(10, 350), -20);
});

test('camera paths interpolate, arc and hold', () => {
  const a = { lon: -74, lat: 40.7, dist: 30, bearing: 350, tilt: 50 };
  const b = { lon: -73.9, lat: 40.8, dist: 5, bearing: 20, tilt: 55 };
  assert.deepEqual(lerpPose(a, b, 0), a);
  const end = lerpPose(a, b, 1);
  close(end.dist, 5, 1e-9);
  close(end.bearing, 20, 1e-9);
  const mid = lerpPose(a, b, 0.5, { arc: 0.6 });
  assert.ok(mid.dist > Math.sqrt(30 * 5), 'pulls back mid-flight');
  assert.ok(mid.bearing > 350 || mid.bearing < 20, 'turns the short way');

  const path = stepPath([a, b], { start: b });
  const held = poseAt(path, 0.45);
  close(held.lon, a.lon, 1e-9, 'step 1 holds after its flight');
  assert.deepEqual(stepAt(0.75, 2), { index: 1, local: 0.5 });

  // with drift the camera keeps moving while it stays on a neighborhood, at a steady pace
  const drifting = stepPath([a, b], { start: b, drift: { bearing: 12, zoom: 0.9 } });
  const p0 = poseAt(drifting, 0.25);
  const p1 = poseAt(drifting, 0.375);
  const p2 = poseAt(drifting, 0.5);
  close(p0.lon, a.lon, 1e-9, 'still over the same neighborhood');
  close(turn(p0.bearing, p1.bearing), turn(p1.bearing, p2.bearing), 1e-6, 'drifts at a steady rate');
  assert.ok(turn(p0.bearing, p2.bearing) > 5, 'and actually moves');
});

test('every story builds, and its copy is computed from the replay', () => {
  for (const hazard of Object.keys(STORIES)) {
    const s = buildStory(hazard);
    assert.equal(s.time.length, s.window.hours, hazard);
    assert.ok(s.beats.every((b) => b.index >= 0 && b.text.length > 20 && !b.text.includes('..')), `${hazard} beats`);
    assert.equal(s.stops.length, 3);
    assert.ok(s.stops.every((e) => ['low', 'elevated', 'high', 'severe'].includes(e.level) && e.drivers.length >= 2));
  }
  const heat = buildStory('heat');
  assert.equal(heat.mega, 106);
  assert.match(heat.headline, /never dropped below 80/);
  assert.ok(heat.beats.some((b) => /coolest hour/.test(b.text)));
  const floods = buildStory('floods');
  close(floods.peak.value, 9, 0.2, 'Sandy peaks near 9 ft above MHHW');
  close(waterNavdMeters(floods.peak.value), 3.44, 0.1, 'about 11.3 ft NAVD88 at the Battery');
});

test('story times read like a newspaper', () => {
  assert.equal(storyTime('2019-07-19T15:00'), 'Friday, 3 p.m.');
  assert.equal(storyTime('2019-07-20T12:00'), 'Saturday, noon');
  assert.equal(storyTime('2019-07-19T23:00', { day: false }), '11 p.m.');
});

test('the neighborhood blender spreads 39 points over every NTA', () => {
  const ntas = [
    { properties: { cx: -73.9389, cy: 40.7957 } }, // on East Harlem's point
    { properties: { cx: -73.86, cy: 40.6 } },
  ];
  const story = buildStory('heat');
  const at = ntaBlender(ntas, story, { values: story.values });
  const k = story.peak.index;
  const eh = story.values[AREAS.findIndex((a) => a.id === 'east-harlem')][k];
  close(at(k)[0], eh, 1e-3, 'an NTA on a modeled point takes its value');
  assert.ok(at(k)[1] > 70 && at(k)[1] < 110);
});

test('heat-driver importer reads portal-style CSVs', () => {
  const rows = parseCsv('Geography,GeoID,"Tree canopy (%)"\n"East Harlem North",MN34,9.5\n"Mott Haven-Port Morris",BX39,"11.2"\n');
  const ntas = { 'east-harlem': { code: 'MN34', name: 'East Harlem North' }, 'mott-haven': { code: 'BX39', name: 'Mott Haven-Port Morris' } };
  const { values, valCol } = extract(rows, ntas);
  assert.equal(valCol, 'Tree canopy (%)');
  assert.deepEqual(values, { 'east-harlem': 9.5, 'mott-haven': 11.2 });
});

test('the 3D ramps match the CSS ramps, light and dark', async () => {
  const { readFile } = await import('node:fs/promises');
  const { RAMPS } = await import('../js/story/palette.js');
  const css = await readFile(new URL('../css/style.css', import.meta.url), 'utf8');
  for (const [hazard, { light, dark }] of Object.entries(RAMPS)) {
    const lightRule = css.match(new RegExp(`^\\[data-hazard='${hazard}'\\] \\{([^}]*)\\}`, 'm'))[1];
    const darkRule = css.match(new RegExp(`:root\\[data-theme='dark'\\] \\[data-hazard='${hazard}'\\] \\{([^}]*)\\}`))[1];
    const stops = (rule) => [0, 1, 2, 3, 4].map((i) => rule.match(new RegExp(`--r${i}: (#[0-9a-f]{6})`))[1]);
    assert.deepEqual(stops(lightRule), light, `${hazard} light`);
    assert.deepEqual(stops(darkRule), dark, `${hazard} dark`);
  }
});

test('risk ramps: Low is a quiet near-neutral, color starts at Elevated, and both themes run the same way', async () => {
  const { RAMPS } = await import('../js/story/palette.js');
  // sRGB hex → OKLCH lightness, chroma and hue
  const oklch = (hex) => {
    const lin = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const [l, m, s] = [
      0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2],
      0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2],
      0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2],
    ].map(Math.cbrt);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
  };
  const SURFACE = { light: oklch('#f6f3ec').L, dark: oklch('#0f0f0e').L };
  for (const [hazard, themes] of Object.entries(RAMPS)) {
    for (const [theme, stops] of Object.entries(themes)) {
      const [, low, elevated, high, severe] = stops.map(oklch);
      assert.ok(low.C < 0.03, `${hazard} ${theme}: Low should be near-neutral (chroma ${low.C.toFixed(3)})`);
      for (const s of [elevated, high, severe]) assert.ok(s.C > 0.07, `${hazard} ${theme}: Elevated and above carry the color`);
      // every step moves further from the page than the one before: quiet → loud in both themes
      const away = [low, elevated, high, severe].map((s) => Math.abs(s.L - SURFACE[theme]));
      away.slice(1).forEach((d, i) => assert.ok(d > away[i] + 0.05, `${hazard} ${theme}: steps must get louder`));
    }
    // the same hue means the same level in both themes
    const hueGap = Math.abs(oklch(themes.light[4]).h - oklch(themes.dark[4]).h);
    assert.ok(Math.min(hueGap, 360 - hueGap) < 20, `${hazard}: Severe has the same hue in light and dark`);
  }
});

test('beat text never repeats or contradicts the clock above it', () => {
  const timeLead = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|midnight|noon|\d{1,2} [ap]\.m\.)/i;
  for (const hazard of Object.keys(STORIES)) {
    const s = buildStory(hazard);
    for (const b of s.beats) assert.doesNotMatch(b.text, timeLead, `${hazard}: "${b.text}" starts with a time`);
    // the first beat adds something: it doesn't restate the readout's number for that hour
    const first = s.beats[0];
    const v = s.citywide[first.index];
    const shown = hazard === 'floods' ? v.toFixed(1) : String(Math.round(v));
    assert.ok(!first.text.includes(shown), `${hazard}: first beat repeats the readout (${shown})`);
  }
});

test('a beat fades once the clock is more than an hour past it', () => {
  const s = buildStory('heat');
  const [b0, b1] = s.beats;
  assert.equal(beatAt(s, b0.index - 0.6), -1, 'nothing while the clock shows the hour before');
  assert.equal(beatAt(s, b0.index - 0.4), 0, 'on as soon as the clock shows its hour');
  assert.equal(beatAt(s, b0.index + 1), 0, 'still on an hour later');
  assert.equal(beatAt(s, b0.index + 1.6), -1, 'gone once the clock is two hours past');
  assert.equal(beatAt(s, b1.index + 0.2), 1);
  const f = buildStory('floods');
  const slrBeat = f.beats.findIndex((b) => b.slr);
  assert.equal(beatAt(f, f.peak.index, 0.5), slrBeat, 'the sea level beat shows while the sea rises');
});

test('the 3D city shows differences between neighborhoods, not one uniform slab', () => {
  const at = (s, id) => s.city.values[AREAS.findIndex((a) => a.id === id)][s.peak.index];
  const spread = (s, k) => {
    const col = s.city.values.map((row) => row[k]);
    return Math.max(...col) - Math.min(...col);
  };
  // heat: the same weather is more dangerous where vulnerability is higher
  const heat = buildStory('heat');
  assert.ok(at(heat, 'east-harlem') - at(heat, 'park-slope') > 0.3, 'East Harlem (HVI 5) stands well above Park Slope (HVI 1)');
  assert.equal(heatHazardSmooth(80), 1);
  assert.equal(heatHazardSmooth(102.5), 3.5);
  assert.equal(heatHazardSmooth(110), 4);
  // wind: exposed shorelines stand out at the peak
  const wind = buildStory('wind');
  assert.ok(at(wind, 'rockaway') > 0.9 && at(wind, 'fordham') < 0.25);
  for (const s of [heat, wind, buildStory('air')]) {
    assert.ok(spread(s, s.peak.index) > 0.4, `${s.hazard}: neighborhoods differ visibly at the peak`);
    assert.ok(s.city.values.flat().every((v) => v >= 0 && v <= 1));
    assert.match(s.city.legend.text, /Height and color/);
  }
  // floods: blocks like the others, from the share of each neighborhood's land under water (computed from elevation)
  const floods = buildStory('floods');
  assert.equal(floods.city.fromTerrain, true);
  assert.deepEqual(floods.city.domain, [0, 0.5]);
  assert.match(floods.city.legend.text, /land is under water/);
});

test('Play never stops: it slows through each beat, moves smoothly and loops', () => {
  for (const hazard of Object.keys(STORIES)) {
    const s = buildStory(hazard);
    // speed is always positive and has no jumps
    let prev = playRate(s, 0);
    for (let p = 0; p < 2; p += 0.0005) {
      const r = playRate(s, p);
      assert.ok(r > 0, `${hazard}: moving at ${p.toFixed(4)}`);
      if (Math.abs(p - 1) > 0.001) assert.ok(Math.abs(r - prev) < 0.01, `${hazard}: no sudden change in speed at ${p.toFixed(4)}`);
      prev = r;
    }
    // slower where a beat is on screen than between beats
    const steps = storySteps(s);
    const timelineBeats = s.beats.map((b, i) => ({ b, at: steps[i] })).filter(({ b }) => !b.slr);
    for (const { at } of timelineBeats) assert.ok(playRate(s, at) < playRate(s, 0) / 2, `${hazard}: slows for the beat at ${at.toFixed(3)}`);
    // a beat stays on screen for a few seconds of continuous play
    for (const { b } of timelineBeats) {
      let pos = 0;
      let shownMs = 0;
      for (let t = 0; t < 120000 && pos < 1; t += 16) {
        const hourF = hazard === 'floods' ? Math.min(1, pos / (1 - SLR_SHARE)) * s.peak.index : pos * (s.time.length - 1);
        if (beatAt(s, hourF) === s.beats.indexOf(b)) shownMs += 16;
        pos = playStep(s, pos, 16).pos;
      }
      assert.ok(shownMs > 2000, `${hazard}: beat "${b.text.slice(0, 30)}…" readable for ${shownMs} ms`);
    }
    // one loop in a sensible time, then back to the start
    let pos = 0;
    let ms = 0;
    let looped = false;
    while (!looped && ms < 120000) {
      ({ pos, looped } = playStep(s, pos, 16));
      ms += 16;
    }
    assert.ok(looped && pos === 0, `${hazard}: loops back to the start`);
    assert.ok(ms > 20000 && ms < 60000, `${hazard}: one loop takes ${(ms / 1000).toFixed(1)} s`);
  }
});

test('the player bar moves at one steady speed through Play, and maps back to the story', () => {
  for (const hazard of Object.keys(STORIES)) {
    const s = buildStory(hazard);
    const clock = playClock(s);
    assert.equal(clock.toBar(0), 0);
    assert.ok(Math.abs(clock.toBar(2) - 1) < 1e-9, `${hazard}: ends full`);
    // during Play, every second moves the bar the same distance, beats included
    const perSecond = 1 / clock.seconds;
    let pos = 0;
    let bar = 0;
    for (let t = 0; t < 120000; t += 16) {
      const next = playStep(s, pos, 16);
      if (next.looped) break;
      const b = clock.toBar(next.pos);
      const speed = (b - bar) / 0.016;
      assert.ok(Math.abs(speed - perSecond) < perSecond * 0.01, `${hazard}: bar speed ${speed.toFixed(4)}/s at ${next.pos.toFixed(3)}`);
      pos = next.pos;
      bar = b;
    }
    // dragging the bar lands on the matching story position
    for (let p = 0; p <= 2; p += 0.01) assert.ok(Math.abs(clock.toPos(clock.toBar(p)) - p) < 1e-6, `${hazard}: round trip at ${p.toFixed(2)}`);
  }
});

test('story steps: one per beat, then one per neighborhood', () => {
  const s = buildStory('heat');
  const steps = storySteps(s);
  assert.equal(steps.length, s.beats.length + s.stops.length);
  assert.ok(steps.every((p, i) => i === 0 || p > steps[i - 1]), 'in order');
  assert.ok(steps.slice(s.beats.length).every((p) => p > 1 && p < 2), 'stops in "who\'s exposed"');
});
