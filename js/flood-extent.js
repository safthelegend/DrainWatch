// Flood extent from the city heightmap (data/nyc-elevation.png): which land a
// water level reaches, how much more sea level rise adds, and the nearest ground
// that stays dry. Pure functions over a decoded grid, so node --test can check
// them; app.js loads the image and map.js draws the result.
//
// grid: { size, bbox, elev: Float32Array (m, NAVD88), nta: Uint8Array (0 = water or outside NYC, else 1 + NTA index) }
//
// The model is a "connected bathtub": land floods when it is below the water
// level AND touches open water through other flooded cells, so low inland
// basins behind high ground stay dry. It ignores seawalls, drainage and how
// long the surge lasts, so it overstates some places and understates others.

import { decodeElevation, ELEVATION } from './story/elevation.js';
import { distanceKm } from './risk.js';

export const M_PER_FT = 0.3048;

/** Decode RGBA pixels (from a canvas or a PNG decoder) into a grid. */
export function gridFromPixels(rgba, size = ELEVATION.size, bbox = ELEVATION.bbox, channels = 4) {
  const n = size * size;
  const elev = new Float32Array(n);
  const nta = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const o = k * channels;
    elev[k] = decodeElevation(rgba[o], rgba[o + 1]);
    nta[k] = rgba[o + 2];
  }
  return { size, bbox, elev, nta };
}

/** Grid index of the cell under a point, or -1 outside the grid. */
export function cellIndex(grid, lat, lon) {
  const { size, bbox } = grid;
  const col = Math.floor(((lon - bbox.west) / (bbox.east - bbox.west)) * size);
  const row = Math.floor(((bbox.north - lat) / (bbox.north - bbox.south)) * size);
  if (col < 0 || row < 0 || col >= size || row >= size) return -1;
  return row * size + col;
}

/** lat/lon of the centre of cell k. */
export function cellLatLon(grid, k) {
  const { size, bbox } = grid;
  const row = Math.floor(k / size);
  const col = k - row * size;
  return {
    lat: bbox.north - ((row + 0.5) / size) * (bbox.north - bbox.south),
    lon: bbox.west + ((col + 0.5) / size) * (bbox.east - bbox.west),
  };
}

/** Ground elevation (m) at a point, or null outside the grid or off land. */
export function elevationAt(grid, lat, lon) {
  const k = cellIndex(grid, lat, lon);
  return k < 0 ? null : grid.elev[k];
}

/** Area of one grid cell in km² (cells are ~110 m on a side). */
export function cellAreaKm2(grid) {
  const { size, bbox } = grid;
  const midLat = (bbox.north + bbox.south) / 2;
  const midLon = (bbox.east + bbox.west) / 2;
  const w = distanceKm(midLat, bbox.west, midLat, bbox.east) / size;
  const h = distanceKm(bbox.south, midLon, bbox.north, midLon) / size;
  return w * h;
}

/**
 * Cells reached by water standing at `levelM` (m NAVD88), flooding outward from
 * open water. Returns a Uint8Array mask, 1 = under water (open water included).
 */
export function floodMask(grid, levelM) {
  const { size, elev, nta } = grid;
  const n = size * size;
  const mask = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const seedMax = Math.min(levelM, 0);
  for (let k = 0; k < n; k++) {
    if (nta[k] === 0 && elev[k] <= seedMax) {
      mask[k] = 1;
      queue[tail++] = k;
    }
  }
  const visit = (k) => {
    if (!mask[k] && elev[k] <= levelM) {
      mask[k] = 1;
      queue[tail++] = k;
    }
  };
  while (head < tail) {
    const k = queue[head++];
    const row = (k / size) | 0;
    const col = k - row * size;
    if (col > 0) visit(k - 1);
    if (col < size - 1) visit(k + 1);
    if (row > 0) visit(k - size);
    if (row < size - 1) visit(k + size);
  }
  return mask;
}

/**
 * Land (city cells only) per NTA, and how much of it each mask floods.
 * Returns { land: Uint32Array, wet: Uint32Array[] } indexed by the grid's NTA code.
 */
export function floodCounts(grid, masks) {
  const land = new Uint32Array(256);
  const wet = masks.map(() => new Uint32Array(256));
  const { nta } = grid;
  for (let k = 0; k < nta.length; k++) {
    const code = nta[k];
    if (!code) continue;
    land[code]++;
    for (let m = 0; m < masks.length; m++) if (masks[m][k]) wet[m][code]++;
  }
  return { land, wet };
}

/** Median ground elevation (m) of the land in each NTA, indexed by NTA code. */
export function medianElevationByNta(grid) {
  const lists = new Map();
  for (let k = 0; k < grid.nta.length; k++) {
    const code = grid.nta[k];
    if (!code) continue;
    if (!lists.has(code)) lists.set(code, []);
    lists.get(code).push(grid.elev[k]);
  }
  const out = new Map();
  for (const [code, list] of lists) {
    list.sort((a, b) => a - b);
    out.set(code, list[Math.floor(list.length / 2)]);
  }
  return out;
}

