// DrainWatch: wires live data, the replays, the risk models, the map, the
// dashboard cards and the 3D story together. State lives in one object; each
// render*() redraws its part of the page from it.

import { AREAS, HEAT_DRIVERS_URL, TIDE_STATIONS } from './config.js';
import {
  fetch311History,
  fetchAirQuality,
  fetchAlerts,
  fetchEvacZone,
  fetchFemaZone,
  fetchRecent311,
  fetchTides,
  fetchWeather,
  geocode,
  isExactAddress,
  reverseGeocode,
} from './data.js';
import { exposureFromComplaintHistory, exposureFromFemaZone, LEVELS, levelLabel } from './risk.js';
import { aqiCategory } from './air-risk.js';
import { HAZARDS, HAZARD_ORDER, assessAll, assessPlace, citySummary, hasData, nearestAreaIndex } from './hazards.js';
import {
  SEA_LEVEL_STOPS,
  SLR_MAX_INCHES,
  buildScenario,
  scenarioById,
  scenariosFor,
  seaLevelNote,
  seaLevelPeriod,
  seaLevelStopFor,
  withSeaLevelRise,
} from './scenarios.js';
import { attachChartHover } from './charts.js';
import {
  areaPopupHtml,
  compareHtml,
  detailsHtml,
  legendHtml,
  rankingRowsHtml,
  reportHtml,
  reportPinPopupHtml,
  stationPopupHtml,
  timeMachineDeltaHtml,
} from './panels.js';
import { initChecklist, renderMethodology, renderSeaLevel, renderSources, renderStoryTable } from './sections.js';
import { buildStory } from './story/stories.js';
import { createStoryController } from './story/controller.js';
import { HIGHER_GROUND_M, elevationAt, findHigherGround, floodByNta, floodRaster, floodStats, loadTerrain, ntaElevation, waterNavdMeters } from './terrain.js';
import * as mapView from './map.js';
import { esc } from './ui.js';

const REFRESH_MS = 15 * 60 * 1000;
const INCH_M = 0.0254;

const SOURCES = {
  tides: { name: 'NOAA Tides & Currents', url: 'https://tidesandcurrents.noaa.gov/' },
  weather: { name: 'Open-Meteo forecast', url: 'https://open-meteo.com/' },
  air: { name: 'Open-Meteo air quality', url: 'https://open-meteo.com/en/docs/air-quality-api' },
  alerts: { name: 'National Weather Service alerts', url: 'https://www.weather.gov/' },
  reports: { name: 'NYC 311 flooding reports', url: 'https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9' },
  fema: { name: 'FEMA flood zones', url: 'https://msc.fema.gov/portal/home' },
  evac: { name: 'NYC hurricane evacuation zones', url: 'https://maps.nyc.gov/hurricane/' },
  geosearch: { name: 'NYC GeoSearch', url: 'https://geosearch.planninglabs.nyc/' },
  terrain: { name: 'USGS 3DEP elevation (AWS Terrain Tiles)', url: 'https://registry.opendata.aws/terrain-tiles/' },
  buildings: { name: 'NYC Building Footprints (3D flood story)', url: 'https://data.cityofnewyork.us/d/5zhs-2jue' },
};

const COMPARE_PRESETS = [
  ['fidi', 'red-hook'],
  ['central-harlem', 'bpc'],
  ['rockaway', 'washington-heights'],
  ['hunts-point', 'park-slope'],
];

const state = {
  hazard: 'floods',
  scenario: 'live', // what the dashboard shows: live data or a replay
  slrInches: 0,
  live: { mode: 'live', tides: {}, weather: null, air: null, alerts: null, reports: null },
  liveLoaded: false,
  loading: false,
  updatedAt: null,
  status: {},
  selectedStation: 'battery',
  point: null, // { place, idx, fema, history, pointWeather, evac, loading, evacLoading }
  overlays: { flood: true, fema: false, reports: true, stations: true },
  heatDrivers: null,
  showAll: false,
  compare: { a: 'fidi', b: 'red-hook' },
};

const scenarioCache = new Map();
const $ = (id) => document.getElementById(id);
const tip = $('chart-tip');
const isLive = () => state.scenario === 'live';
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrow = () => window.matchMedia('(max-width: 980px)').matches;

let terrain = null; // elevation grid, once loaded
let ntaFeatures = []; // data/nyc-ntas.geojson features, once loaded

// ---------------- inputs ----------------

function baseInputs() {
  if (isLive()) return state.live;
  if (!scenarioCache.has(state.scenario)) scenarioCache.set(state.scenario, buildScenario(state.scenario));
  return scenarioCache.get(state.scenario);
}

/** Sea level rise only ever applies to the flood model. */
function inputsFor(hazard, inches = state.slrInches) {
  const base = baseInputs();
  if (hazard === 'floods' && inches) return { ...base, tides: withSeaLevelRise(base.tides, inches) };
  return base;
}

function liveSummary(hazard) {
  if (!state.liveLoaded || !hasData(hazard, state.live)) return null;
  return citySummary(hazard, assessAll(hazard, state.live), state.live);
}

// ---------------- the headline number for a hazard ----------------

