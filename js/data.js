// Fetchers for the live, public data sources. None of these require an API key.
//
//   NOAA CO-OPS      – observed + predicted water levels (tides & storm surge)
//   Open-Meteo       – hourly rain, temperature, humidity, wind and air quality forecasts
//   NWS (weather.gov)– active alerts for NYC
//   NYC Open Data    – 311 street flooding & sewer backup reports
//   NYC GeoSearch    – address lookup
//   FEMA NFHL        – flood zone at a point
//   NYC Emergency Management (via NYC Open Data) – hurricane evacuation zones and centers
//
// Every fetcher throws on failure; app.js catches per source so one outage
// doesn't take down the whole dashboard. The summarize* helpers are pure, so the
// historical replays in scenarios.js run through exactly the same code.

import { BOROUGH_SAME, NYC_OPEN_DATA_APP_TOKEN, TIDE_STATIONS } from './config.js';
import { heatIndexF } from './heat-risk.js';
import { peakWaterLevel, thresholdsFromGreatDiurnalRange } from './risk.js';

const NY_TZ = 'America/New_York';
const FLOOD_311_WHERE = "complaint_type='Sewer' AND (descriptor like '%Flood%' OR descriptor like '%Backup%')";

export const FEMA_NFHL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer';
export const FEMA_FLOOD_ZONE_LAYER = 28;

