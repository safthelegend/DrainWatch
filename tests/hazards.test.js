// Tests for the heat, air quality and wind & storm models.
// Run with:  node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessHeat, classifyHeatAlert, heatHazard, heatIndexF, vulnerabilityFactor, warmNightBoost } from '../js/heat-risk.js';
import { aqiCategory, aqiFromPm25, aqiHazard, assessAir, classifyAirAlert } from '../js/air-risk.js';
import { assessStorm, classifyWindAlert, thunderHazard, windHazard } from '../js/storm-risk.js';
import { alertSeverity, classifyAlert } from '../js/risk.js';

// ---------------- heat ----------------

test('heat index matches the NWS heat index chart', () => {
  // Values from the NWS heat index table, which rounds to the nearest degree.
  assert.ok(Math.abs(heatIndexF(90, 50) - 95) <= 1, `90°F/50% → ${heatIndexF(90, 50)}`);
  assert.ok(Math.abs(heatIndexF(96, 50) - 108) <= 1, `96°F/50% → ${heatIndexF(96, 50)}`);
  assert.ok(Math.abs(heatIndexF(100, 40) - 109) <= 1, `100°F/40% → ${heatIndexF(100, 40)}`);
  assert.ok(Math.abs(heatIndexF(84, 90) - 98) <= 2, `84°F/90% (humid adjustment) → ${heatIndexF(84, 90)}`);
});

test('heat index stays close to the air temperature when it is mild', () => {
  assert.ok(Math.abs(heatIndexF(70, 50) - 69.3) < 1);
  assert.equal(heatIndexF(null, 50), null);
});

test('heat hazard follows NWS New York advisory and warning criteria', () => {
  assert.equal(heatHazard(null), 0);
  assert.equal(heatHazard(75), 0);
  assert.equal(heatHazard(85), 1);
  assert.equal(heatHazard(95), 2);
  assert.equal(heatHazard(101), 3);
  assert.equal(heatHazard(110), 4);
});

test('warm nights and vulnerability raise heat risk', () => {
  assert.equal(warmNightBoost(70), 0);
  assert.equal(warmNightBoost(77), 0.25);
  assert.equal(warmNightBoost(82), 0.5);
  assert.ok(vulnerabilityFactor(5) > vulnerabilityFactor(1));

  const day = { maxHeatIndex: 98, overnightLow: 72, alerts: [] };
  const lowHvi = assessHeat({ ...day, hvi: 1 });
  const highHvi = assessHeat({ ...day, hvi: 5 });
  assert.ok(highHvi.score > lowHvi.score, 'same heat is more dangerous in a high-HVI neighborhood');
  assert.equal(lowHvi.level, 'elevated');
  assert.equal(highHvi.level, 'high');
});

test('a cool day is low heat risk everywhere', () => {
  const r = assessHeat({ hvi: 5, maxHeatIndex: 62, overnightLow: 50, alerts: [] });
  assert.equal(r.level, 'low');
  assert.equal(r.driver, 'none');
});

test('an extreme heat warning in a vulnerable neighborhood is severe', () => {
  const r = assessHeat({
    hvi: 5,
    maxHeatIndex: 107,
    overnightLow: 81,
    alerts: [{ event: 'Extreme Heat Warning', severity: 'warning' }],
  });
  assert.equal(r.level, 'severe');
  assert.ok(r.reasons.some((x) => x.includes('Extreme Heat Warning')));
});

// ---------------- air ----------------

test('PM2.5 converts to AQI with the EPA breakpoints', () => {
  assert.equal(aqiFromPm25(0), 0);
  assert.equal(aqiFromPm25(9.0), 50);
  assert.equal(aqiFromPm25(9.1), 51);
  assert.equal(aqiFromPm25(35.4), 100);
  assert.equal(aqiFromPm25(55.5), 151);
  assert.equal(aqiFromPm25(225.5), 301);
  assert.equal(aqiFromPm25(900), 500);
  assert.equal(aqiFromPm25(null), null);
});

