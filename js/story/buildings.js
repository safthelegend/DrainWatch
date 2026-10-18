// Real buildings for the flood story: footprints and roof heights from NYC's
// Building Footprints dataset, baked by scripts/bake-buildings.mjs into
// data/nyc-buildings.dwb. Pure functions only, shared by the bake script, the
// 3D stage and the tests.
//
// File format (little-endian, the whole file gzipped):
//   header   'DWB1' · u32 building count
//   building u16 roof height above ground (dm) · i16 ground elevation (dm, NAVD88)
//            u8 n vertices · u16 x0, u16 y0 · (n − 1) × (i16 dx, i16 dy)
//            u8 t triangles · t × 3 u8 vertex indices (the roof)
// x and y are quantized to 0…65535 across ELEVATION.bbox (about 0.8 m steps).

import { ELEVATION } from './elevation.js';
import { project } from './geo.js';

export const BUILDINGS = {
  url: 'data/nyc-buildings.dwb',
  bbox: ELEVATION.bbox,
  // Only the places the flood story looks at, so the file stays small.
  regions: [
    { id: 'manhattan', name: 'Manhattan below 59th Street', west: -74.022, south: 40.698, east: -73.955, north: 40.768 },
    { id: 'brooklyn-waterfront', name: 'Red Hook, Gowanus, Brooklyn Heights, DUMBO', west: -74.022, south: 40.665, east: -73.975, north: 40.706 },
    { id: 'lic', name: 'Long Island City', west: -73.965, south: 40.735, east: -73.935, north: 40.755 },
    { id: 'coney-island', name: 'Coney Island, Brighton Beach', west: -74.015, south: 40.567, east: -73.94, north: 40.588 },
    { id: 'rockaway', name: 'The Rockaways and Broad Channel', west: -73.945, south: 40.54, east: -73.74, north: 40.615 },
    { id: 'south-shore', name: 'Midland Beach, South Beach', west: -74.12, south: 40.555, east: -74.06, north: 40.6 },
  ],
};

const MAGIC = 'DWB1';
const Q = 65535;

// ---------------- quantizing ----------------

export function quantize(lon, lat, bbox = BUILDINGS.bbox) {
  const qx = Math.round(((lon - bbox.west) / (bbox.east - bbox.west)) * Q);
  const qy = Math.round(((lat - bbox.south) / (bbox.north - bbox.south)) * Q);
  return [Math.min(Q, Math.max(0, qx)), Math.min(Q, Math.max(0, qy))];
}

export function dequantize(qx, qy, bbox = BUILDINGS.bbox) {
  return [bbox.west + (qx / Q) * (bbox.east - bbox.west), bbox.south + (qy / Q) * (bbox.north - bbox.south)];
}

// ---------------- footprint geometry (in metres) ----------------

/** Footprint area in m² of a ring of [x, y] metres (positive = counter-clockwise). */
export function areaM2(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a / 2;
}