function headlineNumber(hazard, inputs, summary, replay = false) {
  const when = replay ? '' : ' in the next 48 hours';
  const max = (list, key) => {
    const v = (list || []).map((x) => x && x[key]).filter((x) => x != null);
    return v.length ? Math.max(...v) : null;
  };
  if (hazard === 'heat') {
    const v = max(inputs.weather, 'maxHeatIndex');
    return v == null ? null : { value: Math.round(v), unit: '°F', label: replay ? 'feels like, at the peak' : 'feels like, at the peak of the next 48 hours' };
  }
  if (hazard === 'air') {
    const v = max(inputs.air, 'peakAqi');
    return v == null ? null : { value: Math.round(v), unit: '', label: `Air Quality Index at its peak, "${aqiCategory(v)}"` };
  }
  if (hazard === 'wind') {
    const v = max(inputs.weather, 'maxGust');
    return v == null ? null : { value: Math.round(v), unit: ' mph', label: `strongest gust${when}` };
  }
  if (summary && summary.worst.driver === 'stormwater') {
    const v = max(inputs.weather, 'maxHourly');
    return v == null ? null : { value: v.toFixed(2), unit: ' in/hr', label: `heaviest rain${when}` };
  }
  const v = max(Object.values(inputs.tides || {}), 'peak');
  return v == null ? null : { value: v.toFixed(1), unit: ' ft', label: `highest water above normal high tide${replay ? '' : ', next 48 hours'}` };
}

/** "Severe flood risk in 13 neighborhoods", or "… across the city" when it is everywhere. */
function riskTitle(hazard, summary) {
  const lvl = summary.worst.level;
  const n = summary.counts[lvl];
  const total = Object.values(summary.counts).reduce((a, b) => a + b, 0);
  const where = lvl === 'low' || n === total ? 'across the city' : `in ${n} neighborhood${n === 1 ? '' : 's'}`;
  return `${levelLabel(lvl)} ${HAZARDS[hazard].noun} risk ${where}`;
}

function setMega(el, num) {
  el.hidden = !num;
  el.innerHTML = num ? `<span class="mega-num">${esc(num.value)}</span><span class="mega-unit">${esc(num.unit.trim())}</span>` : '';
}

const stories = new Map();
function storyFor(h) {
  if (!stories.has(h)) stories.set(h, buildStory(h, { heatDrivers: state.heatDrivers }));
  return stories.get(h);
}

// ---------------- the dashboard ----------------

function renderApp() {
  const h = state.hazard;
  const inputs = inputsFor(h);
  const results = assessAll(h, inputs);
  const summary = citySummary(h, results, inputs);
  const pending = isLive() && !state.liveLoaded;
  const available = !pending && summary.available;
  const s = scenarioById(state.scenario);

  $('app-kicker').textContent = s ? `Replay · ${s.name}, ${s.date}` : `Right now · ${HAZARDS[h].label}`;
  const num = available ? headlineNumber(h, inputs, summary, Boolean(s)) : null;
  setMega($('app-mega'), num);
  $('app-mega-label').textContent = num ? num.label : pending ? 'Loading live data…' : '';

  let title;
  if (pending) title = 'Checking conditions across the city…';
  else if (!available) title = 'Live data is unavailable right now';
  else title = riskTitle(h, summary);
  $('app-title').textContent = title;
  $('app-dek').innerHTML = pending
    ? ''
    : available
      ? esc(summary.headline)
      : `We couldn't reach the live data feeds. Pick a replay in the Climate Time Machine to see how DrainWatch rates a real storm.`;
  $('app-context').textContent = s && available ? `${s.summary} Approximate reconstruction, run through today's risk model.` : '';
  renderAlsoLine();
  renderStoryCta();

  const delta = timeMachineDelta(results);
  renderTimeMachine(delta);
  renderMapData(results, inputs, available, delta);
  $('ranking').querySelector('tbody').innerHTML = rankingRowsHtml(results, available, { limit: state.showAll ? Infinity : 10 });
  $('ranking-more').hidden = state.showAll;
  $('ranking-more').textContent = `Show all ${results.length} neighborhoods`;
  $('ranking-note').textContent = available
    ? `${HAZARDS[h].title}${s ? '' : ' for the next 48 hours'}, highest first.${s ? ` Replaying ${s.name}.` : ''} Select a name to find it on the map.`
    : 'Ratings appear when data is available.';
  $('details').innerHTML = detailsHtml({ hazard: h, inputs, status: state.status, selectedStation: state.selectedStation, isLive: isLive(), pending });
  attachChartHover($('details'), tip);
  renderPoint();
  if ($('compare').open) renderCompare();
  renderSources(SOURCES, state.status);
  renderStatus();
  writeHash();
}

/** Lead with whatever is dangerous today, even on another hazard's tab. */
function renderAlsoLine() {
  const others = HAZARD_ORDER.filter((x) => x !== state.hazard)
    .map((x) => ({ x, s: liveSummary(x) }))
    .filter(({ s }) => s && (s.worst.level === 'high' || s.worst.level === 'severe'));
  $('also-line').hidden = !others.length;
  $('also-line').innerHTML = others.length
    ? `Also right now: ${others.map(({ x, s }) => `<a href="#${x}">${levelLabel(s.worst.level)} ${esc(HAZARDS[x].noun)} risk</a>`).join(', ')}`
    : '';
}

