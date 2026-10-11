// DrainWatch: wires live data, historical replays, the risk models, the map and
// the page together. State lives in one object; render() redraws from it.

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
import { HAZARDS, HAZARD_ORDER, assessAll, assessPlace, citySummary, hasData, nearestAreaIndex } from './hazards.js';
import { SEA_LEVEL_STOPS, buildScenario, scenarioById, scenariosFor, withSeaLevelRise } from './scenarios.js';
import { attachChartHover, gaugeSvg } from './charts.js';
import {
  areaPopupHtml,
  areaTooltipHtml,
  hazardCardsHtml,
  legendHtml,
  rankingHtml,
  reportCardHtml,
  reportPinPopupHtml,
  reportPopupHtml,
  stationPopupHtml,
} from './panels.js';
import { initChecklist, renderMethodology, renderSeaLevel } from './story.js';
import { esc, icon } from './ui.js';
import * as mapView from './map.js';

const REFRESH_MS = 15 * 60 * 1000;

const SOURCES = {
  tides: { name: 'NOAA Tides & Currents', url: 'https://tidesandcurrents.noaa.gov/' },
  weather: { name: 'Open-Meteo forecast', url: 'https://open-meteo.com/' },
  air: { name: 'Open-Meteo air quality', url: 'https://open-meteo.com/en/docs/air-quality-api' },
  alerts: { name: 'National Weather Service', url: 'https://www.weather.gov/' },
  reports: { name: 'NYC 311', url: 'https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9' },
  fema: { name: 'FEMA flood zones', url: 'https://msc.fema.gov/portal/home' },
  geosearch: { name: 'NYC GeoSearch', url: 'https://geosearch.planninglabs.nyc/' },
};

const state = {
  hazard: 'floods',
  scenario: 'live',
  slrIndex: 0,
  live: { mode: 'live', tides: {}, weather: null, air: null, alerts: null, reports: null },
  liveLoaded: false,
  loading: false,
  updatedAt: null,
  status: {}, // source key -> { ok, message }
  selectedStation: 'battery',
  point: null, // address check: { place, idx, fema, history, pointWeather, loading }
  markers: {},
};

const scenarioCache = new Map();
const $ = (id) => document.getElementById(id);
const tip = $('chart-tip');

// ---------------- inputs ----------------

function baseInputs() {
  if (state.scenario === 'live') return state.live;
  if (!scenarioCache.has(state.scenario)) scenarioCache.set(state.scenario, buildScenario(state.scenario));
  return scenarioCache.get(state.scenario);
}

/** Inputs for one hazard: sea level rise only ever applies to the flood model. */
function inputsFor(hazard) {
  const base = baseInputs();
  const stop = SEA_LEVEL_STOPS[state.slrIndex];
  if (hazard === 'floods' && stop.inches) return { ...base, tides: withSeaLevelRise(base.tides, stop.inches) };
  return base;
}

const isLive = () => state.scenario === 'live';

// ---------------- loading live data ----------------

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
  const btn = $('refresh-btn');
  btn.disabled = true;
  btn.classList.add('spinning');
  renderModePill();

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
  btn.disabled = false;
  btn.classList.remove('spinning');
  render();
}

// ---------------- routing (URL hash) ----------------

/** #floods, #floods/ida, #floods/live/2080s — shareable links straight into a view. */
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

// ---------------- rendering ----------------

function render() {
  const hazard = state.hazard;
  const inputs = inputsFor(hazard);
  const results = assessAll(hazard, inputs);
  const summary = citySummary(hazard, results, inputs);
  const pending = isLive() && !state.liveLoaded;
  const available = !pending && summary.available;

  document.body.dataset.hazard = hazard;
  for (const tab of document.querySelectorAll('.hazard-tab')) {
    const on = tab.dataset.hazard === hazard;
    tab.setAttribute('aria-selected', on);
    tab.tabIndex = on ? 0 : -1;
  }
  $('dashboard').setAttribute('aria-labelledby', `tab-${hazard}`);

  renderHero(summary, { pending, available });
  renderTimeMachine();
  renderModePill();
  renderCards(inputs, pending);
  renderRanking(results, available, pending);
  renderMap(results, inputs, available);
  renderPoint();
  renderSources();
  writeHash();
}