/** Douglas–Peucker on a closed ring (no repeated last point). */
export function simplifyRing(pts, tolerance) {
  if (pts.length <= 4) return pts;
  // split the ring at its two farthest-apart points so both halves are open polylines
  let far = 0;
  let best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = dp(pts.slice(0, far + 1), tolerance);
  const b = dp([...pts.slice(far), pts[0]], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function dp(line, tol) {
  if (line.length < 3) return line;
  const [ax, ay] = line[0];
  const [bx, by] = line[line.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1e-9;
  let index = 0;
  let max = 0;
  for (let i = 1; i < line.length - 1; i++) {
    const d = Math.abs((bx - ax) * (ay - line[i][1]) - (ax - line[i][0]) * (by - ay)) / len;
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= tol) return [line[0], line[line.length - 1]];
  return [...dp(line.slice(0, index + 1), tol).slice(0, -1), ...dp(line.slice(index), tol)];
}

/**
 * Ear-clipping triangulation of a simple counter-clockwise ring.
 * Returns flat vertex indices; falls back to a fan if the ring is self-intersecting.
 */
export function triangulate(pts) {
  const n = pts.length;
  if (n < 3) return [];
  const idx = [...pts.keys()];
  const out = [];
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length];
      const i1 = idx[k];
      const i2 = idx[(k + 1) % idx.length];
      const [a, b, c] = [pts[i0], pts[i1], pts[i2]];
      if (cross(a, b, c) <= 0) continue; // reflex or flat corner
      if (idx.some((j) => j !== i0 && j !== i1 && j !== i2 && inside(pts[j], a, b, c))) continue;
      out.push(i0, i1, i2);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // a degenerate ring: fan out what is left rather than lose the roof
      for (let k = 1; k < idx.length - 1; k++) out.push(idx[0], idx[k], idx[k + 1]);
      return out;
    }
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/** lon/lat ring → metres around its first point (good to a few cm at city scale). */
export function toMetres(ring) {
  return ring.map(([lon, lat]) => {
    const [x, y] = project(lon, lat);
    return [x * 1000, y * 1000];
  });
}

// ---------------- encode / decode ----------------

/**
 * buildings: [{ ring: [[lon, lat], ...] counter-clockwise, no repeated last point,
 *               height: metres above ground, ground: metres NAVD88, triangles: flat indices }]
 */
export function encodeBuildings(buildings, bbox = BUILDINGS.bbox) {
  let size = 8;
  for (const b of buildings) size += 5 + 4 * b.ring.length + 1 + b.triangles.length;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  for (let i = 0; i < 4; i++) v.setUint8(i, MAGIC.charCodeAt(i));
  v.setUint32(4, buildings.length, true);
  let o = 8;
  for (const b of buildings) {
    v.setUint16(o, Math.min(65535, Math.max(1, Math.round(b.height * 10))), true);
    v.setInt16(o + 2, Math.min(32767, Math.max(-32768, Math.round(b.ground * 10))), true);
    v.setUint8(o + 4, b.ring.length);
    o += 5;
    let px = 0;
    let py = 0;
    b.ring.forEach(([lon, lat], i) => {
      const [qx, qy] = quantize(lon, lat, bbox);
      if (i === 0) {
        v.setUint16(o, qx, true);
        v.setUint16(o + 2, qy, true);
      } else {
        v.setInt16(o, qx - px, true);
        v.setInt16(o + 2, qy - py, true);
      }
      px = qx;
      py = qy;
      o += 4;
    });
    v.setUint8(o++, b.triangles.length / 3);
    for (const t of b.triangles) v.setUint8(o++, t);
  }
  return new Uint8Array(buf);
}

/** Decodes an (already un-gzipped) file into [{ ring: [[lon, lat]], height, ground, triangles }]. */
export function decodeBuildings(bytes, bbox = BUILDINGS.bbox) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== MAGIC) throw new Error(`not a DrainWatch buildings file (${magic})`);
  const count = v.getUint32(4, true);
  const out = new Array(count);
  let o = 8;
  for (let k = 0; k < count; k++) {
    const height = v.getUint16(o, true) / 10;
    const ground = v.getInt16(o + 2, true) / 10;
    const n = v.getUint8(o + 4);
    o += 5;
    const ring = new Array(n);
    let qx = 0;
    let qy = 0;
    for (let i = 0; i < n; i++) {
      if (i === 0) {
        qx = v.getUint16(o, true);
        qy = v.getUint16(o + 2, true);
      } else {
        qx += v.getInt16(o, true);
        qy += v.getInt16(o + 2, true);
      }
      ring[i] = dequantize(qx, qy, bbox);
      o += 4;
    }
    const t = v.getUint8(o++);
    const triangles = Array.from(u8.subarray(o, o + t * 3));
    o += t * 3;
    out[k] = { ring, height, ground, triangles };
  }
  return out;
}

// ---------------- mesh arrays ----------------

/**
 * Typed arrays for one merged mesh: flat-shaded walls plus the roof, in the
 * stage's coordinates (x east, y up, z south; km). `groundScale` is km per
 * metre of ground elevation (the terrain's exaggeration), `heightScale` km per
 * metre of building height (less, so towers don't turn into needles); `sink`
 * (km) pushes the base below the terrain so no building floats. Per vertex:
 * `ground` (m NAVD88) and `above` (m above ground), so the shader can draw the
 * waterline on the walls.
 */
export function buildingArrays(buildings, { groundScale, heightScale = groundScale, sink = 0.02 }) {
  let verts = 0;
  let tris = 0;
  for (const b of buildings) {
    verts += b.ring.length * 4 + b.ring.length;
    tris += b.ring.length * 2 + b.triangles.length / 3;
  }
  const position = new Float32Array(verts * 3);
  const normal = new Float32Array(verts * 3);
  const ground = new Float32Array(verts);
  const above = new Float32Array(verts);
  const index = new Uint32Array(tris * 3);
  let vi = 0;
  let ii = 0;
  const put = (x, y, z, nx, ny, nz, g, h) => {
    position[vi * 3] = x;
    position[vi * 3 + 1] = y;
    position[vi * 3 + 2] = z;
    normal[vi * 3] = nx;
    normal[vi * 3 + 1] = ny;
    normal[vi * 3 + 2] = nz;
    ground[vi] = g;
    above[vi] = h;
    return vi++;
  };
  for (const b of buildings) {
    const pts = b.ring.map(([lon, lat]) => project(lon, lat));
    const base = b.ground * groundScale - sink;
    const top = b.ground * groundScale + b.height * heightScale;
    const below = -sink / heightScale; // the sunk base, in metres "above" ground, so 0 lands at ground level
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % n];
      // outward normal of a counter-clockwise ring, in stage x/z (z = −y)
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const nx = (y2 - y1) / len;
      const nz = (x2 - x1) / len;
      const a = put(x1, base, -y1, nx, 0, nz, b.ground, below);
      const c = put(x2, base, -y2, nx, 0, nz, b.ground, below);
      const d = put(x2, top, -y2, nx, 0, nz, b.ground, b.height);
      const e = put(x1, top, -y1, nx, 0, nz, b.ground, b.height);
      index.set([a, c, d, a, d, e], ii);
      ii += 6;
    }
    const first = vi;
    for (const [x, y] of pts) put(x, top, -y, 0, 1, 0, b.ground, b.height);
    // (x, y) → (x, −z) keeps a counter-clockwise ring counter-clockwise seen from above
    for (const t of b.triangles) index[ii++] = first + t;
  }
  return { position, normal, ground, above, index };
}

/** Un-gzips a fetched file in the browser (or passes raw bytes through). */
export async function inflate(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return u8; // the server already decoded it
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