async function fetchJson(url, { timeoutMs = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Date parts in New York local time. */
function nyParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') };
}

/** "2026-09-28T14:00" style local timestamp, used to line up Open-Meteo hours. */
export function nyHourKey(date = new Date()) {
  const p = nyParts(date);
  return `${p.y}-${p.m}-${p.d}T${p.h}:00`;
}

/** Parse NOAA's "2026-09-28 14:06" local string into minutes for comparisons. */
function noaaMinutes(t) {
  return Date.parse(t.replace(' ', 'T') + 'Z') / 60000;
}

// ---------------- NOAA tides ----------------

const NOAA = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';

function noaaUrl(stationId, params) {
  const q = new URLSearchParams({
    station: stationId,
    datum: 'MHHW', // heights relative to the average higher high tide
    units: 'english',
    time_zone: 'lst_ldt',
    format: 'json',
    application: 'DrainWatch',
    ...params,
  });
  return `${NOAA}?${q}`;
}

/**
 * Latest observed water level and the next 48 h of predicted tides for a station.
 * Heights are feet above MHHW, so 0 = a normal high tide.
 */
export async function fetchTides(stationKey) {
  const station = TIDE_STATIONS[stationKey];
  const start = nyParts(new Date(Date.now() - 60 * 60 * 1000));
  const begin = `${start.y}${start.m}${start.d} ${start.h}:${start.min}`;

  const [obs, pred] = await Promise.all([
    fetchJson(noaaUrl(station.id, { product: 'water_level', date: 'latest' })).catch(() => null),
    fetchJson(noaaUrl(station.id, { product: 'predictions', begin_date: begin, range: '49' })),
  ]);
  if (pred.error) throw new Error(pred.error.message);

  const predictions = pred.predictions.map((p) => ({ t: p.t, v: parseFloat(p.v) }));
  const latestRow = obs && obs.data && obs.data[0];
  const latest = latestRow && latestRow.v !== '' ? { t: latestRow.t, v: parseFloat(latestRow.v) } : null;

  let predictedAtObs = null;
  if (latest) {
    const target = noaaMinutes(latest.t);
    let best = Infinity;
    for (const p of predictions) {
      const diff = Math.abs(noaaMinutes(p.t) - target);
      if (diff < best) {
        best = diff;
        predictedAtObs = p.v;
      }
    }
    if (best > 30) predictedAtObs = null;
  }

  const surge = latest && predictedAtObs != null ? Math.round((latest.v - predictedAtObs) * 100) / 100 : null;
  return {
    station,
    stationKey,
    thresholds: thresholdsFromGreatDiurnalRange(station.greatDiurnalRangeFt),
    latest,
    surge,
    predictions,
    peak: peakWaterLevel(
      predictions.map((p) => p.v),
      latest ? latest.v : null,
      predictedAtObs,
    ),
  };
}

// ---------------- Open-Meteo weather ----------------

const WEATHER_VARS = ['precipitation', 'temperature_2m', 'relative_humidity_2m', 'wind_speed_10m', 'wind_gusts_10m', 'weather_code'];

/** Index of the current hour in an hourly time axis ("2026-09-28T14:00" strings). */
export function hourIndex(times, nowKey) {
  let now = times.indexOf(nowKey);
  if (now < 0) now = times.findIndex((t) => t > nowKey);
  if (now < 0) now = times.length - 1;
  return now;
}

function maxBy(rows, key) {
  let best = null;
  for (const r of rows) if (r[key] != null && (best == null || r[key] > best[key])) best = r;
  return best;
}

/**
 * Boil an Open-Meteo hourly block down to what the risk models need for the
 * next 48 hours: rain (peak rate, totals), heat (peak heat index, overnight low)
 * and wind (peak gust and sustained speed, thunderstorm codes).
 */
export function summarizeWeather(hourly, nowKey) {
  const times = hourly.time;
  const now = hourIndex(times, nowKey);
  const at = (name, i) => (hourly[name] && hourly[name][i] != null ? hourly[name][i] : null);
  const rows = [];
  for (let i = now; i < Math.min(times.length, now + 48); i++) {
    const temp = at('temperature_2m', i);
    const rh = at('relative_humidity_2m', i);
    rows.push({
      t: times[i],
      precip: at('precipitation', i) ?? 0,
      temp,
      rh,
      hi: temp != null && rh != null ? heatIndexF(temp, rh) : null,
      wind: at('wind_speed_10m', i),
      gust: at('wind_gusts_10m', i),
      code: at('weather_code', i),
    });
  }
  let past24 = 0;
  for (let i = Math.max(0, now - 24); i < now; i++) past24 += at('precipitation', i) ?? 0;

  const rain = maxBy(rows, 'precip');
  const heat = maxBy(rows, 'hi');
  const gust = maxBy(rows, 'gust');
  const wind = maxBy(rows, 'wind');
  const hot = maxBy(rows, 'temp');
  const nights = rows.filter((r) => r.temp != null && +r.t.slice(11, 13) <= 7);
  const lows = (nights.length ? nights : rows.filter((r) => r.temp != null)).map((r) => r.temp);

  return {
    hourly: rows,
    maxHourly: rain && rain.precip > 0 ? round2(rain.precip) : 0,
    maxHourlyTime: rain && rain.precip > 0 ? rain.t : null,
    next48Total: round2(rows.reduce((s, r) => s + r.precip, 0)),
    past24: round2(past24),
    maxHeatIndex: heat ? heat.hi : null,
    maxHeatIndexTime: heat ? heat.t : null,
    maxTemp: hot ? hot.temp : null,
    overnightLow: lows.length ? Math.min(...lows) : null,
    maxGust: gust ? gust.gust : null,
    maxGustTime: gust ? gust.t : null,
    maxWind: wind ? wind.wind : null,
    weatherCodes: [...new Set(rows.map((r) => r.code).filter((c) => c != null))],
  };
}

/** Next 48 h of weather for many points in one request, one summary per point. */
export async function fetchWeather(points) {
  const q = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(4)).join(','),
    longitude: points.map((p) => p.lon.toFixed(4)).join(','),
    hourly: WEATHER_VARS.join(','),
    precipitation_unit: 'inch',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    timezone: NY_TZ,
    past_days: '1',
    forecast_days: '3',
  });
  const json = await fetchJson(`https://api.open-meteo.com/v1/forecast?${q}`);
  const list = Array.isArray(json) ? json : [json];
  const nowKey = nyHourKey();
  return list.map((loc) => summarizeWeather(loc.hourly, nowKey));
}

// ---------------- Open-Meteo air quality ----------------

const AIR_VARS = ['us_aqi', 'us_aqi_pm2_5', 'us_aqi_ozone', 'pm2_5', 'ozone'];

