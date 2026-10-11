// DrainWatch: wires live data, the replays, the risk models, the scroll story,
// the map and the page together. State lives in one object; each render*()
// redraws its part of the page from it.

import { AREAS, TIDE_STATIONS } from './config.js';
import {
  fetch311History,
  fetchAirQuality,
  fetchAlerts,
  fetchFemaZone,
  fetchRecent311,
  fetchTides,
  fetchWeather,
  geocode,
  reverseGeocode,
} from './data.js';
import { exposureFromComplaintHistory, exposureFromFemaZone, levelLabel } from './risk.js';
import { aqiCategory } from './air-risk.js';
import { HAZARDS, HAZARD_ORDER, assessAll, assessPlace, citySummary, hasData, nearestAreaIndex } from './hazards.js';
import { SEA_LEVEL_STOPS, buildScenario, scenarioById, scenariosFor, withSeaLevelRise } from './scenarios.js';
import { attachChartHover } from './charts.js';
import { areaPopupHtml, detailsHtml, legendHtml, rankingRowsHtml, reportHtml, reportPinPopupHtml, stationPopupHtml } from './panels.js';
import { initChecklist, renderMethodology, renderSeaLevel, renderSources, renderStoryTable } from './sections.js';
import { buildStory } from './story/stories.js';
import { createStoryController } from './story/controller.js';
import * as mapView from './map.js';
import { esc } from './ui.js';


const REFRESH_MS = 15 * 60 * 1000;

const SOURCES = {
  tides: { name: 'NOAA Tides & Currents', url: 'https://tidesandcurrents.noaa.gov/' },
  weather: { name: 'Open-Meteo forecast', url: 'https://open-meteo.com/' },
  air: { name: 'Open-Meteo air quality', url: 'https://open-meteo.com/en/docs/air-quality-api' },
  alerts: { name: 'National Weather Service alerts', url: 'https://www.weather.gov/' },
  reports: { name: 'NYC 311 flooding reports', url: 'https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9' },
  fema: { name: 'FEMA flood zones', url: 'https://msc.fema.gov/portal/home' },
  geosearch: { name: 'NYC GeoSearch', url: 'https://geosearch.planninglabs.nyc/' },
};

const state = {
  hazard: 'heat',
  scenario: 'live', // what the app section shows: live data or a replay
  slrIndex: 0,
  live: { mode: 'live', tides: {}, weather: null, air: null, alerts: null, reports: null },
  liveLoaded: false,
  loading: false,
  updatedAt: null,
  status: {},
  selectedStation: 'battery',
  point: null, // { place, idx, fema, history, pointWeather, loading }
  overlays: { fema: false, reports: true, stations: true },
  heatDrivers: null,
  showAll: false,
};

const scenarioCache = new Map();
const $ = (id) => document.getElementById(id);
const tip = $('chart-tip');
const isLive = () => state.scenario === 'live';

// ---------------- inputs ----------------

function baseInputs() {
  if (isLive()) return state.live;
  if (!scenarioCache.has(state.scenario)) scenarioCache.set(state.scenario, buildScenario(state.scenario));
  return scenarioCache.get(state.scenario);
}

