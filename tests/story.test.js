// The 3D story's pure parts: projection, sun, camera paths and the
// data-driven story copy. Run with:  node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centroid, idw, inGeometry, kmBetween, project, unproject } from '../js/story/geo.js';
import { daylight, nyLocalToUtc, solarPosition } from '../js/story/sun.js';
import { lerpPose, poseAt, poseToCamera, stepAt, stepPath, turn } from '../js/story/camera.js';
import { buildStory, lead, ntaBlender, storyTime, STORIES, waterNavdMeters } from '../js/story/stories.js';
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
  assert.equal(lead('2019-07-19T23:00', { day: false }), '11 p.m.');
  assert.equal(lead('2020-08-04T12:00'), 'Tuesday, noon.');
});

test('the neighborhood blender spreads 39 points over every NTA', () => {
  const ntas = [
    { properties: { cx: -73.9389, cy: 40.7957 } }, // on East Harlem's point
    { properties: { cx: -73.86, cy: 40.6 } },
  ];
  const story = buildStory('heat');
  const at = ntaBlender(ntas, story);
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
