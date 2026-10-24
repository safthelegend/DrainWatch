// Ground elevation for the map, from the same heightmap the 3D flood story uses
// (data/nyc-elevation.png: USGS 3DEP via AWS Terrain Tiles, ~110 m cells,
// metres above NAVD88). It powers three things:
//   • the address check's "nearest higher ground"
//   • neighborhood elevation in Compare
//   • the Climate Time Machine's flooded-land layer and its sea level rise delta
//
// Flooding here is a "bathtub" estimate: land below the water level is counted
// as flooded whether or not water can reach it. It shows scale, not a forecast.
// Everything except loadTerrain() is pure, so it runs in tests without a DOM.

import { ELEVATION, decodeElevation } from './story/elevation.js';
import { kmBetween } from './story/geo.js';
import { waterNavdMeters } from './story/stories.js';

export { waterNavdMeters };

export const FT_PER_M = 3.28084;
const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON_EQ = 111.32;
const RAD = Math.PI / 180;

/**
 * "Higher ground": at least 6 m (about 20 ft) above sea level. That is above
 * Sandy's storm tide at the Battery (about 3.4 m) plus the 2080s middle sea level
 * rise estimate (29 in, 0.74 m), with about 6 ft to spare.
 */
export const HIGHER_GROUND_M = 6;

/**
 * Decode the heightmap's RGBA pixels into a grid:
 *   elev[k] metres NAVD88, nta[k] = index into data/nyc-ntas.geojson, or -1 for water / outside the city.
 */
export function gridFromPixels(px, size = ELEVATION.size, bbox = ELEVATION.bbox, channels = 4) {
  const elev = new Float32Array(size * size);
  const nta = new Int16Array(size * size);
  for (let k = 0; k < size * size; k++) {
    const o = k * channels;
    elev[k] = decodeElevation(px[o], px[o + 1]);
    nta[k] = px[o + 2] > 0 ? px[o + 2] - 1 : -1;
  }
  const midLat = (bbox.north + bbox.south) / 2;
  const cellKm2 = ((bbox.east - bbox.west) / size) * KM_PER_DEG_LON_EQ * Math.cos(midLat * RAD) * ((bbox.north - bbox.south) / size) * KM_PER_DEG_LAT;
  return { size, bbox, elev, nta, cellKm2 };
}

/** Fractional grid position of a point (row 0 is the north edge), or null outside the heightmap. */
function gridPos(grid, lat, lon) {
  const { bbox, size } = grid;
  if (lon < bbox.west || lon > bbox.east || lat < bbox.south || lat > bbox.north) return null;
  return {
    col: ((lon - bbox.west) / (bbox.east - bbox.west)) * size - 0.5,
    row: ((bbox.north - lat) / (bbox.north - bbox.south)) * size - 0.5,
  };
}

export function cellCenter(grid, row, col) {
  const { bbox, size } = grid;
  return {
    lat: bbox.north - ((row + 0.5) / size) * (bbox.north - bbox.south),
    lon: bbox.west + ((col + 0.5) / size) * (bbox.east - bbox.west),
  };
}

/** Compass bearing from point 1 to point 2, degrees clockwise from north. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const dx = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * RAD);
  const dy = lat2 - lat1;
  return (Math.atan2(dx, dy) / RAD + 360) % 360;
}

export function compassWord(deg) {
  return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(deg / 45) % 8];
}

/**
 * Ground elevation at a point (bilinear between land cells), with the NTA index of the
 * nearest land cell. Returns null outside the heightmap or out on open water.
 */
export function elevationAt(grid, lat, lon) {
  const p = gridPos(grid, lat, lon);
  if (!p) return null;
  const { size, elev, nta } = grid;
  const r0 = Math.max(0, Math.min(size - 2, Math.floor(p.row)));
  const c0 = Math.max(0, Math.min(size - 2, Math.floor(p.col)));
  const fr = Math.max(0, Math.min(1, p.row - r0));
  const fc = Math.max(0, Math.min(1, p.col - c0));
  let sum = 0;
  let wsum = 0;
  let best = -1;
  let bestW = -1;
  for (const [dr, dc, w] of [
    [0, 0, (1 - fr) * (1 - fc)],
    [0, 1, (1 - fr) * fc],
    [1, 0, fr * (1 - fc)],
    [1, 1, fr * fc],
  ]) {
    const k = (r0 + dr) * size + c0 + dc;
    if (nta[k] < 0) continue;
    sum += elev[k] * w;
    wsum += w;
    if (w > bestW) {
      bestW = w;
      best = k;
    }
  }
  if (best < 0) return null;
  return { m: wsum > 0 ? sum / wsum : elev[best], nta: nta[best] };
}

/**
 * The nearest spot of solid higher ground: a land cell at least `minM` high whose
 * eight neighbors are land and nearly as high, so a single bump or bridge ramp
 * never counts. Returns null when nothing qualifies within `maxKm`.
 */
export function findHigherGround(grid, lat, lon, { minM = HIGHER_GROUND_M, maxKm = 12 } = {}) {
  const { size, elev, nta } = grid;
  let best = null;
  for (let row = 1; row < size - 1; row++) {
    for (let col = 1; col < size - 1; col++) {
      const k = row * size + col;
      if (nta[k] < 0 || elev[k] < minM) continue;
      const c = cellCenter(grid, row, col);
      const km = kmBetween(lon, lat, c.lon, c.lat);
      if (km > maxKm || (best && km >= best.km)) continue;
      let solid = true;
      for (let dr = -1; dr <= 1 && solid; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const j = k + dr * size + dc;
          if (nta[j] < 0 || elev[j] < minM - 1) {
            solid = false;
            break;
          }
        }
      }
      if (solid) best = { ...c, m: elev[k], nta: nta[k], km };
    }
  }
  if (!best) return null;
  const bearing = bearingDeg(lat, lon, best.lat, best.lon);
  return { ...best, bearing, direction: compassWord(bearing) };
}