/**
 * Nearest city land at or above `minElevM` that can be reached ON FOOT from a
 * point: the search spreads only across city land, never across open water, so
 * a barrier island never points at a hill across the bay. A cell only counts
 * when most of its neighbours qualify too, so a single noisy pixel is never
 * offered as refuge. Returns { lat, lon, elevM, km, routeKm } or null when
 * nothing qualifies within `maxKm` of walking.
 */
export function nearestHigherGround(grid, lat, lon, minElevM, maxKm = 5) {
  const { size, elev, nta } = grid;
  let start = cellIndex(grid, lat, lon);
  if (start < 0) return null;
  // an address on the shoreline can fall in a water cell; step onto the nearest land
  if (!nta[start]) {
    const r = Math.floor(start / size);
    const c = start - r * size;
    let found = -1;
    for (let dr = -1; dr <= 1 && found < 0; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < size && cc < size && nta[rr * size + cc]) {
          found = rr * size + cc;
          break;
        }
      }
    if (found < 0) return null;
    start = found;
  }
  const cellKm = Math.sqrt(cellAreaKm2(grid));
  const maxSteps = Math.ceil(maxKm / cellKm);
  const ok = (r, c) => r >= 0 && c >= 0 && r < size && c < size && nta[r * size + c] > 0 && elev[r * size + c] >= minElevM;
  const solid = (k) => {
    const r = Math.floor(k / size);
    const c = k - r * size;
    if (!ok(r, c)) return false;
    let n = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if ((dr || dc) && ok(r + dr, c + dc)) n++;
    return n >= 5;
  };

  // breadth-first over land, 8 neighbours, one ring of steps at a time
  const seen = new Uint8Array(size * size);
  let ring = [start];
  seen[start] = 1;
  for (let step = 0; step <= maxSteps && ring.length; step++) {
    let best = null;
    for (const k of ring) {
      if (!solid(k)) continue;
      const p = cellLatLon(grid, k);
      const km = distanceKm(lat, lon, p.lat, p.lon);
      if (!best || km < best.km) best = { ...p, elevM: elev[k], km, routeKm: step * cellKm };
    }
    if (best) return best;
    const next = [];
    for (const k of ring) {
      const r = Math.floor(k / size);
      const c = k - r * size;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if ((!dr && !dc) || rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
          const kk = rr * size + cc;
          if (seen[kk] || !nta[kk]) continue;
          seen[kk] = 1;
          next.push(kk);
        }
    }
    ring = next;
  }
  return null;
}

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const fromMercY = (y) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

/**
 * RGBA pixels for the map's flood overlay. City land under `base` is painted in
 * `baseRgb`, deeper water more opaque; land that only `plus` reaches (the extra
 * flooding from sea level rise) is painted in `plusRgb`. Rows are resampled to
 * Web Mercator so the image lines up with the map tiles when stretched to the
 * grid's bounds.
 */
export function floodImage(grid, { base, plus = null, baseLevelM, baseRgb, plusRgb }) {
  const { size, bbox, elev, nta } = grid;
  const out = new Uint8ClampedArray(size * size * 4);
  const yN = mercY(bbox.north);
  const yS = mercY(bbox.south);
  for (let j = 0; j < size; j++) {
    const lat = fromMercY(yN + ((j + 0.5) / size) * (yS - yN));
    const row = Math.min(size - 1, Math.max(0, Math.floor(((bbox.north - lat) / (bbox.north - bbox.south)) * size)));
    for (let col = 0; col < size; col++) {
      const k = row * size + col;
      if (!nta[k]) continue;
      const o = (j * size + col) * 4;
      if (base[k]) {
        const depth = Math.max(0, baseLevelM - elev[k]);
        out[o] = baseRgb[0];
        out[o + 1] = baseRgb[1];
        out[o + 2] = baseRgb[2];
        out[o + 3] = Math.round(255 * (0.45 + 0.4 * Math.min(1, depth / 2.5)));
      } else if (plus && plus[k]) {
        out[o] = plusRgb[0];
        out[o + 1] = plusRgb[1];
        out[o + 2] = plusRgb[2];
        out[o + 3] = 235;
      }
    }
  }
  return out;
}

/** "northeast" etc., from one point toward another. */
export function compassWord(lat1, lon1, lat2, lon2) {
  const y = lat2 - lat1;
  const x = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180);
  const deg = ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
  return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(deg / 45) % 8];
}

/** Straight-line walking time in minutes at an unhurried 4.5 km/h, rounded to 5. */
export function walkMinutes(km) {
  return Math.max(5, Math.round(((km / 4.5) * 60) / 5) * 5);
}
