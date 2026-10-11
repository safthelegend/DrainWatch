// Data-layer parsing with a fake fetch, so no network is needed.
// Run with:  node --test

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchAirQuality,
  fetchAlerts,
  fetchTides,
  fetchWeather,
  hourIndex,
  nyHourKey,
  parseAlerts,
  summarizeAir,
  summarizeWeather,
} from '../js/data.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replace fetch with one that answers from `routes` (url substring → JSON body). */
function fakeFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[key] };
  };
  return calls;
}

function hours(startKey, n) {
  const start = Date.parse(startKey + ':00Z');
  return Array.from({ length: n }, (_, i) => new Date(start + i * 3600e3).toISOString().slice(0, 16));
}

test('hourIndex finds the current hour or the next one', () => {
  const t = ['2026-07-01T10:00', '2026-07-01T11:00', '2026-07-01T12:00'];
  assert.equal(hourIndex(t, '2026-07-01T11:00'), 1);
  assert.equal(hourIndex(t, '2026-07-01T11:30'), 2);
  assert.equal(hourIndex(t, '2026-07-02T00:00'), 2);
  assert.match(nyHourKey(new Date('2026-07-01T15:20:00Z')), /^2026-07-01T11:00$/);
});

test('summarizeWeather finds peaks, totals and the overnight low', () => {
  const time = hours('2026-07-01T00:00', 72);
  const now = '2026-07-02T00:00'; // index 24
  const hourly = {
    time,
    precipitation: time.map((_, i) => (i === 10 ? 0.5 : i === 30 ? 1.2 : 0.1)),
    temperature_2m: time.map((t) => (+t.slice(11, 13) === 15 ? 95 : +t.slice(11, 13) === 5 ? 78 : 85)),
    relative_humidity_2m: time.map(() => 50),
    wind_speed_10m: time.map(() => 10),
    wind_gusts_10m: time.map((_, i) => (i === 40 ? 52 : 20)),
    weather_code: time.map((_, i) => (i === 41 ? 95 : 1)),
  };
  const s = summarizeWeather(hourly, now);
  assert.equal(s.hourly.length, 48);
  assert.equal(s.maxHourly, 1.2);
  assert.equal(s.maxHourlyTime, time[30]);
  assert.equal(s.past24, Math.round((0.5 + 23 * 0.1) * 100) / 100);
  assert.equal(s.maxTemp, 95);
  assert.equal(s.overnightLow, 78);
  assert.ok(s.maxHeatIndex > 95, 'humid 95°F feels hotter');
  assert.equal(s.maxGust, 52);
  assert.deepEqual(s.weatherCodes.sort(), [1, 95]);
});

test('summarizeAir picks current and peak AQI and the dominant pollutant', () => {
  const time = hours('2026-06-07T00:00', 48);
  const hourly = {
    time,
    us_aqi: time.map((_, i) => 40 + i),
    us_aqi_pm2_5: time.map((_, i) => 40 + i),
    us_aqi_ozone: time.map(() => 30),
    pm2_5: time.map(() => 12),
    ozone: time.map(() => 60),
  };
  const s = summarizeAir(hourly, '2026-06-07T05:00');
  assert.equal(s.currentAqi, 45);
  assert.equal(s.peakAqi, 87);
  assert.equal(s.dominant, 'pm2_5');
  assert.equal(s.pm25, 12);
});

test('fetchWeather asks Open-Meteo for every point in one request', async () => {
  const time = hours('2026-07-01T00:00', 96);
  const block = { hourly: { time, precipitation: time.map(() => 0), temperature_2m: time.map(() => 70), relative_humidity_2m: time.map(() => 40) } };
  const calls = fakeFetch({ 'api.open-meteo.com': [block, block] });
  const result = await fetchWeather([
    { lat: 40.7, lon: -74 },
    { lat: 40.8, lon: -73.9 },
  ]);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /latitude=40\.7000%2C40\.8000/);
  assert.match(calls[0], /temperature_unit=fahrenheit/);
  assert.equal(result.length, 2);
});

test('fetchAirQuality reuses a single answer citywide', async () => {
  const time = hours('2026-07-01T00:00', 72);
  fakeFetch({ 'air-quality-api.open-meteo.com': { hourly: { time, us_aqi: time.map(() => 30) } } });
  const result = await fetchAirQuality([
    { lat: 40.7, lon: -74 },
    { lat: 40.8, lon: -73.9 },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[1].currentAqi, 30);
});

test('fetchTides adds the current surge to the predicted peak', async () => {
  fakeFetch({
    'product=water_level': { data: [{ t: '2026-10-01 12:00', v: '1.500' }] },
    'product=predictions': {
      predictions: [
        { t: '2026-10-01 12:00', v: '1.000' },
        { t: '2026-10-01 18:00', v: '-4.000' },
        { t: '2026-10-02 00:30', v: '1.200' },
      ],
    },
  });
  const tide = await fetchTides('battery');
  assert.equal(tide.surge, 0.5);
  assert.equal(tide.peak, 1.7);
  assert.equal(tide.thresholds.minor > 1, true);
});

test('fetch failures surface as errors so the app can flag the source', async () => {
  fakeFetch({});
  await assert.rejects(fetchAlerts(), /404/);
});

test('alerts outside the five boroughs are dropped', () => {
  const json = {
    features: [
      { properties: { event: 'Coastal Flood Warning', headline: 'CFW', geocode: { SAME: ['036061', '036047'] } } },
      { properties: { event: 'Lake Effect Snow Warning', geocode: { SAME: ['036029'] } } },
      { properties: { event: 'Heat Advisory', geocode: { SAME: ['036085'] }, ends: '2026-07-01T20:00:00-04:00' } },
    ],
  };
  const alerts = parseAlerts(json);
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts[0].boroughs, ['Manhattan', 'Brooklyn']);
  assert.equal(alerts[1].ends, '2026-07-01T20:00:00-04:00');
});