/** Sea level rise only ever applies to the flood model. */
function inputsFor(hazard) {
  const base = baseInputs();
  const stop = SEA_LEVEL_STOPS[state.slrIndex];
  if (hazard === 'floods' && stop.inches) return { ...base, tides: withSeaLevelRise(base.tides, stop.inches) };
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

function setMega(el, num) {
  el.hidden = !num;
  el.innerHTML = num ? `<span class="mega-num">${esc(num.value)}</span><span class="mega-unit">${esc(num.unit.trim())}</span>` : '';
}

// ---------------- hero ----------------

function renderHero() {
  const h = state.hazard;
  const story = storyFor(h);
  const live = liveSummary(h);
  const leadLive = live && (live.worst.level === 'high' || live.worst.level === 'severe');

  if (leadLive) {
    const num = headlineNumber(h, state.live, live);
    $('hero-kicker').textContent = `Right now · ${HAZARDS[h].label}`;
    setMega($('hero-mega'), num);
    $('hero-mega-label').textContent = num ? num.label : '';
    $('hero-head').textContent = live.headline;
  } else {
    $('hero-kicker').textContent = `${story.hero.kicker} · Replay`;
    setMega($('hero-mega'), { value: story.mega, unit: story.hero.megaUnit });
    $('hero-mega-label').textContent = story.hero.megaLabel;
    $('hero-head').textContent = story.headline;
  }

  let line;
  if (!state.liveLoaded) line = 'Loading live conditions…';
  else if (!live) line = 'Live data is unavailable right now, so the story below runs on recorded data. Address checks still use the FEMA flood map when it answers.';
  else {
    const num = headlineNumber(h, state.live, live);
    line = `Right now: <b>${levelLabel(live.worst.level)}</b> ${esc(HAZARDS[h].noun)} risk across the city${num ? `; ${esc(String(num.value))}${esc(num.unit)} ${esc(num.label.split(',')[0])}` : ''}.`;
  }
  $('live-line').innerHTML = line;

  // lead with whatever is dangerous today, even on another tab
  const others = HAZARD_ORDER.filter((x) => x !== h)
    .map((x) => ({ x, s: liveSummary(x) }))
    .filter(({ s }) => s && (s.worst.level === 'high' || s.worst.level === 'severe'));
  $('also-line').hidden = !others.length;
  $('also-line').innerHTML = others.length
    ? `Also right now: ${others.map(({ x, s }) => `<a href="#${x}">${levelLabel(s.worst.level)} ${esc(HAZARDS[x].noun)} risk</a>`).join(', ')}`
    : '';
}

const stories = new Map();
function storyFor(h) {
  if (!stories.has(h)) stories.set(h, buildStory(h, { heatDrivers: state.heatDrivers }));
  return stories.get(h);
}

// ---------------- the app section ----------------

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
  else if (summary.worst.level === 'low') title = `Low ${HAZARDS[h].noun} risk across the city`;
  else {
    const n = results.filter((r) => r.level === summary.worst.level).length;
    title = `${levelLabel(summary.worst.level)} ${HAZARDS[h].noun} risk in ${n} neighborhood${n === 1 ? '' : 's'}`;
  }
  $('app-title').textContent = title;
  $('app-dek').innerHTML = pending
    ? ''
    : available
      ? esc(summary.headline)
      : `We couldn't reach the live data feeds. Pick a replay below to see how DrainWatch rates a real storm.`;
  $('app-context').textContent = s && available ? `${s.summary} Approximate reconstruction, run through today's risk model.` : '';

  renderModes();
  renderMapData(results, inputs, available);
  $('ranking').querySelector('tbody').innerHTML = rankingRowsHtml(results, available, { limit: state.showAll ? Infinity : 12 });
  $('ranking-more').hidden = state.showAll;
  $('ranking-more').textContent = `Show all ${results.length} neighborhoods`;
  $('ranking-note').textContent = available
    ? `${HAZARDS[h].title}${s ? '' : ' for the next 48 hours'}, highest first.${s ? ` Replaying ${s.name}.` : ''} Select a name to find it on the map.`
    : 'Ratings appear when data is available.';
  $('details').innerHTML = detailsHtml({ hazard: h, inputs, status: state.status, selectedStation: state.selectedStation, isLive: isLive(), pending });
  attachChartHover($('details'), tip);
  renderPoint();
  renderSources(SOURCES, state.status);
  renderStatus();
  writeHash();
}

function renderModes() {
  const options = [{ id: 'live', label: 'Live now' }, ...scenariosFor(state.hazard).map((s) => ({ id: s.id, label: s.name.includes(String(s.year)) ? s.name : `${s.name}, ${s.year}` }))];
  $('mode-list').innerHTML = options
    .map((o) => `<button type="button" role="radio" data-scenario="${o.id}" aria-checked="${o.id === state.scenario}" tabindex="${o.id === state.scenario ? 0 : -1}">${esc(o.label)}</button>`)
    .join('');
  const floods = state.hazard === 'floods';
  $('slr').hidden = !floods;
  if (floods) {
    $('slr-list').innerHTML = SEA_LEVEL_STOPS.map(
      (stop, i) =>
        `<button type="button" role="radio" data-slr="${i}" aria-checked="${i === state.slrIndex}" tabindex="${i === state.slrIndex ? 0 : -1}">${esc(stop.label)}${stop.inches ? ` +${stop.inches} in` : ''}</button>`,
    ).join('');
    const stop = SEA_LEVEL_STOPS[state.slrIndex];
    $('slr-note').textContent = stop.inches
      ? `Every water level is raised ${stop.inches} inches, the middle of the NYC Panel on Climate Change's likely range for the ${stop.label} (high-end estimate: ${stop.highEnd} in).`
      : 'Raise the sea to the levels projected for later this century.';
  }
}

