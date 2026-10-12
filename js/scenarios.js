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
import { heatIndexF } from './heat-risk.js';
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
function buildAir(nowKey, pm25At, ozoneAqiAt) {
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

/**
 * Water level (ft above MHHW) at one tide gauge, h hours after the replay's start:
 * an astronomical tide (a simple semidiurnal curve) plus a storm surge hump that
 * peaks at `peakFt` above MHHW, `peakHour` hours after the start.
 */
function waterLevelFn(station, { peakFt, peakHour, width = 6, highTideHour = peakHour }) {
  const gt = station.greatDiurnalRangeFt;
  const tide = (h) => -gt / 2 + (gt / 2 + 0.25) * Math.cos((2 * Math.PI * (h - highTideHour)) / 12.42);
  const surgeAtPeak = Math.max(0, peakFt - tide(peakHour));
  const surge = (h) => surgeAtPeak * bump(h, peakHour, width);
  return { level: (h) => tide(h) + surge(h), surge };
}

/** Every 30 minutes for 48 h at each tide gauge, shaped like fetchTides() output. */
function buildTides(nowKey, params) {
  const start = parseKey(nowKey);
  const out = {};
  for (const [key, station] of Object.entries(TIDE_STATIONS)) {
    const { level, surge } = waterLevelFn(station, params[key]);
    const predictions = Array.from({ length: 97 }, (_, i) => {
      const h = i / 2;
      return { t: fmtKey(start + h * HOUR, ' '), v: Math.round(level(h) * 100) / 100 };
    });
    out[key] = {
      station,
      stationKey: key,
      thresholds: thresholdsFromGreatDiurnalRange(station.greatDiurnalRangeFt),
      latest: { t: predictions[0].t, v: predictions[0].v },
      surge: Math.round(surge(0) * 100) / 100,
      predictions,
      peak: Math.max(...predictions.map((p) => p.v)),
      includesSurge: true,
    };
  }
  return out;
}

const alert = (event, boroughs = ALL_BOROUGHS) => ({ event, headline: event, ends: null, boroughs });

/** Cosine-eased curve through [hour, value] turning points, e.g. daily highs and lows. */
function throughExtremes(points) {
  return (h) => {
    if (h <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      const [h1, v1] = points[i];
      if (h <= h1) {
        const [h0, v0] = points[i - 1];
        const t = (h - h0) / (h1 - h0);
        return v0 + (v1 - v0) * (1 - Math.cos(Math.PI * t)) / 2;
      }
    }
    return points[points.length - 1][1];
  };
}

// ---------------- the replays ----------------
//
// Each spec gives hour-by-hour generators; h counts hours from the scenario's
// `now` (negative = before it). `tides` gives surge parameters per gauge, or
// `calmHighTide` for an ordinary tide.

const SPECS = {
  sandy: {
    tides: {
      // The surge built for a day before peaking with the evening high tide.
      battery: { peakFt: 9.0, peakHour: 9.4, highTideHour: 8.9, width: 11 },
      bergenPoint: { peakFt: 9.4, peakHour: 9.5, highTideHour: 9.1, width: 11 },
      sandyHook: { peakFt: 8.5, peakHour: 8.6, highTideHour: 8.4, width: 11 },
      kingsPoint: { peakFt: 6.7, peakHour: 10.8, highTideHour: 11.2, width: 11 },
    },
    weather: (h, area) => {
      const gust = (30 + 50 * bump(h, 8, 7)) * WIND_FACTOR[area.windExposure];
      return { precip: 0.02 + 0.13 * bump(h, 6, 6), temp: 58, rh: 92, gust, wind: gust * 0.6, code: h > -6 && h < 24 ? 63 : 61 };
    },
    alerts: [alert('Coastal Flood Warning'), alert('High Wind Warning')],
  },

  ida: {
    calmHighTide: 6.5,
    weather: (h, area) => {
      // Hourly rain at Central Park, starting 2 PM (h = 0). The record 3.15 in fell from roughly 9 to 10 PM.
      const rain = [0.03, 0.05, 0.08, 0.12, 0.25, 0.45, 0.9, 3.15, 1.5, 0.5, 0.15, 0.05];
      const factor = { Manhattan: 1, Queens: 0.95, Bronx: 0.9, Brooklyn: 0.85, 'Staten Island': 0.75 };
      const precip = h >= 0 && h < rain.length ? rain[h] * factor[area.borough] : 0;
      const gust = 20 + 18 * bump(h, 7, 3);
      return { precip, temp: 72, rh: 95, gust, wind: gust * 0.55, code: h >= 6 && h <= 9 ? 95 : precip > 0 ? 63 : 3 };
    },
    alerts: [alert('Flash Flood Emergency', ['Manhattan', 'Bronx', 'Brooklyn', 'Queens']), alert('Flash Flood Warning')],
  },

  'heat-2019': (() => {
    // Central Park-like daily highs and lows (°F), hours from Saturday July 20, 10 AM.
    const temp = throughExtremes([
      [-42, 88], // Thu 4 PM
      [-29, 77], // Fri 5 AM
      [-18, 92], // Fri 4 PM
      [-5, 81], // Sat 5 AM
      [6, 95], // Sat 4 PM
      [19, 82], // Sun 5 AM
      [30, 95], // Sun 4 PM
      [43, 80], // Mon 5 AM
      [54, 86], // Mon 4 PM
      [67, 72], // Tue 5 AM
    ]);
    const offset = { Manhattan: 1, Bronx: 1, Brooklyn: 0, Queens: 0, 'Staten Island': -1 };
    return {
      weather: (h, area) => {
        const t = temp(h) + offset[area.borough] - (isOceanFront(area) ? 3 : 0);
        return { precip: 0, temp: t, rh: relativeHumidity(t, 73), gust: 16, wind: 9, code: 1 };
      },
      pm25: (h) => 14 + 6 * bump(h, 6, 6),
      ozoneAqi: (h) => 55 + 50 * bump(h, 6, 4),
      alerts: [alert('Excessive Heat Warning')],
    };
  })(),

  'smoke-2023': {
    weather: () => ({ precip: 0, temp: 66, rh: 55, gust: 14, wind: 8, code: 3 }),
    // PM2.5 (µg/m³): rising all morning, peaking late afternoon, then slowly easing.
    pm25: (h, area) => {
      const offset = { Manhattan: 1.05, Bronx: 1.05, Brooklyn: 1, Queens: 1, 'Staten Island': 0.92 };
      return Math.max(6, 100 + 190 * bump(h, 8, 4) + 60 * bump(h, 30, 10) - (h < 0 ? 4 * -h : 0)) * offset[area.borough];
    },
    alerts: [alert('Air Quality Alert')],
  },

  isaias: {
    tides: {
      battery: { peakFt: 1.6, peakHour: 6.5, width: 4 },
      bergenPoint: { peakFt: 1.7, peakHour: 6.6, width: 4 },
      sandyHook: { peakFt: 1.5, peakHour: 6.2, width: 4 },
      kingsPoint: { peakFt: 1.4, peakHour: 8.5, width: 4 },
    },
    weather: (h, area) => {
      const precip = 0.9 * bump(h, 4, 2.5) + (h >= 0 && h < 10 ? 0.02 : 0);
      const gust = (25 + 45 * bump(h, 6, 3)) * WIND_FACTOR[area.windExposure];
      return { precip, temp: 80, rh: 88, gust, wind: gust * 0.58, code: h >= 3 && h <= 6 ? 95 : precip > 0.05 ? 63 : 3 };
    },
    alerts: [alert('Tropical Storm Warning')],
  },
};

const CLEAN_PM25 = () => 6;
const BACKGROUND_OZONE = () => 25;

function tideParams(spec) {
  if (spec.tides) return spec.tides;
  return Object.fromEntries(Object.keys(TIDE_STATIONS).map((k) => [k, { peakFt: 0.2, peakHour: spec.calmHighTide ?? 3 }]));
}

/**
 * Hour-by-hour values for every neighborhood over any window of a replay, for
 * the scroll-driven story: heat index, temperature, rain, gusts, AQI and the
 * water level at each tide gauge (ft above MHHW).
 */
export function scenarioHourly(id, fromKey, hours) {
  const s = scenarioById(id);
  const spec = SPECS[id];
  const offset = (parseKey(fromKey) - parseKey(s.now)) / HOUR;
  const time = Array.from({ length: hours }, (_, k) => fmtKey(parseKey(fromKey) + k * HOUR));
  const params = tideParams(spec);
  const water = Object.fromEntries(
    Object.entries(TIDE_STATIONS).map(([key, station]) => {
      const { level } = waterLevelFn(station, params[key]);
      return [key, time.map((_, k) => Math.round(level(offset + k) * 100) / 100)];
    }),
  );
  const areas = AREAS.map((area) => {
    const row = { temp: [], heatIndex: [], precip: [], gust: [], aqi: [] };
    time.forEach((t, k) => {
      const h = offset + k;
      const w = spec.weather(h, area, +t.slice(11, 13));
      row.temp.push(Math.round(w.temp * 10) / 10);
      row.heatIndex.push(heatIndexF(w.temp, w.rh));
      row.precip.push(Math.round(w.precip * 100) / 100);
      row.gust.push(Math.round(w.gust));
      const pm = (spec.pm25 || CLEAN_PM25)(h, area);
      row.aqi.push(Math.max(aqiFromPm25(Math.round(pm * 10) / 10), Math.round((spec.ozoneAqi || BACKGROUND_OZONE)(h, area))));
    });
    return row;
  });
  return { time, areas, water };
}

/**
 * Hour-by-hour water level at one tide gauge (ft above MHHW) around a replay's
 * start, for the time machine's storm-hour scrubber. `peak` indexes the highest hour.
 */
export function replayWaterSeries(id, station = 'battery', before = 12, after = 30) {
  const s = scenarioById(id);
  const from = fmtKey(parseKey(s.now) - before * HOUR);
  const { time, water } = scenarioHourly(id, from, before + after + 1);
  const level = water[station];
  const peak = level.reduce((best, v, k) => (v > level[best] ? k : best), 0);
  return { time, level, peak };
}

/** Inputs for a replay, shaped exactly like the live inputs app.js assembles. */
export function buildScenario(id) {
  const s = scenarioById(id);
  if (!s) throw new Error(`Unknown scenario: ${id}`);
  const spec = SPECS[id];
  return {
    mode: id,
    scenario: s,
    nowKey: s.now,
    reports: null,
    tides: buildTides(s.now, tideParams(spec)),
    weather: buildWeather(s.now, spec.weather),
    air: buildAir(s.now, spec.pm25 || CLEAN_PM25, spec.ozoneAqi || BACKGROUND_OZONE),
    alerts: spec.alerts,
  };
}