test('AQI categories and hazard bands line up', () => {
  assert.equal(aqiCategory(42), 'Good');
  assert.equal(aqiCategory(101), 'Unhealthy for sensitive groups');
  assert.equal(aqiCategory(420), 'Hazardous');
  assert.equal(aqiHazard(50), 0);
  assert.equal(aqiHazard(51), 1);
  assert.equal(aqiHazard(151), 3);
  assert.equal(aqiHazard(301), 4);
});

test('asthma burden moves a neighborhood up once air is not good', () => {
  const air = { currentAqi: 80, peakAqi: 120, dominant: 'ozone', alerts: [] };
  const low = assessAir({ ...air, asthma: 1 });
  const high = assessAir({ ...air, asthma: 5 });
  assert.equal(low.score, 2);
  assert.equal(high.score, 2.5);
  assert.ok(high.reasons.some((x) => x.includes('asthma')));

  const clean = assessAir({ asthma: 5, currentAqi: 20, peakAqi: 35, dominant: 'pm2_5', alerts: [] });
  assert.equal(clean.score, 0, 'clean air gets no asthma bump');
  assert.equal(clean.level, 'low');
});

test('missing air data is reported, not treated as clean air', () => {
  const r = assessAir({ asthma: 3, currentAqi: null, peakAqi: null, alerts: [] });
  assert.equal(r.aqi, null);
  assert.deepEqual(r.reasons, ['No air quality data']);
});

// ---------------- wind & storms ----------------

test('wind hazard uses NWS wind advisory and high wind warning criteria', () => {
  assert.equal(windHazard(20), 0);
  assert.equal(windHazard(35), 1);
  assert.equal(windHazard(50), 2);
  assert.equal(windHazard(60), 3);
  assert.equal(windHazard(80), 4);
  assert.equal(windHazard(30, 42), 3, 'sustained 40+ mph is high-wind-warning level on its own');
  assert.equal(windHazard(null, null), 0);
});

test('thunderstorm weather codes count as a hazard', () => {
  assert.equal(thunderHazard([1, 2, 3]), 0);
  assert.equal(thunderHazard([61, 95]), 1);
  assert.equal(thunderHazard([96]), 2);
  assert.equal(thunderHazard(undefined), 0);
});

test('exposed shorelines feel the same storm more', () => {
  const storm = { maxGust: 50, maxSustained: 30, weatherCodes: [], alerts: [] };
  const sheltered = assessStorm({ ...storm, windExposure: 1 });
  const shore = assessStorm({ ...storm, windExposure: 3 });
  assert.ok(shore.score > sheltered.score);
  assert.equal(sheltered.level, 'elevated');
  assert.equal(shore.level, 'high');
});

test('a calm day is low wind risk', () => {
  const r = assessStorm({ windExposure: 3, maxGust: 18, maxSustained: 9, weatherCodes: [0, 1], alerts: [] });
  assert.equal(r.level, 'low');
  assert.equal(r.driver, 'none');
});

// ---------------- alerts ----------------

test('NWS alerts are sorted into the right hazard and tier', () => {
  assert.equal(alertSeverity('Flash Flood Emergency'), 'emergency');
  assert.deepEqual(classifyAlert('Flash Flood Emergency'), { kind: 'stormwater', severity: 'emergency' });
  assert.deepEqual(classifyHeatAlert('Heat Advisory'), { severity: 'advisory' });
  assert.deepEqual(classifyHeatAlert('Extreme Heat Warning'), { severity: 'warning' });
  assert.equal(classifyHeatAlert('Wind Advisory'), null);
  assert.deepEqual(classifyAirAlert('Air Quality Alert'), { severity: 'statement' });
  assert.deepEqual(classifyWindAlert('High Wind Warning'), { severity: 'warning' });
  assert.deepEqual(classifyWindAlert('Tornado Warning'), { severity: 'emergency' });
  assert.equal(classifyWindAlert('Coastal Flood Advisory'), null);
});