function renderHero(summary, { pending, available }) {
  const h = HAZARDS[state.hazard];
  const s = scenarioById(state.scenario);
  const w = summary.worst;

  $('gauge').innerHTML = available
    ? gaugeSvg({ score: w.score, level: w.level, label: levelLabel(w.level), sub: `peak ${w.score.toFixed(1)} / 4` })
    : gaugeSvg({ score: null, level: null, label: pending ? '…' : 'No data', sub: pending ? 'loading' : 'feeds offline' });

  $('hero-eyebrow').innerHTML = s
    ? `<span class="tag">Replay</span> ${esc(s.name)} · ${esc(s.date)}`
    : `${esc(h.title)} · next 48 hours${state.slrIndex ? ` · ${esc(SEA_LEVEL_STOPS[state.slrIndex].label)} sea level` : ''}`;

  let title;
  let headline;
  if (pending) {
    title = 'Checking conditions…';
    headline = 'Loading live data from NOAA, the National Weather Service, Open-Meteo and NYC 311.';
  } else if (!available) {
    title = 'Live data unavailable';
    const replay = scenariosFor(state.hazard)[0];
    headline = `We couldn't reach the live data feeds. Check your connection, or replay a past disaster to see how DrainWatch works.
      <br><button type="button" class="btn hero-cta" data-scenario="${replay.id}">${icon('play')} Replay ${esc(replay.name)}</button>`;
  } else {
    title = w.level === 'low' ? `Low ${h.noun} risk across NYC` : `${levelLabel(w.level)} ${h.noun} risk`;
    headline = esc(summary.headline);
  }
  $('hero-title').textContent = title;
  $('hero-headline').innerHTML = headline;

  $('kpis').innerHTML = summary.kpis
    .map((k) => {
      const value = pending || (!available && k.value === '—') ? '—' : k.value;
      return `<li class="kpi">
        <p class="kpi-label">${esc(k.label)}</p>
        <p class="kpi-value">${esc(value)}${k.unit && value !== '—' ? `<small>${esc(k.unit)}</small>` : ''}</p>
        <p class="kpi-note">${pending ? 'Loading…' : esc(k.note)}</p>
      </li>`;
    })
    .join('');
}

function renderTimeMachine() {
  const picker = $('scenario-picker');
  // Rebuild the buttons only when the hazard changes, so keyboard focus survives a re-render.
  if (picker.dataset.hazard !== state.hazard) {
    const options = [{ id: 'live', label: 'Live', sub: 'now' }, ...scenariosFor(state.hazard).map((s) => ({ id: s.id, label: s.short, sub: s.year }))];
    picker.innerHTML = options
      .map(
        (o) => `<button type="button" class="seg" role="radio" data-scenario="${o.id}">
          ${o.id === 'live' ? '<span class="dot-live" aria-hidden="true"></span>' : ''}${esc(o.label)} <small>${esc(o.sub)}</small>
        </button>`,
      )
      .join('');
    picker.dataset.hazard = state.hazard;
  }
  for (const b of picker.querySelectorAll('.seg')) {
    const on = b.dataset.scenario === state.scenario;
    b.setAttribute('aria-checked', on);
    b.tabIndex = on ? 0 : -1;
  }

  const slr = $('slr-control');
  slr.hidden = state.hazard !== 'floods';
  $('slr-ticks').innerHTML = SEA_LEVEL_STOPS.map((s) => `<span>${esc(s.label)}</span>`).join('');
  const stop = SEA_LEVEL_STOPS[state.slrIndex];
  $('slr-range').value = state.slrIndex;
  $('slr-range').setAttribute('aria-valuetext', stop.inches ? `${stop.label}, plus ${stop.inches} inches` : 'Today');
  $('slr-output').textContent = stop.inches ? `${stop.label} · +${stop.inches} in` : 'Today';

  const s = scenarioById(state.scenario);
  let note = '';
  if (s) note = `<strong>${esc(s.name)}, ${esc(s.date)}.</strong> ${esc(s.summary)} <span class="muted">Approximate reconstruction from NOAA and NWS records, run through today's model.</span>`;
  if (state.hazard === 'floods' && stop.inches) {
    note += `${note ? ' ' : ''}<strong>+${stop.inches} in of sea level rise</strong> (${esc(stop.label)}, middle of the NPCC likely range; the high-end estimate is ${stop.highEnd} in) is added to every water level.`;
  }
  $('scenario-note').innerHTML = note;
}

function renderModePill() {
  const pill = $('mode-pill');
  const text = $('mode-text');
  const s = scenarioById(state.scenario);
  if (s) {
    pill.dataset.state = 'replay';
    text.textContent = `Replay · ${s.short} ${s.year}`;
  } else if (state.loading && !state.liveLoaded) {
    pill.dataset.state = 'loading';
    text.textContent = 'Connecting…';
  } else {
    const live = ['tides', 'weather', 'air', 'alerts'].filter((k) => state.status[k] && state.status[k].ok).length;
    const time = state.updatedAt ? state.updatedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
    pill.dataset.state = live === 0 ? 'offline' : 'live';
    text.textContent = live === 0 ? 'Live data offline' : live < 4 ? `Live · some feeds down` : `Live · ${time}`;
  }
  pill.title = text.textContent;
}

