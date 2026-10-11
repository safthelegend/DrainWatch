// Climate Time Machine: historical replays and sea level rise.
//
// Each replay rebuilds the conditions of a real NYC disaster as the same kind of
// hourly data the live APIs return. It then runs that data through the same
// summaries and risk models. The numbers are APPROXIMATE reconstructions from
// NOAA tide gauge records, NWS storm summaries and EPA AirNow reports. They are
// meant to show how the model responds, not to serve as an official record.
// Neighborhood detail (exact rain or gusts on a block) is smoothed by design.

import { AREAS, SEA_LEVEL_PROJECTIONS, TIDE_STATIONS } from './config.js';
import { summarizeAir, summarizeWeather } from './data.js';
import { aqiFromPm25 } from './air-risk.js';
import { thresholdsFromGreatDiurnalRange } from './risk.js';

const ALL_BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'];
const HOUR = 3600 * 1000;

export const SCENARIOS = [
  {
    id: 'sandy',
    name: 'Hurricane Sandy',
    short: 'Sandy',
    year: 2012,
    date: 'October 29, 2012',
    hazards: ['floods', 'wind'],
    now: '2012-10-29T12:00',
    summary:
      'The storm surge at the Battery peaked near 9 ft above normal high tide, flooding subway tunnels, the Rockaways and Lower Manhattan. 44 New Yorkers died.',
  },
  {
    id: 'ida',
    name: 'Hurricane Ida',
    short: 'Ida',
    year: 2021,
    date: 'September 1, 2021',
    hazards: ['floods'],
    now: '2021-09-01T14:00',
    summary:
      "Central Park recorded a record 3.15 in of rain in one hour, and the NWS issued New York City's first Flash Flood Emergency. 13 New Yorkers died, 11 of them in basement apartments.",
  },
  {
    id: 'heat-2019',
    name: 'July 2019 heat wave',
    short: 'Heat wave',
    year: 2019,
    date: 'July 20, 2019',
    hazards: ['heat'],
    now: '2019-07-20T10:00',
    summary:
      'Heat indexes passed 105°F and nights barely dropped below 80°F. The city declared a heat emergency and opened hundreds of cooling centers.',
  },
  {
    id: 'smoke-2023',
    name: 'Canadian wildfire smoke',
    short: 'Wildfire smoke',
    year: 2023,
    date: 'June 7, 2023',
    hazards: ['air'],
    now: '2023-06-07T09:00',
    summary:
      'Smoke from wildfires in Quebec turned the sky orange. For a few hours New York had the worst air quality of any major city in the world.',
  },
  {
    id: 'isaias',
    name: 'Tropical Storm Isaias',
    short: 'Isaias',
    year: 2020,
    date: 'August 4, 2020',
    hazards: ['wind'],
    now: '2020-08-04T08:00',
    summary:
      'Gusts near 70 mph brought down thousands of trees and knocked out power to more than 250,000 Con Edison customers, the most since Sandy.',
  },
];

export function scenarioById(id) {
  return SCENARIOS.find((s) => s.id === id) || null;
}

export function scenariosFor(hazard) {
  return SCENARIOS.filter((s) => s.hazards.includes(hazard));
}

// ---------------- sea level rise ----------------

/** Slider stops: today plus the middle of the NPCC "likely" range for each period. */
export const SEA_LEVEL_STOPS = [
  { id: 'today', label: 'Today', inches: 0 },
  ...SEA_LEVEL_PROJECTIONS.filter((p) => p.period !== '2020s').map((p) => ({
    id: p.period,
    label: p.period,
    inches: Math.round((p.low + p.high) / 2),
    highEnd: p.highEnd,
  })),
];

/** Raise every water level (observed, predicted and peak) by `inches` of sea level rise. */
export function withSeaLevelRise(tides, inches) {
  if (!inches) return tides;
  const ft = inches / 12;
  const out = {};
  for (const [key, t] of Object.entries(tides || {})) {
    out[key] = {
      ...t,
      latest: t.latest ? { ...t.latest, v: t.latest.v + ft } : null,
      predictions: t.predictions.map((p) => ({ ...p, v: p.v + ft })),
      peak: t.peak != null ? Math.round((t.peak + ft) * 100) / 100 : null,
      seaLevelRiseFt: ft,
    };
  }
  return out;
}

// ---------------- building blocks ----------------

function parseKey(key) {
  const [d, t] = key.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [h, min] = t.split(':').map(Number);
  return Date.UTC(y, m - 1, day, h, min);
}

