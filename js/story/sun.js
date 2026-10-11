// Where the sun is in New York's sky at a given moment, so the 3D scene can
// light each replayed hour the way it actually looked. Pure functions.

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export const NYC = { lat: 40.7128, lon: -74.006 };

/**
 * Solar elevation and azimuth (degrees; azimuth clockwise from north) for a UTC
 * time in milliseconds. Low-precision almanac formulas, good to about 0.5°.
 */
export function solarPosition(utcMs, lat = NYC.lat, lon = NYC.lon) {
  const d = utcMs / 86400000 + 2440587.5 - 2451545.0; // days since J2000
  const g = rad((357.529 + 0.98560028 * d) % 360);
  const q = (280.459 + 0.98564736 * d) % 360;
  const L = rad(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const e = rad(23.439 - 0.00000036 * d);
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = rad(gmst * 15 + lon) - ra;
  const phi = rad(lat);
  const elevation = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const azimuth = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { elevation: deg(elevation), azimuth: (deg(azimuth) + 360) % 360 };
}

/** "2019-07-20T16:00" in New York local time → UTC milliseconds (handles daylight time). */
export function nyLocalToUtc(key) {
  const [d, t] = key.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [h, min] = t.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, day, h, min);
  for (const offset of [4, 5]) {
    const guess = naive + offset * 3600000;
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
    if (+parts.find((p) => p.type === 'hour').value === h) return guess;
  }
  return naive + 5 * 3600000;
}

/** 0 at night, 1 in full daylight, easing through civil twilight. */
export function daylight(elevation) {
  return Math.min(1, Math.max(0, (elevation + 6) / 16));
}