function renderCards(inputs, pending) {
  const el = $('hazard-cards');
  if (pending) {
    el.innerHTML = '<section class="card"><p class="muted small">Loading live data…</p></section>';
    return;
  }
  el.innerHTML = hazardCardsHtml({ hazard: state.hazard, inputs, status: state.status, selectedStation: state.selectedStation, isLive: isLive() });
  attachChartHover(el, tip);
}

function renderRanking(results, available, pending) {
  $('ranking-sub').textContent = pending ? 'Loading…' : available ? `${HAZARDS[state.hazard].title}, highest first` : 'No live data';
  $('area-list').innerHTML = rankingHtml(results, available);
}

function renderMap(results, inputs, available) {
  // Only the handful of worst places ripple, so the eye goes straight to them.
  const pulsing = new Set(
    available
      ? [...results]
          .filter((r) => r.level === 'high' || r.level === 'severe')
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map((r) => r.area.id)
      : [],
  );
  state.markers = mapView.drawAreas(
    results.map((r) => ({
      id: r.area.id,
      lat: r.area.lat,
      lon: r.area.lon,
      level: available ? r.level : 'none',
      score: available ? r.score : 0,
      pulse: pulsing.has(r.area.id),
      tooltip: `${r.area.name}: ${available ? levelLabel(r.level) : 'no data'}`,
      tooltipHtml: areaTooltipHtml(state.hazard, r, available),
      popup: areaPopupHtml(state.hazard, r, available),
    })),
  );
  const floods = state.hazard === 'floods';
  mapView.setFloodLayers(floods);
  if (floods) {
    mapView.drawReports(isLive() ? inputs.reports : [], reportPinPopupHtml);
    mapView.drawStations(inputs.tides, stationPopupHtml);
  }
  $('legend').innerHTML = legendHtml(state.hazard);
}

function renderSources() {
  $('source-status').innerHTML = Object.entries(SOURCES)
    .map(([key, s]) => {
      const st = state.status[key];
      const cls = !st ? 'idle' : st.ok ? (st.message ? 'partial' : 'ok') : 'fail';
      const note = !st ? 'on demand' : st.ok ? (st.message ? 'partial' : 'live') : st.message;
      return `<li class="${cls}"><a href="${s.url}" target="_blank" rel="noopener" title="${esc(s.name)}: ${esc(note)}"><span class="s-dot" aria-hidden="true"></span>${esc(s.name)}<span class="sr-only">: ${esc(note)}</span></a></li>`;
    })
    .join('');
}

// ---------------- address / point check ----------------

let pointRequest = 0;

async function checkPoint(place) {
  const id = ++pointRequest;
  const { lat, lon } = place;
  const idx = nearestAreaIndex(lat, lon);
  state.point = { place, idx, loading: true, fema: null, history: null, pointWeather: null };
  mapView.showPoint(lat, lon, null);
  renderPoint();
  if (window.matchMedia('(max-width: 860px)').matches) $('report-slot').scrollIntoView({ behavior: 'smooth', block: 'start' });

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
  renderSources();
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
    const pending = isLive() && !state.liveLoaded;
    available[h] = !pending && hasData(h, inputs);
    if (p.loading && h === 'floods') continue;
    const overrides = {};
    // In live mode use the forecast at this exact spot; replays use the neighborhood's.
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
    stationName: TIDE_STATIONS[area.station].name,
    results,
    available,
  };
}

function renderPoint() {
  const slot = $('report-slot');
  if (!state.point) {
    slot.innerHTML = '';
    return;
  }
  const rep = pointReport();
  slot.innerHTML = reportCardHtml(rep, state.hazard);
  if (!rep.loading) mapView.showPointPopup(reportPopupHtml(rep));
}

// ---------------- search ----------------

const searchForm = $('search-form');
const searchInput = $('search-input');
const searchResults = $('search-results');

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = searchInput.value.trim();
  if (!text) return;
  searchResults.innerHTML = '<p class="muted">Searching…</p>';
  try {
    const matches = await geocode(text);
    state.status.geosearch = { ok: true };
    if (!matches.length) {
      searchResults.innerHTML = '<p class="warn">No NYC address found. Try adding the borough.</p>';
      return;
    }
    if (matches.length === 1) {
      searchResults.innerHTML = '';
      checkPoint(matches[0]);
      return;
    }
    searchResults.innerHTML = `<ul role="listbox" aria-label="Matching addresses">${matches
      .map((m, i) => `<li><button type="button" data-i="${i}">${icon('pin')}${esc(m.label)}</button></li>`)
      .join('')}</ul>`;
    searchResults.querySelector('button').focus();
    searchResults.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        searchResults.innerHTML = '';
        checkPoint(matches[+b.dataset.i]);
      }),
    );
  } catch {
    state.status.geosearch = { ok: false, message: 'offline' };
    renderSources();
    searchResults.innerHTML = '<p class="warn">Address search is unavailable right now. You can still click the map to check any spot.</p>';
  }
});
searchInput.addEventListener('input', () => {
  if (!searchInput.value) searchResults.innerHTML = '';
});
document.addEventListener('click', (e) => {
  if (!searchForm.contains(e.target)) searchResults.innerHTML = '';
});

