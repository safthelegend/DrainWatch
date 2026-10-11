// Historical replays and sea level rise run through the same model as live data.
// Run with:  node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AREAS } from '../js/config.js';
import { assessAll, citySummary } from '../js/hazards.js';
import { buildScenario, relativeHumidity, SCENARIOS, scenariosFor, SEA_LEVEL_STOPS, withSeaLevelRise } from '../js/scenarios.js';

const byId = (results, id) => results.find((r) => r.area.id === id);

test('every replay builds data for every neighborhood', () => {
  for (const s of SCENARIOS) {
    const inputs = buildScenario(s.id);
    assert.equal(inputs.weather.length, AREAS.length, s.id);
    assert.equal(inputs.air.length, AREAS.length, s.id);
    assert.equal(Object.keys(inputs.tides).length, 4, s.id);
    for (const hazard of s.hazards) {
      const results = assessAll(hazard, inputs);
      assert.ok(results.every((r) => r.missing.length === 0), `${s.id}/${hazard} has no missing data`);
    }
  }
});

test('Sandy floods the coast but spares inland neighborhoods', () => {
  const results = assessAll('floods', buildScenario('sandy'));
  for (const id of ['red-hook', 'rockaway', 'midland-beach', 'fidi']) assert.equal(byId(results, id).level, 'severe', id);
  for (const id of ['park-slope', 'fordham', 'riverdale']) assert.equal(byId(results, id).level, 'low', id);
  assert.equal(byId(results, 'red-hook').driver, 'coastal');
});

test('Ida is a stormwater disaster: the inland Queens neighborhoods hit hardest rate severe', () => {
  const inputs = buildScenario('ida');
  assert.equal(Math.max(...inputs.weather.map((w) => w.maxHourly)), 3.15);
  const results = assessAll('floods', inputs);
  for (const id of ['woodside', 'hollis', 'forest-hills', 'east-elmhurst']) {
    assert.equal(byId(results, id).level, 'severe', id);
    assert.equal(byId(results, id).driver, 'stormwater', id);
  }
  assert.ok(byId(results, 'woodside').reasons.some((r) => r.includes('Flash Flood Emergency')));
});

test('the 2019 heat wave is worst where heat vulnerability is highest', () => {
  const results = assessAll('heat', buildScenario('heat-2019'));
  assert.equal(byId(results, 'mott-haven').level, 'severe');
  assert.ok(byId(results, 'mott-haven').score > byId(results, 'park-slope').score);
  assert.ok(byId(results, 'brownsville').score > byId(results, 'forest-hills').score);
});

test('the 2023 smoke replay reaches hazardous AQI', () => {
  const inputs = buildScenario('smoke-2023');
  const summary = citySummary('air', assessAll('air', inputs), inputs);
  assert.ok(Math.max(...inputs.air.map((a) => a.peakAqi)) > 300);
  assert.equal(summary.counts.severe, AREAS.length);
  assert.equal(summary.kpis[1].note.startsWith('Hazardous'), true);
});

test('Isaias hits exposed shorelines harder than sheltered streets', () => {
  const results = assessAll('wind', buildScenario('isaias'));
  assert.ok(byId(results, 'rockaway').score > byId(results, 'central-harlem').score);
});

test('sea level rise turns an ordinary high tide into a flood', () => {
  const base = buildScenario('heat-2019'); // calm tides, no flood alerts
  const calm = { ...base, alerts: [] };
  const counts = SEA_LEVEL_STOPS.map((stop) => {
    const results = assessAll('floods', { ...calm, tides: withSeaLevelRise(calm.tides, stop.inches) });
    return results.filter((r) => r.level !== 'low').length;
  });
  assert.equal(counts[0], 0, 'no flooding today on a calm day');
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] >= counts[i - 1], `rise ${i} never lowers risk`);
  assert.ok(counts[counts.length - 1] > 10, 'by 2100 a normal high tide floods many neighborhoods');
});

test('sea level rise shifts every water level and leaves the original untouched', () => {
  const { tides } = buildScenario('sandy');
  const raised = withSeaLevelRise(tides, 12);
  assert.equal(raised.battery.peak, Math.round((tides.battery.peak + 1) * 100) / 100);
  assert.equal(raised.battery.predictions[10].v, tides.battery.predictions[10].v + 1);
  assert.equal(withSeaLevelRise(tides, 0), tides);
  assert.equal(tides.battery.seaLevelRiseFt, undefined);
});

test('each hazard tab offers at least one replay', () => {
  for (const hazard of ['floods', 'heat', 'air', 'wind']) assert.ok(scenariosFor(hazard).length >= 1, hazard);
});

test('relative humidity from dew point', () => {
  assert.equal(relativeHumidity(70, 70), 100);
  assert.ok(Math.abs(relativeHumidity(95, 73) - 49) <= 2);
});