/** The story teaser: the replay's one big number and headline, and a way in. */
function renderStoryCta() {
  const st = storyFor(state.hazard);
  $('cta-kicker').textContent = `3D replay · ${st.scenarioMeta.name}, ${st.hero.kicker}`;
  $('cta-mega').innerHTML = `${esc(st.mega)}<small>${esc(st.hero.megaUnit.trim())} ${esc(st.hero.megaLabel)}</small>`;
  $('cta-head').textContent = st.headline;
}

function renderModes() {
  const options = [{ id: 'live', label: 'Live now' }, ...scenariosFor(state.hazard).map((s) => ({ id: s.id, label: s.name.includes(String(s.year)) ? s.name : `${s.name}, ${s.year}` }))];
  $('mode-list').innerHTML = options
    .map((o) => `<button type="button" role="radio" data-scenario="${o.id}" aria-checked="${o.id === state.scenario}" tabindex="${o.id === state.scenario ? 0 : -1}">${esc(o.label)}</button>`)
    .join('');
}

// ---------------- Climate Time Machine ----------------

function slrLabel(inches) {
  const stop = seaLevelStopFor(inches);
  if (stop) return stop.inches ? `${stop.label} middle estimate` : 'today';
  const period = seaLevelPeriod(inches);
  return period ? `within the ${period} range` : inches > 50 ? 'high-end scenario' : '';
}

/** What the sea level rise changes, compared with the same conditions at today's sea level. */
function timeMachineDelta(results) {
  if (state.hazard !== 'floods' || !state.slrInches) return null;
  if (isLive() && !state.liveLoaded) return null;
  const before = assessAll('floods', inputsFor('floods', 0));
  const rank = (lvl) => LEVELS.findIndex((l) => l.level === lvl);
  const count = (list) => Object.fromEntries(LEVELS.map((l) => [l.level, list.filter((r) => r.level === l.level).length]));
  const changes = results
    .map((r, i) => ({ id: r.area.id, name: r.area.name, from: before[i].level, to: r.level }))
    .filter((c) => rank(c.to) > rank(c.from))
    .sort((a, b) => rank(b.to) - rank(a.to) || a.name.localeCompare(b.name));
  const base = baseInputs().tides || {};
  const station = base.battery ? 'battery' : Object.keys(base)[0];
  const peakBefore = station ? base[station].peak : 0;
  const water = floodLevels();
  const wetter = landDelta(water);
  return {
    inches: state.slrInches,
    scenarioName: scenarioById(state.scenario)?.name || 'Today’s tides',
    stationName: station ? TIDE_STATIONS[station].name : 'the Battery',
    peakBefore,
    peakAfter: peakBefore + state.slrInches / 12,
    counts: { before: count(before), after: count(results) },
    changes,
    wetter,
    // outlined on the map: a higher risk level, or much more of the neighborhood under water
    raised: new Set([...changes.map((c) => c.id), ...wetter.filter((w) => w.addedShare >= WETTER_SHARE).map((w) => w.id)]),
    flood: terrain ? floodStats(terrain, water.baseM, water.waterM) : null,
  };
}

const WETTER_SHARE = 0.05;

/** Rated neighborhoods ranked by how much more of their land the extra rise puts under water. */
function landDelta({ baseM, waterM }) {
  if (!terrain || !ntaFeatures.length) return [];
  const { total, base, added } = floodByNta(terrain, baseM, waterM);
  const acc = {};
  ntaFeatures.forEach((f, i) => {
    for (const id of f.properties.areas) {
      acc[id] ||= { total: 0, base: 0, added: 0 };
      acc[id].total += total[i] || 0;
      acc[id].base += base[i] || 0;
      acc[id].added += added[i] || 0;
    }
  });
  return AREAS.filter((a) => acc[a.id] && acc[a.id].total)
    .map((a) => ({ id: a.id, name: a.name, baseShare: acc[a.id].base / acc[a.id].total, addedShare: acc[a.id].added / acc[a.id].total }))
    .filter((w) => w.addedShare >= 0.01)
    .sort((a, b) => b.addedShare - a.addedShare)
    .slice(0, 6);
}

/** Water levels for the flooded-land layer: the Battery's peak, without and with the extra rise. */
function floodLevels() {
  const tides = baseInputs().tides || {};
  const peakFt = tides.battery && tides.battery.peak != null ? tides.battery.peak : 0;
  const baseM = waterNavdMeters(peakFt);
  return { baseM, waterM: baseM + state.slrInches * INCH_M, peakFt };
}

function renderTimeMachine(delta) {
  renderModes();
  const floods = state.hazard === 'floods';
  $('slr').hidden = !floods;
  $('tm-preset').hidden = floods && state.scenario === 'sandy' && state.slrInches === 29;
  if (floods) {
    const range = $('slr-range');
    if (+range.value !== state.slrInches) range.value = state.slrInches;
    range.style.setProperty('--fill', `${(state.slrInches / SLR_MAX_INCHES) * 100}%`);
    const label = slrLabel(state.slrInches);
    $('slr-out').innerHTML = `+${state.slrInches} in${label ? ` <small>${esc(label)}</small>` : ''}`;
    $('slr-note').textContent = seaLevelNote(state.slrInches);
    $('slr-stops').innerHTML = SEA_LEVEL_STOPS.map(
      (stop) =>
        `<button type="button" data-inches="${stop.inches}" aria-pressed="${stop.inches === state.slrInches}">${esc(stop.label)}<small>${stop.inches ? `+${stop.inches}` : '0'}</small></button>`,
    ).join('');
  }
  $('tm-delta').innerHTML = delta ? timeMachineDeltaHtml(delta) : '';
  $('tm-delta').hidden = !delta;

  const s = scenarioById(state.scenario);
  const parts = [];
  if (s) parts.push(`Replay: <b>${esc(s.name)}</b> ${s.year}`);
  if (floods && state.slrInches) parts.push(`<b>+${state.slrInches} in</b> sea level`);
  $('tm-badge').hidden = !parts.length;
  $('tm-badge').innerHTML = parts.length ? `${parts.join(' · ')} <button type="button" class="link-btn" id="tm-reset">Back to live</button>` : '';
}