// ---------------- events ----------------

function setHazard(hazard, { focus = false } = {}) {
  if (hazard === state.hazard) return;
  state.hazard = hazard;
  if (state.scenario !== 'live' && !scenariosFor(hazard).some((s) => s.id === state.scenario)) state.scenario = 'live';
  render();
  if (focus) document.getElementById(`tab-${hazard}`).focus();
}

const tabList = document.querySelector('.hazard-tabs');
tabList.addEventListener('click', (e) => {
  const tab = e.target.closest('.hazard-tab');
  if (tab) setHazard(tab.dataset.hazard);
});
tabList.addEventListener('keydown', (e) => {
  const i = HAZARD_ORDER.indexOf(state.hazard);
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: HAZARD_ORDER.length - 1 }[e.key];
  if (next == null) return;
  e.preventDefault();
  setHazard(HAZARD_ORDER[(next + HAZARD_ORDER.length) % HAZARD_ORDER.length], { focus: true });
});

const picker = $('scenario-picker');
picker.addEventListener('click', (e) => {
  const b = e.target.closest('.seg');
  if (!b || b.dataset.scenario === state.scenario) return;
  state.scenario = b.dataset.scenario;
  render();
  picker.querySelector(`[data-scenario="${state.scenario}"]`).focus();
});
picker.addEventListener('keydown', (e) => {
  const ids = [...picker.querySelectorAll('.seg')].map((b) => b.dataset.scenario);
  const i = ids.indexOf(state.scenario);
  const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1 }[e.key];
  if (next == null) return;
  e.preventDefault();
  state.scenario = ids[(next + ids.length) % ids.length];
  render();
  picker.querySelector(`[data-scenario="${state.scenario}"]`).focus();
});

$('hero-headline').addEventListener('click', (e) => {
  const b = e.target.closest('[data-scenario]');
  if (!b) return;
  state.scenario = b.dataset.scenario;
  render();
  // The button disappears with the offline message, so keep focus on the replay picker.
  picker.querySelector(`[data-scenario="${state.scenario}"]`).focus();
});

$('slr-range').addEventListener('input', (e) => {
  state.slrIndex = +e.target.value;
  render();
});

$('hazard-cards').addEventListener('change', (e) => {
  if (e.target.id !== 'station-select') return;
  state.selectedStation = e.target.value;
  render();
  $('station-select').focus();
});

$('area-list').addEventListener('click', (e) => {
  const row = e.target.closest('.area-row');
  if (!row) return;
  const area = AREAS.find((a) => a.id === row.dataset.id);
  mapView.flyTo(area.lat, area.lon);
  state.markers[area.id]?.openPopup();
  if (window.matchMedia('(max-width: 860px)').matches) document.querySelector('.map-panel').scrollIntoView({ behavior: 'smooth' });
});

$('report-slot').addEventListener('click', (e) => {
  if (e.target.closest('#report-close')) {
    state.point = null;
    pointRequest++;
    mapView.clearPoint();
    renderPoint();
    return;
  }
  const row = e.target.closest('.report-row');
  if (row) setHazard(row.dataset.hazard);
});

$('refresh-btn').addEventListener('click', loadLive);

$('try-slr').addEventListener('click', () => {
  state.hazard = 'floods';
  state.scenario = 'live';
  state.slrIndex = SEA_LEVEL_STOPS.findIndex((s) => s.id === '2080s');
  render();
  $('dashboard').scrollIntoView({ behavior: 'smooth' });
});

window.addEventListener('hashchange', () => {
  if (readHash()) render();
});

// theme
function effectiveTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function syncThemeButton() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  $('theme-btn').setAttribute('aria-label', `Switch to ${next} mode`);
}
$('theme-btn').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('drainwatch-theme', next);
  } catch {
    // storage blocked: the choice lasts for this visit
  }
  mapView.setMapTheme(next);
  syncThemeButton();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!document.documentElement.dataset.theme) mapView.setMapTheme(effectiveTheme());
  syncThemeButton();
});

// ---------------- start ----------------

mapView.createMap($('map'), {
  theme: effectiveTheme(),
  onClick: (lat, lon) => {
    const area = AREAS[nearestAreaIndex(lat, lon)];
    checkPoint({ lat, lon, label: `Dropped pin near ${area.name}`, borough: null, needsName: true });
  },
});
syncThemeButton();
readHash();
renderSeaLevel();
renderMethodology();
initChecklist();
render();
loadLive();
setInterval(() => {
  if (!document.hidden) loadLive();
}, REFRESH_MS);
