// The elevation helpers behind higher ground, Compare and the Time Machine's
// flooded-land layer, on a small synthetic heightmap.
// Run with:  node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compassWord, elevationAt, findHigherGround, floodByNta, floodRaster, floodStats, gridFromPixels, ntaElevation, ntaElevationIndex, ntaShareBelow, waterNavdMeters } from '../js/terrain.js';
import { seaLevelNote, seaLevelPeriod, seaLevelStopFor, SLR_MAX_INCHES } from '../js/scenarios.js';

const SIZE = 20;
const BBOX = { west: -74.1, east: -73.9, south: 40.6, north: 40.8 };

/**
 * A 20 × 20 grid: water in the westmost 4 columns, then land rising 1 m per
 * column eastward from 1 m. NTA 0 covers the north half, NTA 1 the south half.
 */
function grid() {
  const px = new Uint8Array(SIZE * SIZE * 3);
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const o = (row * SIZE + col) * 3;
      const land = col >= 4;
      const cm = ((land ? col - 3 : 0) + 100) * 100; // encoding: (R*256+G)/100 - 100
      px[o] = cm >> 8;
      px[o + 1] = cm & 255;
      px[o + 2] = land ? (row < SIZE / 2 ? 1 : 2) : 0;
    }
  }
  return gridFromPixels(px, SIZE, BBOX, 3);
}

const lonOfCol = (col) => BBOX.west + ((col + 0.5) / SIZE) * (BBOX.east - BBOX.west);
const latOfRow = (row) => BBOX.north - ((row + 0.5) / SIZE) * (BBOX.north - BBOX.south);

test('the heightmap decodes elevation and neighborhoods, and samples between cells', () => {
  const g = grid();
  assert.equal(g.nta[0], -1);
  assert.equal(g.elev[5], 2);
  assert.equal(g.nta[SIZE * 15 + 10], 1);
  const at = elevationAt(g, latOfRow(5), lonOfCol(10));
  assert.ok(Math.abs(at.m - 7) < 1e-6);
  assert.equal(at.nta, 0);
  assert.equal(elevationAt(g, latOfRow(5), lonOfCol(1)), null, 'open water has no ground');
  assert.equal(elevationAt(g, 41.5, -74), null, 'outside the map');
});

test('higher ground is the nearest solid land at least that high, east up the slope', () => {
  const g = grid();
  const h = findHigherGround(g, latOfRow(10), lonOfCol(5), { minM: 10 });
  assert.equal(h.m, 10);
  assert.equal(h.direction, 'east');
  assert.ok(h.km > 0 && h.km < 10);
  assert.equal(findHigherGround(g, latOfRow(10), lonOfCol(5), { minM: 50 }), null);
  assert.equal(compassWord(44), 'northeast');
  assert.equal(compassWord(359), 'north');
});

test('flooded land grows with the water and splits by neighborhood', () => {
  const g = grid();
  const s = floodStats(g, 3.5, 5.5); // columns 4–6 under at base, 7–8 added
  assert.ok(Math.abs(s.baseKm2 / g.cellKm2 - 3 * SIZE) < 1e-6);
  assert.ok(Math.abs(s.addedKm2 / g.cellKm2 - 2 * SIZE) < 1e-6);
  const by = floodByNta(g, 3.5, 5.5);
  assert.deepEqual([...by.base], [30, 30]);
  assert.deepEqual([...by.added], [20, 20]);
  assert.deepEqual([...by.total], [160, 160]);
  const e = ntaElevation(g, [0], 3.5);
  assert.equal(e.shareBelow, 30 / 160);
  assert.equal(ntaElevation(g, [7], 3.5), null);
});

test('the flood raster colors base and added land and spans the heightmap', () => {
  const g = grid();
  const r = floodRaster(g, 3.5, 5.5, { base: [1, 2, 3, 255], added: [9, 9, 9, 255] });
  assert.equal(r.data.length, SIZE * SIZE * 4);
  const px = (row, col) => [...r.data.slice((row * SIZE + col) * 4, (row * SIZE + col) * 4 + 4)];
  assert.deepEqual(px(10, 5), [1, 2, 3, 255]);
  assert.deepEqual(px(10, 8), [9, 9, 9, 255]);
  assert.deepEqual(px(10, 12), [0, 0, 0, 0]);
  assert.deepEqual(px(10, 1), [0, 0, 0, 0], 'water stays clear');
  assert.deepEqual(r.bounds, [
    [BBOX.south, BBOX.west],
    [BBOX.north, BBOX.east],
  ]);
});

test('water levels convert to the heightmap datum', () => {
  assert.ok(Math.abs(waterNavdMeters(0) - 0.68) < 1e-9);
  assert.ok(Math.abs(waterNavdMeters(9) - (0.68 + 9 * 0.3048)) < 1e-9);
});

test('sea level rise is described against the NPCC projections', () => {
  assert.equal(SLR_MAX_INCHES, 75);
  assert.equal(seaLevelStopFor(29).id, '2080s');
  assert.equal(seaLevelStopFor(30), null);
  assert.equal(seaLevelPeriod(25), '2080s');
  assert.equal(seaLevelPeriod(60), null);
  assert.match(seaLevelNote(29), /middle .* likely range for the 2080s/);
  assert.match(seaLevelNote(40), /likely range for 2100/);
  assert.match(seaLevelNote(70), /above every likely range/);
});

test('the share of each neighborhood under water matches a full count at any level', () => {
  const g = grid();
  const index = ntaElevationIndex(g, 3); // NTAs 0 and 1 have land; NTA 2 has none
  for (const level of [0.5, 3.5, 5.5, 20]) {
    const share = ntaShareBelow(index, level);
    const by = floodByNta(g, level, level);
    assert.ok(Math.abs(share[0] - by.base[0] / by.total[0]) < 1e-9, `NTA 0 at ${level} m`);
    assert.ok(Math.abs(share[1] - by.base[1] / by.total[1]) < 1e-9, `NTA 1 at ${level} m`);
    assert.ok(Number.isNaN(share[2]), 'a neighborhood with no land has no share');
  }
  assert.equal(ntaShareBelow(index, 0.5)[0], 0, 'dry below the lowest land');
  assert.equal(ntaShareBelow(index, 99)[0], 1, 'all under at a very high level');
});