function renderMapData(results, inputs, available) {
  const levels = {};
  if (available) for (const r of results) levels[r.area.id] = r.level;
  const byId = Object.fromEntries(results.map((r) => [r.area.id, r]));
  mapView.paintNtas(levels, (f, lvl) => {
    const names = f.properties.areas.map((id) => byId[id].area.name);
    if (names.length) return `${esc(names.join(' & '))} · ${lvl ? levelLabel(lvl) : 'no data'}`;
    return f.properties.park ? null : `${esc(f.properties.name)} · not rated`;
  });
  $('legend').innerHTML = legendHtml();
  const floods = state.hazard === 'floods';
  $('layers').hidden = !floods;
  for (const key of Object.keys(mapView.OVERLAYS)) mapView.setOverlay(key, floods && state.overlays[key]);
  if (floods) {
    mapView.drawReports(isLive() ? inputs.reports : [], reportPinPopupHtml);
    mapView.drawStations(inputs.tides, stationPopupHtml);
  }
}

function renderLayers() {
  $('layers').innerHTML =
    '<legend class="label">Map layers</legend>' +
    Object.entries(mapView.OVERLAYS)
      .map(([key, o]) => `<label><input type="checkbox" data-overlay="${key}"${state.overlays[key] ? ' checked' : ''} /> ${esc(o.label)}</label>`)
      .join('');
}

function renderStatus() {
  const el = $('status');
  const s = scenarioById(state.scenario);
  if (s) el.innerHTML = `Map showing <b>${esc(s.short)} ${s.year}</b> replay`;
  else if (!state.liveLoaded) el.textContent = 'Connecting to live data…';
  else {
    const ok = ['tides', 'weather', 'air', 'alerts'].filter((k) => state.status[k] && state.status[k].ok).length;
    const time = state.updatedAt ? state.updatedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
    el.innerHTML = ok === 0 ? 'Live data offline' : `<b>Live</b> · updated ${time}${ok < 4 ? ' · some feeds down' : ''}`;
  }
}

// ---------------- routing ----------------

/** #heat, #floods/sandy, #floods/live/2080s: shareable links into a view. */
function readHash() {
  const [hazard, scenario, slr] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (!HAZARD_ORDER.includes(hazard)) return false;
  state.hazard = hazard;
  state.scenario = scenario && scenariosFor(hazard).some((s) => s.id === scenario) ? scenario : 'live';
  const stop = SEA_LEVEL_STOPS.findIndex((s) => s.id === slr);
  state.slrIndex = hazard === 'floods' && stop > 0 ? stop : 0;
  return true;
}