function renderMapData(results, inputs, available, delta) {
  const levels = {};
  if (available) for (const r of results) levels[r.area.id] = r.level;
  const byId = Object.fromEntries(results.map((r) => [r.area.id, r]));
  mapView.paintNtas(
    levels,
    (f, lvl) => {
      const names = f.properties.areas.map((id) => byId[id].area.name);
      if (names.length) return `${esc(names.join(' & '))} · ${lvl ? levelLabel(lvl) : 'no data'}`;
      return f.properties.park ? null : `${esc(f.properties.name)} · not rated`;
    },
    delta ? delta.raised : undefined,
  );
  const floods = state.hazard === 'floods';
  const floodOn = floods && state.overlays.flood && Boolean(terrain);
  $('legend').innerHTML = legendHtml({ flood: floodOn, slr: floodOn && state.slrInches > 0 });
  $('layers-box').hidden = !floods;
  for (const key of Object.keys(mapView.OVERLAYS)) mapView.setOverlay(key, floods && state.overlays[key]);
  if (floods) {
    mapView.drawReports(isLive() ? inputs.reports : [], reportPinPopupHtml);
    mapView.drawStations(inputs.tides, stationPopupHtml);
    if (terrain && !(isLive() && !state.liveLoaded)) {
      const { baseM, waterM } = floodLevels();
      const colors = floodColors();
      mapView.drawFlood(`${baseM.toFixed(3)}|${waterM.toFixed(3)}|${colors.base}`, () => floodRaster(terrain, baseM, waterM, colors));
    }
  }
}

/**
 * Flooded-land colors: slate (the theme's --flood-base) for land under water at
 * today's sea level, so it never reads as part of the blue risk ramp, and orange
 * for land that only the extra sea level rise floods.
 */
function floodColors() {
  const css = getComputedStyle(document.documentElement).getPropertyValue('--flood-base');
  const [r = 55, g = 70, b = 90, a = 0.6] = (css.match(/[\d.]+/g) || []).map(Number);
  return { base: [r, g, b, Math.round(a * 255)], added: [255, 110, 20, 215] };
}

function renderLayers() {
  $('layers').innerHTML =
    '<legend class="sr-only">Map layers</legend>' +
    Object.entries(mapView.OVERLAYS)
      .map(([key, o]) => `<label><input type="checkbox" data-overlay="${key}"${state.overlays[key] ? ' checked' : ''} /> ${esc(o.label)}</label>`)
      .join('');
}

function renderStatus() {
  const el = $('status');
  const s = scenarioById(state.scenario);
  const slr = state.hazard === 'floods' && state.slrInches ? ` + ${state.slrInches} in sea level` : '';
  if (s) el.innerHTML = `Map showing <b>${esc(s.short)} ${s.year}</b> replay${slr}`;
  else if (!state.liveLoaded) el.textContent = 'Connecting to live data…';
  else {
    const ok = ['tides', 'weather', 'air', 'alerts'].filter((k) => state.status[k] && state.status[k].ok).length;
    const time = state.updatedAt ? state.updatedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
    el.innerHTML = ok === 0 ? 'Live data offline' : `<b>Live</b> · updated ${time}${ok < 4 ? ' · some feeds down' : ''}${slr}`;
  }
}

// ---------------- routing ----------------

/** #heat, #floods/sandy, #floods/sandy/2080s, #floods/live/40in: shareable links into a view. */
function readHash() {
  const [hazard, scenario, slr] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (!HAZARD_ORDER.includes(hazard)) return false;
  state.hazard = hazard;
  state.scenario = scenario && scenariosFor(hazard).some((s) => s.id === scenario) ? scenario : 'live';
  const stop = SEA_LEVEL_STOPS.find((s) => s.id === slr);
  const inches = stop ? stop.inches : /^\d+in$/.test(slr || '') ? Math.min(SLR_MAX_INCHES, parseInt(slr, 10)) : 0;
  state.slrInches = hazard === 'floods' ? inches : 0;
  return true;
}