/** Current and peak US AQI over the next 48 h, plus which pollutant drives it. */
export function summarizeAir(hourly, nowKey) {
  const times = hourly.time;
  const now = hourIndex(times, nowKey);
  const at = (name, i) => (hourly[name] && hourly[name][i] != null ? hourly[name][i] : null);
  const rows = [];
  for (let i = now; i < Math.min(times.length, now + 48); i++) {
    rows.push({ t: times[i], aqi: at('us_aqi', i), aqiPm: at('us_aqi_pm2_5', i), aqiO3: at('us_aqi_ozone', i), pm25: at('pm2_5', i), ozone: at('ozone', i) });
  }
  const current = rows.find((r) => r.aqi != null) || null;
  const peak = maxBy(rows, 'aqi');
  const ref = peak || current;
  const dominant = ref && (ref.aqiO3 ?? -1) > (ref.aqiPm ?? -1) ? 'ozone' : 'pm2_5';
  return {
    hourly: rows,
    currentAqi: current ? current.aqi : null,
    peakAqi: peak ? peak.aqi : null,
    peakAqiTime: peak ? peak.t : null,
    pm25: current ? current.pm25 : null,
    ozone: current ? current.ozone : null,
    dominant,
  };
}

/** Air quality forecast for many points in one request, one summary per point. */
export async function fetchAirQuality(points) {
  const q = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(4)).join(','),
    longitude: points.map((p) => p.lon.toFixed(4)).join(','),
    hourly: AIR_VARS.join(','),
    timezone: NY_TZ,
    forecast_days: '3',
  });
  const json = await fetchJson(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}`);
  const list = Array.isArray(json) ? json : [json];
  const nowKey = nyHourKey();
  const summaries = list.map((loc) => summarizeAir(loc.hourly, nowKey));
  // If the API answered for a single point only, use it citywide.
  return points.map((_, i) => summaries[i] || summaries[0]);
}

// ---------------- NWS alerts ----------------

/** Active NWS alerts that cover at least one NYC borough. */
export async function fetchAlerts() {
  const json = await fetchJson('https://api.weather.gov/alerts/active?area=NY', {
    headers: { Accept: 'application/geo+json' },
  });
  return parseAlerts(json);
}

export function parseAlerts(json) {
  const all = [];
  for (const f of json.features || []) {
    const p = f.properties || {};
    const same = (p.geocode && p.geocode.SAME) || [];
    const boroughs = Object.entries(BOROUGH_SAME)
      .filter(([, code]) => same.includes(code))
      .map(([b]) => b);
    if (boroughs.length === 0 || !p.event) continue;
    all.push({ event: p.event, headline: p.headline || p.event, ends: p.ends || p.expires || null, boroughs });
  }
  return all;
}

// ---------------- NYC 311 ----------------

const SOCRATA_311 = 'https://data.cityofnewyork.us/resource/erm2-nwe9.json';

function socrataHeaders() {
  return NYC_OPEN_DATA_APP_TOKEN ? { 'X-App-Token': NYC_OPEN_DATA_APP_TOKEN } : {};
}

/** Socrata "floating timestamp" in NY local time, e.g. 2026-09-21T00:00:00 */
function socrataDaysAgo(days) {
  const p = nyParts(new Date(Date.now() - days * 86400000));
  return `${p.y}-${p.m}-${p.d}T${p.h}:${p.min}:00`;
}

/** 311 flooding reports citywide in the last `days` days. */
export async function fetchRecent311(days = 7) {
  const q = new URLSearchParams({
    $select: 'unique_key,created_date,descriptor,incident_address,borough,latitude,longitude',
    $where: `${FLOOD_311_WHERE} AND created_date > '${socrataDaysAgo(days)}' AND latitude IS NOT NULL`,
    $order: 'created_date DESC',
    $limit: '3000',
  });
  const rows = await fetchJson(`${SOCRATA_311}?${q}`, { headers: socrataHeaders() });
  return rows.map((r) => ({
    id: r.unique_key,
    created: r.created_date,
    descriptor: r.descriptor,
    address: r.incident_address || '',
    borough: r.borough,
    lat: parseFloat(r.latitude),
    lon: parseFloat(r.longitude),
  }));
}

/** Count of 311 flooding reports within `meters` of a point over the past year. */
export async function fetch311History(lat, lon, meters = 500) {
  const q = new URLSearchParams({
    $select: 'count(*) as n',
    $where: `${FLOOD_311_WHERE} AND created_date > '${socrataDaysAgo(365)}' AND within_circle(location, ${lat}, ${lon}, ${meters})`,
  });
  const rows = await fetchJson(`${SOCRATA_311}?${q}`, { headers: socrataHeaders() });
  return rows.length ? parseInt(rows[0].n, 10) : 0;
}

// ---------------- Hurricane evacuation (NYC Emergency Management) ----------------

const EVAC_ZONES = 'https://data.cityofnewyork.us/resource/epne-qv9x.json';
const EVAC_CENTERS = 'https://data.cityofnewyork.us/resource/p5md-weyf.json';

/** Hurricane evacuation zone ('1'–'6') at a point, or null outside every zone. */
export async function fetchEvacuationZone(lat, lon) {
  const q = new URLSearchParams({
    $select: 'hurricane_',
    $where: `intersects(the_geom, 'POINT(${lon.toFixed(6)} ${lat.toFixed(6)})')`,
  });
  const rows = await fetchJson(`${EVAC_ZONES}?${q}`, { headers: socrataHeaders(), timeoutMs: 12000 });
  return parseEvacuationZone(rows);
}

export function parseEvacuationZone(rows) {
  const zone = rows && rows[0] && String(rows[0].hurricane_ ?? '').trim();
  return /^[1-6]$/.test(zone) ? zone : null;
}

let centersLoad = null;
/** The city's ~60 hurricane evacuation centers, fetched once per visit. */
export function fetchEvacuationCenters() {
  centersLoad ||= fetchJson(`${EVAC_CENTERS}?$limit=500`, { headers: socrataHeaders(), timeoutMs: 12000 })
    .then(parseEvacuationCenters)
    .catch((err) => {
      centersLoad = null; // try again on the next address
      throw err;
    });
  return centersLoad;
}

export function parseEvacuationCenters(rows) {
  return (rows || [])
    .filter((r) => r.the_geom && r.the_geom.coordinates)
    .map((r) => ({
      name: r.bldg_name || 'Evacuation center',
      address: [r.bldg_add, r.city].filter(Boolean).join(', '),
      accessible: r.accessible === 'Y',
      lon: r.the_geom.coordinates[0],
      lat: r.the_geom.coordinates[1],
    }));
}

// ---------------- Address search ----------------

export async function geocode(text) {
  const q = new URLSearchParams({ text, size: '5' });
  const json = await fetchJson(`https://geosearch.planninglabs.nyc/v2/search?${q}`);
  return (json.features || []).map((f) => ({
    label: f.properties.label,
    borough: f.properties.borough,
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));
}