function fmtKey(ms, sep = 'T') {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}${sep}${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const bump = (x, center, width) => Math.exp(-(((x - center) / width) ** 2));

/** Relative humidity (%) from temperature and dew point (°F), Magnus formula. */
export function relativeHumidity(tempF, dewPointF) {
  const c = (f) => ((f - 32) * 5) / 9;
  const es = (tc) => Math.exp((17.625 * tc) / (243.04 + tc));
  return Math.round(Math.min(100, (100 * es(c(dewPointF))) / es(c(tempF))));
}

const WIND_FACTOR = { 1: 0.8, 2: 0.9, 3: 1 };
const isOceanFront = (a) => a.windExposure === 3 && a.coastalExposure === 3;

/** 24 h of history plus 48 h ahead, generated hour by hour for every neighborhood. */
function buildWeather(nowKey, gen) {
  const start = parseKey(nowKey) - 24 * HOUR;
  const time = Array.from({ length: 72 }, (_, i) => fmtKey(start + i * HOUR));
  return AREAS.map((area) => {
    const hourly = { time, precipitation: [], temperature_2m: [], relative_humidity_2m: [], wind_speed_10m: [], wind_gusts_10m: [], weather_code: [] };
    time.forEach((t, i) => {
      const w = gen(i - 24, area, +t.slice(11, 13));
      hourly.precipitation.push(Math.round(w.precip * 100) / 100);
      hourly.temperature_2m.push(Math.round(w.temp * 10) / 10);
      hourly.relative_humidity_2m.push(w.rh);
      hourly.wind_speed_10m.push(Math.round(w.wind));
      hourly.wind_gusts_10m.push(Math.round(w.gust));
      hourly.weather_code.push(w.code);
    });
    return summarizeWeather(hourly, nowKey);
  });
}

/** 48 h of air quality: PM2.5 in µg/m³ (converted to AQI with the EPA formula) and an ozone AQI. */
function buildAir(nowKey, pm25At, ozoneAqiAt = () => 25) {
  const start = parseKey(nowKey);
  const time = Array.from({ length: 48 }, (_, i) => fmtKey(start + i * HOUR));
  return AREAS.map((area) => {
    const pm = time.map((_, h) => Math.round(pm25At(h, area) * 10) / 10);
    const aqiPm = pm.map(aqiFromPm25);
    const aqiO3 = time.map((_, h) => Math.round(ozoneAqiAt(h, area)));
    const hourly = { time, pm2_5: pm, ozone: time.map(() => null), us_aqi_pm2_5: aqiPm, us_aqi_ozone: aqiO3, us_aqi: aqiPm.map((v, i) => Math.max(v, aqiO3[i])) };
    return summarizeAir(hourly, nowKey);
  });
}

const cleanAir = (nowKey) => buildAir(nowKey, () => 6);

/**
 * Water level at each tide gauge, every 30 minutes for 48 h: astronomical tide
 * (a simple semidiurnal curve in MHHW feet) plus a storm surge hump that peaks
 * at `peakFt` above MHHW, `peakHour` hours after the start.
 */
function buildTides(nowKey, peaks) {
  const start = parseKey(nowKey);
  const out = {};
  for (const [key, station] of Object.entries(TIDE_STATIONS)) {
    const gt = station.greatDiurnalRangeFt;
    const { peakFt, peakHour, width = 6, highTideHour = peakHour } = peaks[key];
    const tide = (h) => -gt / 2 + (gt / 2 + 0.25) * Math.cos((2 * Math.PI * (h - highTideHour)) / 12.42);
    const surgeAtPeak = Math.max(0, peakFt - tide(peakHour));
    const surge = (h) => surgeAtPeak * bump(h, peakHour, width);
    const predictions = Array.from({ length: 97 }, (_, i) => {
      const h = i / 2;
      return { t: fmtKey(start + h * HOUR, ' '), v: Math.round((tide(h) + surge(h)) * 100) / 100 };
    });
    out[key] = {
      station,
      stationKey: key,
      thresholds: thresholdsFromGreatDiurnalRange(gt),
      latest: { t: predictions[0].t, v: predictions[0].v },
      surge: Math.round(surge(0) * 100) / 100,
      predictions,
      peak: Math.max(...predictions.map((p) => p.v)),
      includesSurge: true,
    };
  }
  return out;
}

const calmTides = (nowKey, highTideHour = 3) =>
  buildTides(
    nowKey,
    Object.fromEntries(Object.keys(TIDE_STATIONS).map((k) => [k, { peakFt: 0.2, peakHour: highTideHour }])),
  );

const alert = (event, boroughs = ALL_BOROUGHS) => ({ event, headline: event, ends: null, boroughs });

// ---------------- the replays ----------------

const BUILDERS = {
  sandy(s) {
    return {
      tides: buildTides(s.now, {
        battery: { peakFt: 9.0, peakHour: 9.4, highTideHour: 8.9 },
        bergenPoint: { peakFt: 9.4, peakHour: 9.5, highTideHour: 9.1 },
        sandyHook: { peakFt: 8.5, peakHour: 8.6, highTideHour: 8.4 },
        kingsPoint: { peakFt: 6.7, peakHour: 10.8, highTideHour: 11.2 },
      }),
      weather: buildWeather(s.now, (h, area) => {
        const gust = (30 + 50 * bump(h, 8, 7)) * WIND_FACTOR[area.windExposure];
        return { precip: 0.02 + 0.13 * bump(h, 6, 6), temp: 58, rh: 92, gust, wind: gust * 0.6, code: h > -6 && h < 24 ? 63 : 61 };
      }),
      air: cleanAir(s.now),
      alerts: [alert('Coastal Flood Warning'), alert('High Wind Warning')],
    };
  },

  ida(s) {
    // Hourly rain at Central Park, starting 2 PM (h = 0). The record 3.15 in fell from roughly 9 to 10 PM.
    const rain = [0.03, 0.05, 0.08, 0.12, 0.25, 0.45, 0.9, 3.15, 1.5, 0.5, 0.15, 0.05];
    const factor = { Manhattan: 1, Queens: 0.95, Bronx: 0.9, Brooklyn: 0.85, 'Staten Island': 0.75 };
    return {
      tides: calmTides(s.now, 6.5),
      weather: buildWeather(s.now, (h, area) => {
        const precip = h >= 0 && h < rain.length ? rain[h] * factor[area.borough] : 0;
        const gust = 20 + 18 * bump(h, 7, 3);
        return { precip, temp: 72, rh: 95, gust, wind: gust * 0.55, code: h >= 6 && h <= 9 ? 95 : precip > 0 ? 63 : 3 };
      }),
      air: cleanAir(s.now),
      alerts: [alert('Flash Flood Emergency', ['Manhattan', 'Bronx', 'Brooklyn', 'Queens']), alert('Flash Flood Warning')],
    };
  },

  'heat-2019'(s) {
    const offset = { Manhattan: 1, Bronx: 1, Brooklyn: 0, Queens: 0, 'Staten Island': -1 };
    return {
      tides: calmTides(s.now),
      weather: buildWeather(s.now, (h, area, hour) => {
        const shift = offset[area.borough] - (isOceanFront(area) ? 3 : 0);
        const temp = 88.5 + 6.5 * Math.cos((2 * Math.PI * (hour - 16)) / 24) + shift;
        return { precip: 0, temp, rh: relativeHumidity(temp, 73), gust: 16, wind: 9, code: 1 };
      }),
      air: buildAir(s.now, (h) => 14 + 6 * bump(h, 6, 6), (h) => 55 + 50 * bump(h, 6, 4)),
      alerts: [alert('Excessive Heat Warning')],
    };
  },

  'smoke-2023'(s) {
    const offset = { Manhattan: 1.05, Bronx: 1.05, Brooklyn: 1, Queens: 1, 'Staten Island': 0.92 };
    return {
      tides: calmTides(s.now),
      weather: buildWeather(s.now, () => ({ precip: 0, temp: 66, rh: 55, gust: 14, wind: 8, code: 3 })),
      // PM2.5 (µg/m³): rising all morning, peaking late afternoon, then slowly easing.
      air: buildAir(s.now, (h, area) => (100 + 190 * bump(h, 8, 4) + 60 * bump(h, 30, 10)) * offset[area.borough]),
      alerts: [alert('Air Quality Alert')],
    };
  },

  isaias(s) {
    return {
      tides: buildTides(s.now, {
        battery: { peakFt: 1.6, peakHour: 6.5, width: 4 },
        bergenPoint: { peakFt: 1.7, peakHour: 6.6, width: 4 },
        sandyHook: { peakFt: 1.5, peakHour: 6.2, width: 4 },
        kingsPoint: { peakFt: 1.4, peakHour: 8.5, width: 4 },
      }),
      weather: buildWeather(s.now, (h, area) => {
        const precip = 0.9 * bump(h, 4, 2.5) + (h >= 0 && h < 10 ? 0.02 : 0);
        const gust = (25 + 45 * bump(h, 6, 3)) * WIND_FACTOR[area.windExposure];
        return { precip, temp: 80, rh: 88, gust, wind: gust * 0.58, code: h >= 3 && h <= 6 ? 95 : precip > 0.05 ? 63 : 3 };
      }),
      air: cleanAir(s.now),
      alerts: [alert('Tropical Storm Warning')],
    };
  },
};

/** Inputs for a replay, shaped exactly like the live inputs app.js assembles. */
export function buildScenario(id) {
  const s = scenarioById(id);
  if (!s) throw new Error(`Unknown scenario: ${id}`);
  return { mode: id, scenario: s, nowKey: s.now, reports: null, ...BUILDERS[id](s) };
}