/**
 * Land below two water levels (metres NAVD88): `baseM` (the storm without extra sea
 * level rise) and `waterM` (with it). Areas in km²; `added` is what the rise alone floods.
 */
export function floodStats(grid, baseM, waterM) {
  const { elev, nta, cellKm2 } = grid;
  let base = 0;
  let added = 0;
  for (let k = 0; k < elev.length; k++) {
    if (nta[k] < 0) continue;
    if (elev[k] < baseM) base++;
    else if (elev[k] < waterM) added++;
  }
  return { baseKm2: base * cellKm2, addedKm2: added * cellKm2, totalKm2: (base + added) * cellKm2 };
}

/**
 * Per-NTA cell counts in one pass: land cells, cells under `baseM`, and cells only
 * `waterM` reaches. Indexed by NTA; fast enough to rerun on every slider move.
 */
export function floodByNta(grid, baseM, waterM) {
  let n = 0;
  for (let k = 0; k < grid.nta.length; k++) if (grid.nta[k] >= n) n = grid.nta[k] + 1;
  const total = new Int32Array(n);
  const base = new Int32Array(n);
  const added = new Int32Array(n);
  for (let k = 0; k < grid.elev.length; k++) {
    const i = grid.nta[k];
    if (i < 0) continue;
    total[i]++;
    if (grid.elev[k] < baseM) base[i]++;
    else if (grid.elev[k] < waterM) added[i]++;
  }
  return { total, base, added };
}

/**
 * Each NTA's land-cell elevations, sorted, built once. With it, the share of a
 * neighborhood under water at any level is a binary search, cheap enough to run
 * for all 195 NTAs on every frame of the 3D flood story. `count` is the number
 * of NTAs (the GeoJSON's length); an NTA with no cells gets an empty list.
 */
export function ntaElevationIndex(grid, count) {
  const sizes = new Int32Array(count);
  for (let k = 0; k < grid.nta.length; k++) if (grid.nta[k] >= 0 && grid.nta[k] < count) sizes[grid.nta[k]]++;
  const lists = Array.from(sizes, (n) => new Float32Array(n));
  const fill = new Int32Array(count);
  for (let k = 0; k < grid.nta.length; k++) {
    const i = grid.nta[k];
    if (i >= 0 && i < count) lists[i][fill[i]++] = grid.elev[k];
  }
  for (const list of lists) list.sort();
  return lists;
}

/** Share (0–1) of each NTA's land below `waterM` metres NAVD88; NaN for an NTA with no land. */
export function ntaShareBelow(index, waterM) {
  const out = new Float32Array(index.length);
  index.forEach((list, i) => {
    if (!list.length) {
      out[i] = NaN;
      return;
    }
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < waterM) lo = mid + 1;
      else hi = mid;
    }
    out[i] = lo / list.length;
  });
  return out;
}

/** Median elevation of a set of NTAs and the share of their land below `waterM`. */
export function ntaElevation(grid, ntaIndices, waterM) {
  const set = new Set(ntaIndices);
  const values = [];
  let below = 0;
  for (let k = 0; k < grid.elev.length; k++) {
    if (!set.has(grid.nta[k])) continue;
    values.push(grid.elev[k]);
    if (grid.elev[k] < waterM) below++;
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return { medianM: values[Math.floor(values.length / 2)], shareBelow: below / values.length, cells: values.length };
}

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));
const invMercY = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD;

/**
 * RGBA pixels for the flooded-land map layer, resampled to Web Mercator rows so
 * Leaflet can stretch it over the heightmap's bounds without drifting.
 *   colors.base  [r,g,b,a] for land under the storm at today's sea level
 *   colors.added [r,g,b,a] for land the extra sea level rise floods
 */
export function floodRaster(grid, baseM, waterM, colors) {
  const { size, bbox, elev, nta } = grid;
  const data = new Uint8ClampedArray(size * size * 4);
  const yN = mercY(bbox.north);
  const yS = mercY(bbox.south);
  for (let row = 0; row < size; row++) {
    const lat = invMercY(yN - ((row + 0.5) / size) * (yN - yS));
    const src = Math.min(size - 1, Math.max(0, Math.floor(((bbox.north - lat) / (bbox.north - bbox.south)) * size)));
    for (let col = 0; col < size; col++) {
      const k = src * size + col;
      if (nta[k] < 0) continue;
      const c = elev[k] < baseM ? colors.base : elev[k] < waterM ? colors.added : null;
      if (c) data.set(c, (row * size + col) * 4);
    }
  }
  return { width: size, height: size, data, bounds: [[bbox.south, bbox.west], [bbox.north, bbox.east]] };
}

// ---------------- browser loader ----------------

let loading = null;

/** Decode data/nyc-elevation.png once. Resolves to the grid, or null if it can't load. */
export function loadTerrain() {
  loading ||= new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = ELEVATION.url;
  })
    .then((img) => {
      const c = document.createElement('canvas');
      c.width = c.height = ELEVATION.size;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return gridFromPixels(ctx.getImageData(0, 0, ELEVATION.size, ELEVATION.size).data);
    })
    .catch((err) => {
      console.warn('[DrainWatch] elevation data failed to load', err);
      return null;
    });
  return loading;
}
