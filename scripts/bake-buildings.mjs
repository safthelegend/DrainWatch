// Bakes data/nyc-buildings.dwb: real building footprints and roof heights for
// the places the flood story looks at (BUILDINGS.regions in js/story/buildings.js).
// Run once; the output is committed. The site works without it (the flood
// scene then shows bare terrain).
//
// Source: NYC Building Footprints, NYC Office of Technology and Innovation,
// via NYC Open Data (dataset 5zhs-2jue). Roof height and ground elevation are
// in feet (NAVD88); this script converts them to metres.
//
// To keep the file around 1–2 MB:
//   • skybridges, sheds and anything under 25 m² are dropped
//   • small low buildings (houses, rowhouses) are merged into one block per
//     40 m grid cell, sized to the share of the cell they cover
//   • larger footprints are simplified to about 1.5 m and lose their courtyards
//
// Usage:
//   node scripts/bake-buildings.mjs                     # downloads from NYC Open Data
//   node scripts/bake-buildings.mjs --file a.geojson    # or uses GeoJSON you exported (repeatable)
// Options: --small <m²> (default 250) · --cell <m> (default 40) · --token <NYC Open Data app token>
//          --out <path> (default data/nyc-buildings.dwb)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { BUILDINGS, areaM2, encodeBuildings, simplifyRing, toMetres, triangulate } from '../js/story/buildings.js';
import { project, unproject } from '../js/story/geo.js';

const DATASET = 'https://data.cityofnewyork.us/resource/5zhs-2jue.geojson';
const PAGE = 50000;
const FT = 0.3048;
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const files = args.flatMap((a, i) => (a === '--file' ? [args[i + 1]] : []));
const SMALL_M2 = Number(opt('--small', 250));
const CELL_M = Number(opt('--cell', 40));
const TOKEN = opt('--token', process.env.NYC_APP_TOKEN);
const OUT = opt('--out', null);

// NYC Planimetrics feature codes: 2110 skybridge (floats over the street), 1001 gas station canopy,
// 1002 storage tank, 1003 placeholder, 1005 temporary structure, 1006 cantilevered building
const SKIP_CODES = new Set(['2110', '1001', '1002', '1003', '1005', '1006']);

// ---------------- download ----------------

async function fetchRegion(r) {
  const features = [];
  for (let offset = 0; ; offset += PAGE) {
    const q = new URLSearchParams({
      $where: `within_box(the_geom, ${r.north}, ${r.west}, ${r.south}, ${r.east})`,
      $limit: String(PAGE),
      $offset: String(offset),
      $order: ':id',
    });
    const res = await fetch(`${DATASET}?${q}`, { headers: TOKEN ? { 'X-App-Token': TOKEN } : {} });
    if (!res.ok) throw new Error(`${r.id}: ${res.status} ${await res.text()}`);
    const page = (await res.json()).features || [];
    features.push(...page);
    console.log(`  ${r.id}: ${features.length} footprints`);
    if (page.length < PAGE) return features;
  }
}

const features = [];
if (files.length) {
  for (const f of files) features.push(...JSON.parse(await readFile(f, 'utf8')).features);
} else {
  for (const r of BUILDINGS.regions) features.push(...(await fetchRegion(r)));
}
console.log(`read ${features.length} footprints`);

// ---------------- clean up ----------------

const inRegion = (lon, lat) => BUILDINGS.regions.some((r) => lon >= r.west && lon <= r.east && lat >= r.south && lat <= r.north);
const num = (...vals) => {
  for (const v of vals) {
    const n = Number(v);
    if (v != null && v !== '' && Number.isFinite(n)) return n;
  }
  return NaN;
};

const seen = new Set();
const parts = []; // { pts: [[x m, y m, lon, lat]], area, height, ground }
let dropped = 0;
for (const f of features) {
  const p = f.properties || {};
  const g = f.geometry;
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
  const key = p.doitt_id || p.bin || JSON.stringify(g.coordinates).slice(0, 80);
  if (seen.has(key)) continue; // regions overlap
  seen.add(key);
  if (SKIP_CODES.has(String(p.feat_code ?? p.featcode ?? ''))) {
    dropped++;
    continue;
  }
  const heightFt = num(p.height_roof, p.heightroof);
  const groundFt = num(p.ground_elevation, p.groundelev);
  const height = Math.min(600, heightFt > 0 ? heightFt * FT : 6);
  const ground = Number.isFinite(groundFt) && groundFt > -50 ? groundFt * FT : 2;
  for (const rings of g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates]) {
    let ring = rings[0];
    if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring = ring.slice(0, -1);
    if (ring.length < 3) continue;
    const metres = toMetres(ring);
    let pts = metres.map(([x, y], i) => [x, y, ring[i][0], ring[i][1]]);
    let area = areaM2(pts);
    if (area < 0) {
      pts = pts.reverse();
      area = -area;
    }
    const [cx, cy] = pts.reduce((s, q) => [s[0] + q[2] / pts.length, s[1] + q[3] / pts.length], [0, 0]);
    if (area < 25 || !inRegion(cx, cy)) {
      dropped++;
      continue;
    }
    parts.push({ pts, area, height, ground });
  }
}