// debounced: dragging the sea level slider would otherwise rewrite the URL on every frame
let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const parts = [state.hazard];
    if (state.scenario !== 'live' || state.slrInches) parts.push(state.scenario);
    if (state.slrInches) parts.push(seaLevelStopFor(state.slrInches)?.id || `${state.slrInches}in`);
    const hash = `#${parts.join('/')}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }, 200);
}

async function setHazard(h) {
  const changed = h !== story.hazard;
  state.hazard = h;
  if (state.scenario !== 'live' && !scenariosFor(h).some((s) => s.id === state.scenario)) state.scenario = 'live';
  if (h !== 'floods') state.slrInches = 0;
  markHazard(h);
  renderApp();
  if (changed) {
    renderMethodology(h);
    checklist.select(h);
    renderStoryTable(storyFor(h));
    await story.setHazard(h, { heatDrivers: state.heatDrivers });
  }
}

// ---------------- live data ----------------

async function track(key, promise) {
  try {
    const value = await promise;
    state.status[key] = { ok: true };
    return value;
  } catch (err) {
    console.warn(`[DrainWatch] ${key} failed:`, err);
    state.status[key] = { ok: false, message: err.name === 'AbortError' ? 'timed out' : 'offline' };
    return null;
  }
}

async function loadLive() {
  if (state.loading) return;
  state.loading = true;
  const stationKeys = Object.keys(TIDE_STATIONS);
  const [tideList, weather, air, alerts, reports] = await Promise.all([
    track(
      'tides',
      Promise.allSettled(stationKeys.map(fetchTides)).then((results) => {
        if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
        return results;
      }),
    ),
    track('weather', fetchWeather(AREAS)),
    track('air', fetchAirQuality(AREAS)),
    track('alerts', fetchAlerts()),
    track('reports', fetchRecent311(7)),
  ]);
  const tides = {};
  if (tideList) {
    tideList.forEach((r, i) => {
      if (r.status === 'fulfilled') tides[stationKeys[i]] = r.value;
    });
    const missing = stationKeys.filter((k) => !tides[k]).map((k) => TIDE_STATIONS[k].name);
    if (missing.length) state.status.tides = { ok: true, message: `no data from ${missing.join(', ')}` };
  }
  state.live = { mode: 'live', tides, weather, air, alerts, reports };
  state.liveLoaded = true;
  state.loading = false;
  state.updatedAt = new Date();
  renderApp();
}

// ---------------- address checks and the safety quick-finder ----------------

let pointRequest = 0;

// Sandy's storm tide at the Battery, and the same storm on 2080s seas: the yardsticks for "ground here".
const SANDY_PEAK_FT = buildScenario('sandy').tides.battery.peak;
const FUTURE_STOP = SEA_LEVEL_STOPS.find((s) => s.id === '2080s');

async function checkPoint(place) {
  const id = ++pointRequest;
  const { lat, lon } = place;
  const idx = nearestAreaIndex(lat, lon);
  state.point = { place, idx, loading: true, evacLoading: true, fema: null, history: null, pointWeather: null, evac: null };
  mapView.showPoint(lat, lon);
  renderPoint();
  // bring the report into view: on phones it is below the map; on desktop the map stays put beside it
  const box = $('check').getBoundingClientRect();
  if (narrow() || box.top < 0 || box.top > window.innerHeight * 0.6) {
    $(narrow() ? 'report' : 'check').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  }

  // the evacuation zone answers on its own schedule, so it never holds up the risk table
  track('evac', fetchEvacZone(lat, lon)).then((evac) => {
    if (id !== pointRequest) return;
    Object.assign(state.point, { evac, evacLoading: false });
    renderPoint();
    renderSources(SOURCES, state.status);
  });

  const [fema, history, pointWeather, named] = await Promise.all([
    track('fema', fetchFemaZone(lat, lon)),
    fetch311History(lat, lon).catch(() => null),
    fetchWeather([{ lat, lon }])
      .then((list) => list[0])
      .catch(() => null),
    place.needsName ? reverseGeocode(lat, lon).catch(() => null) : Promise.resolve(null),
  ]);
  if (id !== pointRequest) return; // a newer check started
  if (named) Object.assign(place, { label: named.label, borough: named.borough || place.borough });
  Object.assign(state.point, { place, loading: false, fema, history, pointWeather });
  renderPoint();
  renderSources(SOURCES, state.status);
}

/** Elevation here, Sandy's yardsticks, and the nearest higher ground (cached per address). */
function pointTerrain(p) {
  if (!terrain) return null;
  if (p.terrain) return p.terrain;
  const sandyM = waterNavdMeters(SANDY_PEAK_FT);
  const futureM = sandyM + FUTURE_STOP.inches * INCH_M;
  const here = elevationAt(terrain, p.place.lat, p.place.lon);
  const onHighGround = Boolean(here && here.m >= HIGHER_GROUND_M);
  let higher = null;
  if (here && !onHighGround) {
    higher = findHigherGround(terrain, p.place.lat, p.place.lon);
    if (higher) higher.name = ntaFeatures[higher.nta]?.properties.name || '';
  }
  p.terrain = { here, higher, onHighGround, sandyM, futureM, futureLabel: `${FUTURE_STOP.label}`, safeM: HIGHER_GROUND_M };
  return p.terrain;
}

function pointReport() {
  const p = state.point;
  const area = AREAS[p.idx];
  const borough = p.place.borough || area.borough;
  const spot = { ...area, lat: p.place.lat, lon: p.place.lon, borough };
  const results = {};
  const available = {};
  for (const h of HAZARD_ORDER) {
    const inputs = inputsFor(h);
    available[h] = !(isLive() && !state.liveLoaded) && hasData(h, inputs);
    if (p.loading && h === 'floods') continue;
    const overrides = {};
    if (isLive() && p.pointWeather) overrides.weather = p.pointWeather;
    if (h === 'floods') {
      if (p.fema) overrides.coastalExposure = exposureFromFemaZone(p.fema.zone, p.fema.subtype);
      if (p.history != null) overrides.stormwaterExposure = exposureFromComplaintHistory(p.history);
    }
    results[h] = assessPlace(h, spot, inputs, p.idx, overrides);
  }
  return {
    place: p.place,
    borough,
    nearest: area,
    loading: p.loading,
    fema: p.fema,
    history: p.history,
    evac: p.evac,
    evacLoading: p.evacLoading,
    terrain: pointTerrain(p),
    stationName: TIDE_STATIONS[area.station].name,
    results,
    available,
  };
}

function renderPoint() {
  $('report').innerHTML = state.point ? reportHtml(pointReport(), state.hazard) : '';
}

function wireSearch(formId, inputId, resultsId) {
  const form = $(formId);
  const input = $(inputId);
  const results = $(resultsId);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    results.innerHTML = '<p>Searching…</p>';
    try {
      const matches = await geocode(text);
      state.status.geosearch = { ok: true };
      if (!matches.length) {
        results.innerHTML = '<p>No New York City address found. Try adding the borough.</p>';
        return;
      }
      // one match, or the first is exactly what was typed: check it now instead of asking
      if (matches.length === 1 || isExactAddress(text, matches[0].label, matches[0].borough)) {
        results.innerHTML = '';
        checkPoint(matches[0]);
        return;
      }
      results.innerHTML = `<ul aria-label="Matching addresses">${matches.map((m, i) => `<li><button type="button" data-i="${i}">${esc(m.label)}</button></li>`).join('')}</ul>`;
      results.querySelector('button').focus();
      results.querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', () => {
          results.innerHTML = '';
          checkPoint(matches[+b.dataset.i]);
        }),
      );
    } catch {
      state.status.geosearch = { ok: false, message: 'offline' };
      renderSources(SOURCES, state.status);
      results.innerHTML = "<p>Address search isn't responding right now. You can click any spot on the map instead.</p>";
    }
  });
  input.addEventListener('input', () => {
    if (!input.value) results.innerHTML = '';
  });
}

// ---------------- neighborhood vs. neighborhood ----------------

function areaElevation(area) {
  if (!terrain) return null;
  const ntas = ntaFeatures.map((f, i) => (f.properties.areas.includes(area.id) ? i : -1)).filter((i) => i >= 0);
  const sandyM = waterNavdMeters(SANDY_PEAK_FT);
  const futureM = sandyM + FUTURE_STOP.inches * INCH_M;
  const sandy = ntaElevation(terrain, ntas, sandyM);
  if (!sandy) {
    const here = elevationAt(terrain, area.lat, area.lon);
    return here ? { medianM: here.m, shareSandy: here.m < sandyM ? 1 : 0, shareFuture: here.m < futureM ? 1 : 0 } : null;
  }
  return { medianM: sandy.medianM, shareSandy: sandy.shareBelow, shareFuture: ntaElevation(terrain, ntas, futureM).shareBelow };
}

function compareSide(id) {
  const i = AREAS.findIndex((a) => a.id === id);
  const area = AREAS[i];
  const results = {};
  const available = {};
  for (const h of HAZARD_ORDER) {
    const inputs = inputsFor(h);
    available[h] = !(isLive() && !state.liveLoaded) && hasData(h, inputs);
    results[h] = assessPlace(h, area, inputs, i);
  }
  return { area, results, available, elev: areaElevation(area) };
}

function renderCompare() {
  const s = scenarioById(state.scenario);
  const slr = state.slrInches ? ` · flood risk with +${state.slrInches} in sea level` : '';
  $('compare-mode').textContent = `${s ? `Replay · ${s.name}, ${s.year}` : 'Live now'}${slr}`;
  $('compare-a').value = state.compare.a;
  $('compare-b').value = state.compare.b;
  $('compare-presets').innerHTML =
    '<span class="label">Try</span>' +
    COMPARE_PRESETS.map(([a, b]) => {
      const name = (id) => AREAS.find((x) => x.id === id).name.split(' / ')[0];
      const on = state.compare.a === a && state.compare.b === b;
      return `<button type="button" class="chip" data-a="${a}" data-b="${b}" aria-pressed="${on}">${esc(name(a))} vs. ${esc(name(b))}</button>`;
    }).join('');
  $('compare-body').innerHTML = compareHtml({
    a: compareSide(state.compare.a),
    b: compareSide(state.compare.b),
    futureLabel: FUTURE_STOP.label,
    elevLoading: !terrain,
  });
}

function openCompare(a, b) {
  if (a) state.compare = { a, b };
  const options = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island']
    .map((boro) => `<optgroup label="${boro}">${AREAS.filter((x) => x.borough === boro).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</optgroup>`)
    .join('');
  if (!$('compare-a').options.length) {
    $('compare-a').innerHTML = options;
    $('compare-b').innerHTML = options;
  }
  renderCompare();
  if (!$('compare').open) $('compare').showModal();
}

// ---------------- the 3D story ----------------

let lastFocus = null;
let stageStarted = false;

function prefersStills() {
  const q = new URLSearchParams(location.search);
  if (q.has('stills')) return true;
  if (q.has('3d')) return false;
  if (navigator.connection && navigator.connection.saveData) return true;
  if (navigator.deviceMemory && navigator.deviceMemory <= 2) return true;
  try {
    return !document.createElement('canvas').getContext('webgl2');
  } catch {
    return true;
  }
}

/** The 3D stage (Three.js, ~590 KB) loads the first time the story opens, never before. */
async function startStage() {
  if (stageStarted) return;
  stageStarted = true;
  if (prefersStills()) {
    story.useStills();
    return;
  }
  try {
    const { createStage } = await import('./story/stage.js');
    await story.attachStage(createStage);
  } catch (err) {
    console.warn('[DrainWatch] 3D failed to load', err);
    story.useStills();
  }
}

function openStory() {
  lastFocus = document.activeElement;
  $('story').hidden = false;
  document.body.classList.add('story-open');
  startStage();
  story.open();
  $('story-close').focus();
}

function closeStory() {
  story.close();
  $('story').hidden = true;
  document.body.classList.remove('story-open');
  lastFocus?.focus?.();
}

function onStoryPosition({ pos, chapter, playing }) {
  $('story-range').value = Math.round(pos * 1000);
  $('story-range').style.setProperty('--fill', `${(pos / 2) * 100}%`);
  $('story-side').dataset.chapter = chapter;
  for (const b of document.querySelectorAll('.chapter-tabs [data-chapter]')) {
    const on = b.dataset.chapter === chapter;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $('story-play').textContent = playing ? '❚❚ Pause' : '▶ Play';
  $('story-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

// ---------------- tabs ----------------

function selectTab(name, { focus = false } = {}) {
  for (const b of $('explore-tabs').querySelectorAll('[role="tab"]')) {
    const on = b.dataset.tab === name;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    $(b.getAttribute('aria-controls')).hidden = !on;
    if (on && focus) b.focus();
  }
}

// ---------------- events ----------------

$('mode-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-scenario]');
  if (!b) return;
  state.scenario = b.dataset.scenario;
  renderApp();
  $('mode-list').querySelector(`[data-scenario="${state.scenario}"]`).focus();
});
$('mode-list').addEventListener('keydown', (e) => {
  const buttons = [...$('mode-list').querySelectorAll('button')];
  const i = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
  const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1 }[e.key];
  if (next == null) return;
  e.preventDefault();
  buttons[(next + buttons.length) % buttons.length].click();
});

// the sea level slider redraws on every frame it moves, at most once per frame
let slrFrame = 0;
$('slr-range').addEventListener('input', (e) => {
  state.slrInches = +e.target.value;
  if (slrFrame) return;
  slrFrame = requestAnimationFrame(() => {
    slrFrame = 0;
    renderApp();
  });
});
$('slr-stops').addEventListener('click', (e) => {
  const b = e.target.closest('[data-inches]');
  if (!b) return;
  state.slrInches = +b.dataset.inches;
  renderApp();
});
$('tm-preset').addEventListener('click', () => {
  state.scenario = 'sandy';
  state.slrInches = FUTURE_STOP.inches;
  state.overlays.flood = true;
  renderLayers();
  setHazard('floods');
  mapView.fitCity();
});
$('time-machine').addEventListener('click', (e) => {
  const b = e.target.closest('.row-link');
  if (b) showArea(b.dataset.id);
});
$('tm-badge').addEventListener('click', (e) => {
  if (!e.target.closest('#tm-reset')) return;
  state.scenario = 'live';
  state.slrInches = 0;
  renderApp();
});

$('details').addEventListener('change', (e) => {
  if (e.target.id !== 'station-select') return;
  state.selectedStation = e.target.value;
  renderApp();
  $('station-select').focus();
});
$('layers').addEventListener('change', (e) => {
  const key = e.target.dataset.overlay;
  if (!key) return;
  state.overlays[key] = e.target.checked;
  renderApp();
});

function showArea(id) {
  const h = state.hazard;
  const inputs = inputsFor(h);
  const i = AREAS.findIndex((a) => a.id === id);
  const r = assessPlace(h, AREAS[i], inputs, i);
  const available = !(isLive() && !state.liveLoaded) && hasData(h, inputs);
  if (narrow()) $('map').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  mapView.flyTo(AREAS[i].lat, AREAS[i].lon);
  mapView.openPopupAt(AREAS[i].lat, AREAS[i].lon, areaPopupHtml(h, r, available));
}
$('ranking').addEventListener('click', (e) => {
  const b = e.target.closest('.row-link');
  if (b) showArea(b.dataset.id);
});
$('ranking-more').addEventListener('click', () => {
  state.showAll = true;
  renderApp();
});
$('report').addEventListener('click', (e) => {
  if (e.target.closest('#report-close')) {
    state.point = null;
    pointRequest++;
    mapView.clearPoint();
    renderPoint();
  } else if (e.target.closest('#refuge-show')) {
    const t = state.point && state.point.terrain;
    if (t && t.higher) {
      if (narrow()) $('map').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
      mapView.showRefuge(state.point.place, t.higher);
    }
  }
});

$('explore-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[role="tab"]');
  if (b) selectTab(b.dataset.tab);
});
$('explore-tabs').addEventListener('keydown', (e) => {
  const tabs = [...$('explore-tabs').querySelectorAll('[role="tab"]')];
  const i = tabs.findIndex((b) => b.getAttribute('aria-selected') === 'true');
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (next == null) return;
  e.preventDefault();
  selectTab(tabs[(next + tabs.length) % tabs.length].dataset.tab, { focus: true });
});
for (const b of document.querySelectorAll('[data-tab-link]')) {
  b.addEventListener('click', () => {
    selectTab(b.dataset.tabLink);
    $('explore').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  });
}

// compare
$('compare-open').addEventListener('click', () => openCompare());
$('compare-a').addEventListener('change', (e) => {
  state.compare.a = e.target.value;
  renderCompare();
});
$('compare-b').addEventListener('change', (e) => {
  state.compare.b = e.target.value;
  renderCompare();
});
$('compare-swap').addEventListener('click', () => {
  state.compare = { a: state.compare.b, b: state.compare.a };
  renderCompare();
});
$('compare-presets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  state.compare = { a: b.dataset.a, b: b.dataset.b };
  renderCompare();
});
$('compare-map').addEventListener('click', () => {
  const a = AREAS.find((x) => x.id === state.compare.a);
  const b = AREAS.find((x) => x.id === state.compare.b);
  $('compare').close();
  if (narrow()) $('map').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  mapView.showPair(a, b);
});
$('compare').addEventListener('click', (e) => {
  if (e.target === $('compare')) $('compare').close(); // a click on the backdrop
});

// story
$('story-open').addEventListener('click', openStory);
$('story-cta').addEventListener('click', openStory);
$('story-close').addEventListener('click', closeStory);
$('story-prev').addEventListener('click', () => story.prev());
$('story-next').addEventListener('click', () => story.next());
$('story-play').addEventListener('click', () => story.togglePlay());
$('story-range').addEventListener('input', (e) => story.seek(+e.target.value / 1000));
for (const b of document.querySelectorAll('.chapter-tabs [data-chapter]')) {
  b.addEventListener('click', () => {
    const steps = story.stepPositions;
    story.seek(b.dataset.chapter === 'exposed' ? steps.find((p) => p > 1) : steps[0]);
  });
}
$('story').addEventListener('keydown', (e) => {
  const onControl = e.target.matches('input, select, button');
  if (e.key === 'Escape') closeStory();
  else if (e.key === 'ArrowRight' && !e.target.matches('input')) story.next();
  else if (e.key === 'ArrowLeft' && !e.target.matches('input')) story.prev();
  else if (e.key === ' ' && !onControl) story.togglePlay();
  else if (e.key === 'Tab') {
    // keep focus inside the story while it is open
    const f = [...$('story').querySelectorAll('button, input')].filter((el) => !el.closest('[hidden]') && el.offsetParent);
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) last.focus();
    else if (!e.shiftKey && document.activeElement === last) first.focus();
    else return;
  } else return;
  e.preventDefault();
});

window.addEventListener('hashchange', () => {
  if (readHash()) setHazard(state.hazard);
});

// theme: the button names the theme you'd switch to. The map follows by CSS alone.
function effectiveTheme() {
  return document.documentElement.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function syncThemeButton() {
  $('theme-toggle').textContent = effectiveTheme() === 'dark' ? 'Light' : 'Dark';
  $('theme-toggle').setAttribute('aria-label', `Switch to ${effectiveTheme() === 'dark' ? 'light' : 'dark'} mode`);
}
$('theme-toggle').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('drainwatch-theme', next);
  } catch {
    // storage blocked: the choice lasts for this visit
  }
  story.setTheme(next);
  syncThemeButton();
  renderApp();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (document.documentElement.dataset.theme) return;
  story.setTheme(effectiveTheme());
  syncThemeButton();
  renderApp();
});

// ---------------- start ----------------

function markHazard(h) {
  document.body.dataset.hazard = h;
  for (const a of document.querySelectorAll('.sections a')) {
    if (a.dataset.hazard === h) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

readHash();
markHazard(state.hazard);
syncThemeButton();
$('slr-range').max = SLR_MAX_INCHES;
if (window.matchMedia('(max-width: 999px)').matches) $('layers-box').open = false; // narrow screens: keep the map clear

const story = createStoryController({ theme: effectiveTheme(), onPosition: onStoryPosition });
await story.setHazard(state.hazard);
renderStoryTable(storyFor(state.hazard));

mapView.createMap($('map'), {
  onClick: (lat, lon) => {
    const area = AREAS[nearestAreaIndex(lat, lon)];
    checkPoint({ lat, lon, label: `A spot near ${area.name}`, borough: null, needsName: true });
  },
});
renderLayers();
const checklist = initChecklist(state.hazard);
renderSeaLevel();
renderMethodology(state.hazard);
renderApp();
mapView.loadNtas().then((features) => {
  ntaFeatures = features;
  renderApp();
});
loadTerrain().then((grid) => {
  terrain = grid;
  state.status.terrain = grid ? { ok: true } : { ok: false, message: 'offline' };
  if (state.point) state.point.terrain = null;
  renderApp();
});
// the map box can change size after fonts load; reframe the city once it settles
window.addEventListener('load', () => mapView.fitCity());
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => mapView.invalidate(), 150);
});
wireSearch('address-form', 'address-input', 'address-results');

loadLive();
setInterval(() => {
  if (!document.hidden) loadLive();
}, REFRESH_MS);

// optional extra heat drivers (tree canopy, air conditioning) from scripts/import-heat-drivers.mjs,
// fetched only when config.js says the file ships
if (HEAT_DRIVERS_URL) {
  fetch(HEAT_DRIVERS_URL)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      state.heatDrivers = d;
      stories.clear();
      if (state.hazard === 'heat') story.setHazard('heat', { heatDrivers: d });
    })
    .catch(() => {});
}