/** Nearest address label for a point, or null. */
export async function reverseGeocode(lat, lon) {
  const q = new URLSearchParams({ 'point.lat': lat.toFixed(6), 'point.lon': lon.toFixed(6), size: '1' });
  const json = await fetchJson(`https://geosearch.planninglabs.nyc/v2/reverse?${q}`, { timeoutMs: 8000 });
  const f = (json.features || [])[0];
  return f ? { label: f.properties.label, borough: f.properties.borough } : null;
}

// ---------------- FEMA flood zone ----------------

/** FEMA National Flood Hazard Layer zone at a point, e.g. { zone: 'AE', subtype: null }. */
export async function fetchFemaZone(lat, lon) {
  const q = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'FLD_ZONE,ZONE_SUBTY,STATIC_BFE',
    returnGeometry: 'false',
    f: 'json',
  });
  const json = await fetchJson(`${FEMA_NFHL}/${FEMA_FLOOD_ZONE_LAYER}/query?${q}`);
  if (json.error) throw new Error(json.error.message);
  const attrs = json.features && json.features[0] && json.features[0].attributes;
  if (!attrs) return { zone: null, subtype: null, bfe: null };
  const bfe = attrs.STATIC_BFE != null && attrs.STATIC_BFE > -9999 ? attrs.STATIC_BFE : null;
  return { zone: attrs.FLD_ZONE, subtype: attrs.ZONE_SUBTY, bfe };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
