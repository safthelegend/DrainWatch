// The real-buildings layer: footprint simplification, roof triangulation, the
// binary file format and the mesh arrays the 3D stage draws.
// Run with:  node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { areaM2, BUILDINGS, buildingArrays, decodeBuildings, encodeBuildings, inflate, quantize, dequantize, simplifyRing, toMetres, triangulate } from '../js/story/buildings.js';
import { ELEVATION } from '../js/story/elevation.js';
import { inRing, project } from '../js/story/geo.js';

// an L-shaped (concave) footprint, counter-clockwise, in metres
const L = [
  [0, 0],
  [30, 0],
  [30, 10],
  [10, 10],
  [10, 30],
  [0, 30],
];

const triArea = (pts, t) => {
  let total = 0;
  for (let i = 0; i < t.length; i += 3) total += areaM2([pts[t[i]], pts[t[i + 1]], pts[t[i + 2]]]);
  return total;
};

test('area is positive for a counter-clockwise ring', () => {
  assert.equal(areaM2(L), 500);
  assert.equal(areaM2([...L].reverse()), -500);
});

test('triangulating a concave footprint covers it exactly, every triangle counter-clockwise', () => {
  const t = triangulate(L);
  assert.equal(t.length, (L.length - 2) * 3);
  for (let i = 0; i < t.length; i += 3) assert.ok(areaM2([L[t[i]], L[t[i + 1]], L[t[i + 2]]]) > 0);
  assert.equal(triArea(L, t), 500);
});

test('simplifying drops points on straight walls and keeps the corners', () => {
  const noisy = [[0, 0], [10, 0.2], [20, -0.1], [30, 0], [30, 10], [10, 10], [10, 30], [5, 30.3], [0, 30]];
  const s = simplifyRing(noisy, 1.5);
  assert.equal(s.length, 6);
  assert.ok(Math.abs(areaM2(s) - 500) < 5);
});

test('quantizing is good to about a metre', () => {
  const [lon, lat] = [-74.0113, 40.7075];
  const [qx, qy] = quantize(lon, lat);
  const [lon2, lat2] = dequantize(qx, qy);
  const [x1, y1] = project(lon, lat);
  const [x2, y2] = project(lon2, lat2);
  assert.ok(Math.hypot(x2 - x1, y2 - y1) * 1000 < 0.6);
});

function sample() {
  // two buildings near the Battery: a tall concave tower and a small box
  const ring = (pts) => pts.map(([x, y]) => [-74.012 + x * 1e-5, 40.704 + y * 1e-5]);
  return [
    { ring: ring(L), height: 210.4, ground: 2.1, triangles: triangulate(L) },
    { ring: ring([[50, 0], [60, 0], [60, 10], [50, 10]]), height: 9, ground: -0.4, triangles: [0, 1, 2, 0, 2, 3] },
  ];
}

test('the file format round-trips heights, ground, footprints and roofs', () => {
  const input = sample();
  const out = decodeBuildings(encodeBuildings(input));
  assert.equal(out.length, 2);
  out.forEach((b, i) => {
    assert.equal(b.height, Math.round(input[i].height * 10) / 10);
    assert.equal(b.ground, Math.round(input[i].ground * 10) / 10);
    assert.deepEqual(b.triangles, input[i].triangles);
    b.ring.forEach(([lon, lat], k) => {
      assert.ok(Math.abs(lon - input[i].ring[k][0]) < 1e-5);
      assert.ok(Math.abs(lat - input[i].ring[k][1]) < 1e-5);
    });
  });
  assert.throws(() => decodeBuildings(new Uint8Array(8)), /not a DrainWatch buildings file/);
});

test('the browser side un-gzips the file, or takes it as is', async () => {
  const raw = encodeBuildings(sample());
  assert.deepEqual(await inflate(gzipSync(raw)), raw);
  assert.deepEqual(await inflate(raw.buffer), raw);
});

test('mesh arrays: walls face outward, roofs face up, waterline attributes per vertex', () => {
  const scale = 0.008;
  const heightScale = 0.003;
  const [tower] = sample();
  const a = buildingArrays([tower], { groundScale: scale, heightScale, sink: 0.02 });
  const n = tower.ring.length;
  assert.equal(a.position.length / 3, n * 5);
  assert.equal(a.index.length / 3, n * 2 + n - 2);
  const pts = tower.ring.map(([lon, lat]) => project(lon, lat));
  for (let w = 0; w < n; w++) {
    // a step along each wall's normal from its middle lands outside the footprint (stage z is −y)
    const v = w * 4;
    const mx = (a.position[v * 3] + a.position[(v + 1) * 3]) / 2;
    const my = -(a.position[v * 3 + 2] + a.position[(v + 1) * 3 + 2]) / 2;
    const step = 0.001; // 1 m
    assert.ok(!inRing(mx + a.normal[v * 3] * step, my - a.normal[v * 3 + 2] * step, pts), `wall ${w} faces inward`);
    assert.ok(inRing(mx - a.normal[v * 3] * step, my + a.normal[v * 3 + 2] * step, pts), `wall ${w} misplaced`);
    for (let k = 0; k < 4; k++) assert.equal(a.normal[(v + k) * 3 + 1], 0);
  }
  for (let v = n * 4; v < n * 5; v++) {
    assert.equal(a.normal[v * 3 + 1], 1);
    assert.ok(Math.abs(a.position[v * 3 + 1] - (2.1 * scale + 210.4 * heightScale)) < 1e-4);
    assert.equal(a.above[v], Math.fround(tower.height));
    assert.equal(a.ground[v], Math.fround(tower.ground));
  }
  // roof triangles wind counter-clockwise seen from above: their normals point up
  for (let t = n * 2 * 3; t < a.index.length; t += 3) {
    const [p, q, r] = [a.index[t], a.index[t + 1], a.index[t + 2]].map((i) => [a.position[i * 3], a.position[i * 3 + 1], a.position[i * 3 + 2]]);
    const u = [q[0] - p[0], q[2] - p[2]];
    const w = [r[0] - p[0], r[2] - p[2]];
    assert.ok(u[1] * w[0] - u[0] * w[1] > 0, 'roof triangle faces down');
  }
  // the base sits below the ground so no building floats over the terrain…
  assert.ok(Math.abs(a.position[1] - (2.1 * scale - 0.02)) < 1e-6);
  // …and "metres above ground" still reads 0 exactly where the wall meets the ground,
  // so the waterline on the walls is at the true flood depth
  const yGround = 2.1 * scale;
  const [yBase, yTop] = [a.position[1], a.position[3 * 3 + 1]];
  const aboveAtGround = a.above[0] + ((yGround - yBase) / (yTop - yBase)) * (a.above[3] - a.above[0]);
  assert.ok(Math.abs(aboveAtGround) < 1e-3);
});

test('every baked region is inside the heightmap, and footprints convert to metres', () => {
  const b = ELEVATION.bbox;
  for (const r of BUILDINGS.regions) {
    assert.ok(r.west >= b.west && r.east <= b.east && r.south >= b.south && r.north <= b.north, r.id);
    assert.ok(r.west < r.east && r.south < r.north, r.id);
  }
  const m = toMetres([[-74, 40.7], [-73.99, 40.7]]);
  assert.ok(Math.abs(m[1][0] - m[0][0] - 843) < 5); // 0.01° of longitude at 40.7° N ≈ 843 m
});
