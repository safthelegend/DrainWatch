// Small, dependency-free geometry helpers shared by the 3D stage, the map and
// the data scripts. Pure functions only.

const R = 6371; // km
export const ORIGIN = { lon: -73.94, lat: 40.7 };
const K = Math.cos((ORIGIN.lat * Math.PI) / 180);
const rad = (d) => (d * Math.PI) / 180;
const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2));

/**
 * Mercator projection (the same math as d3.geoMercator), scaled so one unit is
 * one kilometre near the city. Returns [x east, y north] in km from ORIGIN.
 */
export function project(lon, lat) {
  return [R * rad(lon - ORIGIN.lon) * K, R * (merc(lat) - merc(ORIGIN.lat)) * K];
}

export function unproject(x, y) {
  const lon = ORIGIN.lon + (x / (R * K)) * (180 / Math.PI);
  const m = y / (R * K) + merc(ORIGIN.lat);
  const lat = (2 * Math.atan(Math.exp(m)) - Math.PI / 2) * (180 / Math.PI);
  return [lon, lat];
}

/** Ray-casting point-in-ring test. ring: [[lon, lat], ...] */
export function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Polygon / MultiPolygon containment, honoring holes. */
export function inGeometry(lon, lat, geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  return polys.some((rings) => inRing(lon, lat, rings[0]) && !rings.slice(1).some((h) => inRing(lon, lat, h)));
}

/** Signed area of a ring in coordinate units (positive = counter-clockwise). */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return -a / 2;
}

/** Area-weighted centroid of the outer rings of a Polygon or MultiPolygon. */
export function centroid(geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  let cx = 0;
  let cy = 0;
  let total = 0;
  for (const rings of polys) {
    const ring = rings[0];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      cx += (ring[j][0] + ring[i][0]) * f;
      cy += (ring[j][1] + ring[i][1]) * f;
      total += f;
    }
  }
  if (!total) return polys[0][0][0];
  return [cx / (3 * total), cy / (3 * total)];
}

/** Distance in km between two lon/lat points (fine for city scale). */
export function kmBetween(lon1, lat1, lon2, lat2) {
  const [x1, y1] = project(lon1, lat1);
  const [x2, y2] = project(lon2, lat2);
  return Math.hypot(x2 - x1, y2 - y1);
}

/**
 * Inverse-distance weighting: blends the values measured at `points`
 * ([{ lon, lat, value }]) into an estimate at (lon, lat). Used to spread the
 * 39 modeled points across all neighborhoods, and labeled "modeled" on the page.
 */
export function idw(lon, lat, points, { power = 2, nearest = 6 } = {}) {
  const ranked = points
    .filter((p) => p.value != null && !Number.isNaN(p.value))
    .map((p) => ({ d: kmBetween(lon, lat, p.lon, p.lat), v: p.value }))
    .sort((a, b) => a.d - b.d)
    .slice(0, nearest);
  if (!ranked.length) return null;
  if (ranked[0].d < 0.05) return ranked[0].v;
  let num = 0;
  let den = 0;
  for (const { d, v } of ranked) {
    const w = 1 / d ** power;
    num += w * v;
    den += w;
  }
  return num / den;
}