// ---------------- merge small buildings into grid blocks ----------------

const cells = new Map();
const buildings = [];
for (const b of parts) {
  if (b.area < SMALL_M2 && b.height < 20) {
    const cx = b.pts.reduce((s, q) => s + q[0], 0) / b.pts.length;
    const cy = b.pts.reduce((s, q) => s + q[1], 0) / b.pts.length;
    const key = `${Math.floor(cx / CELL_M)},${Math.floor(cy / CELL_M)}`;
    const c = cells.get(key) || { area: 0, x: 0, y: 0, h: 0, g: 0, col: Math.floor(cx / CELL_M), row: Math.floor(cy / CELL_M) };
    c.area += b.area;
    c.x += cx * b.area;
    c.y += cy * b.area;
    c.h += b.height * b.area;
    c.g += b.ground * b.area;
    cells.set(key, c);
    continue;
  }
  // larger buildings keep their shape, simplified until the ring fits the file format
  let tol = 1.5;
  let pts = simplifyRing(b.pts, tol);
  while (pts.length > 60 && tol < 50) pts = simplifyRing(b.pts, (tol *= 1.6));
  if (pts.length < 3 || pts.length > 250 || Math.abs(areaM2(pts)) < 10) {
    dropped++;
    continue;
  }
  if (areaM2(pts) < 0) pts.reverse();
  buildings.push({ ring: pts.map((q) => [q[2], q[3]]), height: b.height, ground: b.ground, triangles: triangulate(pts) });
}

// project() is metres × 1000 from geo.js's origin, so grid metres map straight back with unproject()
const toLonLat = (x, y) => unproject(x / 1000, y / 1000);
let blocks = 0;
for (const c of cells.values()) {
  if (c.area < CELL_M * CELL_M * 0.12) continue; // a lone shed in an empty cell
  const side = Math.min(CELL_M * 0.92, Math.sqrt(c.area));
  const half = side / 2;
  // keep the block inside its own cell so neighbours never overlap
  const x = Math.min((c.col + 1) * CELL_M - half, Math.max(c.col * CELL_M + half, c.x / c.area));
  const y = Math.min((c.row + 1) * CELL_M - half, Math.max(c.row * CELL_M + half, c.y / c.area));
  const ring = [toLonLat(x - half, y - half), toLonLat(x + half, y - half), toLonLat(x + half, y + half), toLonLat(x - half, y + half)];
  buildings.push({ ring, height: c.h / c.area, ground: c.g / c.area, triangles: [0, 1, 2, 0, 2, 3] });
  blocks++;
}

// sanity check: the grid maths and project() agree
const [ox, oy] = project(-74, 40.7);
const [bx, by] = unproject(ox, oy);
if (Math.abs(bx + 74) > 1e-9 || Math.abs(by - 40.7) > 1e-9) throw new Error('projection round trip failed');

const raw = encodeBuildings(buildings);
const gz = gzipSync(raw, { level: 9 });
if (OUT) await writeFile(OUT, gz);
else {
  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(new URL('../data/nyc-buildings.dwb', import.meta.url), gz);
}
const tallest = buildings.reduce((m, b) => Math.max(m, b.height), 0);
console.log(
  `wrote ${buildings.length} buildings (${buildings.length - blocks} footprints, ${blocks} merged blocks; ${dropped} dropped), ` +
    `${(gz.length / 1024 / 1024).toFixed(2)} MB gzipped (${(raw.length / 1024 / 1024).toFixed(2)} MB raw), tallest ${tallest.toFixed(0)} m`,
);
if (gz.length > 2.5 * 1024 * 1024) console.warn('over 2.5 MB: try --small 400 or --cell 50');