function writeHash() {
  const parts = [state.hazard];
  if (state.scenario !== 'live' || state.slrIndex) parts.push(state.scenario);
  if (state.slrIndex) parts.push(SEA_LEVEL_STOPS[state.slrIndex].id);
  const hash = `#${parts.join('/')}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

async function setHazard(h) {
  const changed = h !== story.hazard;
  state.hazard = h;
  if (state.scenario !== 'live' && !scenariosFor(h).some((s) => s.id === state.scenario)) state.scenario = 'live';
  markHazard(h);
  renderHero();
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
  renderHero();
  renderApp();
}

// ---------------- address checks ----------------

let pointRequest = 0;

async function checkPoint(place, { scroll = false } = {}) {
  const id = ++pointRequest;
  const { lat, lon } = place;
  const idx = nearestAreaIndex(lat, lon);
  state.point = { place, idx, loading: true, fema: null, history: null, pointWeather: null };
  mapView.showPoint(lat, lon);
  renderPoint();
  if (scroll) $('report').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });

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
  state.point = { place, idx, loading: false, fema, history, pointWeather };
  renderPoint();
  renderSources(SOURCES, state.status);
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
  return { place: p.place, borough, nearest: area, loading: p.loading, fema: p.fema, history: p.history, stationName: TIDE_STATIONS[area.station].name, results, available };
}

function renderPoint() {
  $('report').innerHTML = state.point ? reportHtml(pointReport(), state.hazard) : '';
}

function wireSearch(formId, inputId, resultsId, { scroll }) {
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
      if (matches.length === 1) {
        results.innerHTML = '';
        checkPoint(matches[0], { scroll });
        return;
      }
      results.innerHTML = `<ul aria-label="Matching addresses">${matches.map((m, i) => `<li><button type="button" data-i="${i}">${esc(m.label)}</button></li>`).join('')}</ul>`;
      results.querySelector('button').focus();
      results.querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', () => {
          results.innerHTML = '';
          checkPoint(matches[+b.dataset.i], { scroll });
        }),
      );
    } catch {
      state.status.geosearch = { ok: false, message: 'offline' };
      renderSources(SOURCES, state.status);
      results.innerHTML = "<p>Address search isn't responding right now. You can click any spot on the map below instead.</p>";
    }
  });
  input.addEventListener('input', () => {
    if (!input.value) results.innerHTML = '';
  });
}

// ---------------- events ----------------

$('mode-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-scenario]');
  if (!b) return;
  state.scenario = b.dataset.scenario;
  renderApp();
  $('mode-list').querySelector(`[data-scenario="${state.scenario}"]`).focus();
});
$('slr-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-slr]');
  if (!b) return;
  state.slrIndex = +b.dataset.slr;
  renderApp();
  $('slr-list').querySelector(`[data-slr="${state.slrIndex}"]`).focus();
});
for (const id of ['mode-list', 'slr-list']) {
  $(id).addEventListener('keydown', (e) => {
    const buttons = [...$(id).querySelectorAll('button')];
    const i = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    buttons[(next + buttons.length) % buttons.length].click();
  });
}
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
  mapView.setOverlay(key, e.target.checked);
});
$('ranking').addEventListener('click', (e) => {
  const b = e.target.closest('.row-link');
  if (!b) return;
  const h = state.hazard;
  const inputs = inputsFor(h);
  const i = AREAS.findIndex((a) => a.id === b.dataset.id);
  const r = assessPlace(h, AREAS[i], inputs, i);
  const available = !(isLive() && !state.liveLoaded) && hasData(h, inputs);
  $('map').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  mapView.flyTo(AREAS[i].lat, AREAS[i].lon);
  mapView.openPopupAt(AREAS[i].lat, AREAS[i].lon, areaPopupHtml(h, r, available));
});
$('ranking-more').addEventListener('click', () => {
  state.showAll = true;
  renderApp();
});
$('report').addEventListener('click', (e) => {
  if (!e.target.closest('#report-close')) return;
  state.point = null;
  pointRequest++;
  mapView.clearPoint();
  renderPoint();
});
window.addEventListener('hashchange', () => {
  if (readHash()) setHazard(state.hazard);
});

// theme: the button names the theme you'd switch to
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
  mapView.setTheme(next);
  story.setTheme(next);
  syncThemeButton();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (document.documentElement.dataset.theme) return;
  mapView.setTheme(effectiveTheme());
  story.setTheme(effectiveTheme());
  syncThemeButton();
});

// ---------------- 3D: only after first paint, and only where it will run well ----------------

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

async function startStage() {
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

const story = createStoryController({ theme: effectiveTheme() });
await story.setHazard(state.hazard);
renderHero();
renderStoryTable(storyFor(state.hazard));

mapView.createMap($('map'), {
  theme: effectiveTheme(),
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
mapView.loadNtas().then(() => renderApp());
// the map box can change size after fonts load; reframe the city when it first scrolls into view
new IntersectionObserver((entries, obs) => {
  if (entries.some((e) => e.isIntersecting)) {
    mapView.fitCity();
    obs.disconnect();
  }
}).observe($('map'));
wireSearch('address-form', 'address-input', 'address-results', { scroll: true });
wireSearch('address-form-2', 'address-input-2', 'address-results-2', { scroll: false });

story.start();
(window.requestIdleCallback || ((f) => setTimeout(f, 200)))(startStage);
loadLive();
setInterval(() => {
  if (!document.hidden) loadLive();
}, REFRESH_MS);

// optional extra heat drivers (tree canopy, air conditioning) from scripts/import-heat-drivers.mjs
fetch('data/heat-drivers.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => {
    if (!d) return;
    state.heatDrivers = d;
    stories.clear();
    if (state.hazard === 'heat') story.setHazard('heat', { heatDrivers: d });
  })
  .catch(() => {});
