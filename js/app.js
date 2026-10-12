// DrainWatch: wires live data, the replays, the risk models, the dashboard,
// the opt-in scroll story, the map and the page together. State lives in one
// object; each render*() redraws its part of the page from it.

import { AREAS, TIDE_STATIONS } from './config.js';
import {
  fetch311History,
  fetchAirQuality,
  fetchAlerts,
  fetchEvacuationCenters,
  fetchEvacuationZone,
  fetchFemaZone,
  fetchRecent311,
  fetchTides,
  fetchWeather,
  geocode,
  reverseGeocode,
} from './data.js';
import { distanceKm, exposureFromComplaintHistory, exposureFromFemaZone, LEVELS, levelLabel } from './risk.js';
import { aqiCategory } from './air-risk.js';
import { HAZARDS, HAZARD_ORDER, assessAll, assessPlace, citySummary, hasData, nearestAreaIndex } from './hazards.js';
import { SEA_LEVEL_STOPS, buildScenario, replayWaterSeries, scenarioById, scenariosFor, withSeaLevelRise } from './scenarios.js';
import { attachChartHover } from './charts.js';
import { areaPopupHtml, detailsHtml, legendHtml, rankingRowsHtml, reportHtml, reportPinPopupHtml, stationPopupHtml } from './panels.js';
import { initChecklist, renderMethodology, renderSeaLevel, renderSources, renderStoryTable } from './sections.js';
import { COMPARE_PRESETS, compareHtml } from './compare.js';
import {
  cellAreaKm2,
  compassWord,
  elevationAt,
  floodCounts,
  floodImage,
  floodMask,
  gridFromPixels,
  medianElevationByNta,
  nearestHigherGround,
  walkMinutes,
} from './flood-extent.js';
import { ELEVATION } from './story/elevation.js';
import { buildStory, storyTime, waterNavdMeters } from './story/stories.js';
import { createStoryController } from './story/controller.js';
import * as mapView from './map.js';
import { esc, level } from './ui.js';

const REFRESH_MS = 15 * 60 * 1000;
const RANK = Object.fromEntries(LEVELS.map((l, i) => [l.level, i]));
/** "Higher ground" must clear a Sandy-size storm on 2080s seas by this much (about 3 ft). */
const HIGHER_MARGIN_M = 0.9;
const FUTURE_STOP = SEA_LEVEL_STOPS.find((s) => s.id === '2080s');

const SOURCES = {
  tides: { name: 'NOAA Tides & Currents', url: 'https://tidesandcurrents.noaa.gov/' },
  weather: { name: 'Open-Meteo forecast', url: 'https://open-meteo.com/' },
  air: { name: 'Open-Meteo air quality', url: 'https://open-meteo.com/en/docs/air-quality-api' },
  alerts: { name: 'National Weather Service alerts', url: 'https://www.weather.gov/' },
  reports: { name: 'NYC 311 flooding reports', url: 'https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9' },
  fema: { name: 'FEMA flood zones', url: 'https://msc.fema.gov/portal/home' },
  evac: { name: 'NYC Emergency Management evacuation zones & centers', url: 'https://data.cityofnewyork.us/Public-Safety/Hurricane-Evacuation-Zones/epne-qv9x' },
  geosearch: { name: 'NYC GeoSearch', url: 'https://geosearch.planninglabs.nyc/' },
  elevation: { name: 'USGS 3DEP elevation (AWS Terrain Tiles)', url: 'https://registry.opendata.aws/terrain-tiles/' },
  tiles: { name: 'OpenStreetMap map tiles', url: 'https://www.openstreetmap.org/copyright' },
};

const state = {
  view: 'dashboard', // 'dashboard' or 'story' (the 3D scroll replay, opt-in)
  tab: 'ranking',
  hazard: 'heat',
  scenario: 'live', // what the dashboard shows: live data or a replay
  slrIndex: 0,
  hour: null, // the time machine's storm hour (index into the replay's water series; null = the peak)
  playing: false,
  live: { mode: 'live', tides: {}, weather: null, air: null, alerts: null, reports: null },
  liveLoaded: false,
  loading: false,
  updatedAt: null,
  status: {},
  selectedStation: 'battery',
  point: null, // { place, idx, fema, history, pointWeather, loading, refuge }
  overlays: { fema: false, reports: true, stations: true },
  heatDrivers: null,
  showAll: false,
  compare: { a: COMPARE_PRESETS[0][0], b: COMPARE_PRESETS[0][1] },
};

const scenarioCache = new Map();
const seriesCache = new Map();
const zoneCache = new Map(); // area id → evacuation zone (or 'error'), for the comparison
const $ = (id) => document.getElementById(id);
const tip = $('chart-tip');
const isLive = () => state.scenario === 'live';
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// the elevation grid and what it says about each rated neighborhood (loaded after first paint)
let terrain = null; // { grid, cellKm2, sandyFt, areas: Map(id → { codes, medianM, sandyPct, futurePct }) }
let riskDelta = null; // { worse: Set(id), byId: Map(id → { scoreDelta, levelUp }) } while sea level rise is on

// ---------------- inputs ----------------

function scenarioInputs(id) {
  if (!scenarioCache.has(id)) scenarioCache.set(id, buildScenario(id));
  return scenarioCache.get(id);
}

function baseInputs() {
  return isLive() ? state.live : scenarioInputs(state.scenario);
}

/** Sea level rise only ever applies to the flood model. */
function inputsFor(hazard, slrIndex = state.slrIndex) {
  const base = baseInputs();
  const stop = SEA_LEVEL_STOPS[slrIndex];
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
    return v == null ? null : { value: Math.round(v), unit: '°F', label: replay ? 'feels like, at the peak' : 'feels like, at the peak of the next 48 hours', short: `feels like ${Math.round(v)}°F at the peak` };
  }
  if (hazard === 'air') {
    const v = max(inputs.air, 'peakAqi');
    return v == null ? null : { value: Math.round(v), unit: '', label: `Air Quality Index at its peak, "${aqiCategory(v)}"`, short: `the AQI peaks at ${Math.round(v)}` };
  }
  if (hazard === 'wind') {
    const v = max(inputs.weather, 'maxGust');
    return v == null ? null : { value: Math.round(v), unit: ' mph', label: `strongest gust${when}`, short: `gusts to ${Math.round(v)} mph` };
  }
  if (summary && summary.worst.driver === 'stormwater') {
    const v = max(inputs.weather, 'maxHourly');
    return v == null ? null : { value: v.toFixed(2), unit: ' in/hr', label: `heaviest rain${when}`, short: `rain up to ${v.toFixed(2)} in/hr` };
  }
  const v = max(Object.values(inputs.tides || {}), 'peak');
  return v == null ? null : { value: v.toFixed(1), unit: ' ft', label: `highest water above normal high tide${replay ? '' : ', next 48 hours'}`, short: `water up to ${v.toFixed(1)} ft above normal high tide` };
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

// ---------------- the story's hero (story view only) ----------------

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
    $('hero-head').textContent = `${riskTitle(h, live)}.`;
  } else {
    $('hero-kicker').textContent = `${story.hero.kicker} · Replay`;
    setMega($('hero-mega'), { value: story.mega, unit: story.hero.megaUnit });
    $('hero-mega-label').textContent = story.hero.megaLabel;
    $('hero-head').textContent = story.headline;
  }

  let line;
  if (!state.liveLoaded) line = 'Loading live conditions…';
  else if (!live) line = 'Live data is unavailable right now, so the story below runs on recorded data. Address checks still use the FEMA flood map when it answers.';
  else if (leadLive) line = esc(live.headline);
  else {
    const num = headlineNumber(h, state.live, live);
    const [lvl, ...rest] = riskTitle(h, live).split(' ');
    line = `Right now: <b>${esc(lvl)}</b> ${esc(rest.join(' '))}${num ? `; ${esc(num.short)}` : ''}.`;
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
      : `We couldn't reach the live data feeds. Pick a replay in the time machine to see how DrainWatch rates a real storm.`;
  $('app-context').textContent = s && available ? `${s.summary} Approximate reconstruction, run through today's risk model.` : '';

  riskDelta = available ? computeRiskDelta(h, results) : null;
  renderChips();
  renderModes();
  renderMapData(results, inputs, available);
  const table = $('ranking');
  table.classList.toggle('show-delta', Boolean(riskDelta));
  table.querySelector('tbody').innerHTML = rankingRowsHtml(results, available, { limit: state.showAll ? Infinity : 12, delta: riskDelta && riskDelta.byId });
  $('ranking-more').hidden = state.showAll;
  $('ranking-more').textContent = `Show all ${results.length} neighborhoods`;
  $('ranking-note').textContent = available
    ? `${HAZARDS[h].title}${s ? '' : ' for the next 48 hours'}, highest first.${s ? ` Replaying ${s.name}.` : ''}${riskDelta ? ` "vs today" is the change from ${SEA_LEVEL_STOPS[state.slrIndex].label} sea level rise.` : ''} Select a name to find it on the map.`
    : 'Ratings appear when data is available.';
  $('details').innerHTML = detailsHtml({ hazard: h, inputs, status: state.status, selectedStation: state.selectedStation, isLive: isLive(), pending });
  attachChartHover($('details'), tip);
  renderPoint();
  renderSources(SOURCES, state.status);
  renderStatus();
  writeHash();
  renderTimeMachine();
  if ($('compare').open) renderCompare();
}

/** Which neighborhoods sea level rise pushes up a risk level (floods only). */
function computeRiskDelta(hazard, results) {
  if (hazard !== 'floods' || !state.slrIndex) return null;
  const today = assessAll('floods', inputsFor('floods', 0));
  const worse = new Set();
  const byId = new Map();
  results.forEach((r, i) => {
    const levelUp = RANK[r.level] > RANK[today[i].level];
    if (levelUp) worse.add(r.area.id);
    byId.set(r.area.id, { scoreDelta: Math.round((r.score - today[i].score) * 100) / 100, levelUp, from: today[i].level });
  });
  return { worse, byId };
}

/** One small tile per hazard: the worst level anywhere in the city, live. */
function renderChips() {
  $('hazard-chips').innerHTML = HAZARD_ORDER.map((h) => {
    const s = liveSummary(h);
    const lvl = s ? s.worst.level : null;
    const word = lvl ? levelLabel(lvl) : state.liveLoaded ? 'No data' : '…';
    return `<a class="chip" data-hazard="${h}" href="#${h}"${h === state.hazard ? ' aria-current="true"' : ''}>${esc(HAZARDS[h].label)}${level(lvl || 'none', word)}</a>`;
  }).join('');
}

function renderModes() {
  const options = [{ id: 'live', label: 'Live now' }, ...scenariosFor(state.hazard).map((s) => ({ id: s.id, label: s.name.includes(String(s.year)) ? s.name : `${s.name}, ${s.year}` }))];
  $('mode-list').innerHTML = options
    .map((o) => `<button type="button" role="radio" data-scenario="${o.id}" aria-checked="${o.id === state.scenario}" tabindex="${o.id === state.scenario ? 0 : -1}">${esc(o.label)}</button>`)
    .join('');
}

function renderMapData(results, inputs, available) {
  const levels = {};
  if (available) for (const r of results) levels[r.area.id] = r.level;
  const byId = Object.fromEntries(results.map((r) => [r.area.id, r]));
  mapView.paintNtas(
    levels,
    (f, lvl) => {
      const names = f.properties.areas.map((id) => byId[id].area.name);
      const up = riskDelta && f.properties.areas.find((id) => riskDelta.worse.has(id));
      if (names.length) return `${esc(names.join(' & '))} · ${lvl ? levelLabel(lvl) : 'no data'}${up ? ` (up from ${levelLabel(riskDelta.byId.get(up).from)})` : ''}`;
      return f.properties.park ? null : `${esc(f.properties.name)} · not rated`;
    },
    riskDelta && riskDelta.worse,
  );
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

// ---------------- the climate time machine ----------------

/** Hourly Battery water levels for the flood replay on screen, or null in live mode / other hazards. */
function replaySeries() {
  if (state.hazard !== 'floods' || isLive()) return null;
  if (!seriesCache.has(state.scenario)) seriesCache.set(state.scenario, replayWaterSeries(state.scenario));
  return seriesCache.get(state.scenario);
}

const hourOf = (series) => (state.hour == null ? series.peak : Math.min(series.level.length - 1, state.hour));

/** Water at the Battery (ft above normal high tide) at the time machine's moment, before sea level rise. */
function waterNowFt() {
  const series = replaySeries();
  if (series) return series.level[hourOf(series)];
  const t = (baseInputs().tides || {}).battery;
  return t && t.peak != null ? t.peak : 0;
}

/** Paint a range input's filled track (WebKit has no ::range-progress). */
function setFill(input) {
  const pct = ((input.value - input.min) / (input.max - input.min || 1)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}

function renderTimeMachine() {
  const floods = state.hazard === 'floods';
  const stop = SEA_LEVEL_STOPS[state.slrIndex];

  $('slr').hidden = !floods;
  const r = $('slr-range');
  r.max = String(SEA_LEVEL_STOPS.length - 1);
  r.value = String(state.slrIndex);
  setFill(r);
  const words = stop.inches ? `+${stop.inches} in · ${stop.label}` : 'Today';
  $('slr-out').textContent = words;
  r.setAttribute('aria-valuetext', stop.inches ? `${stop.label}, ${stop.inches} inches of sea level rise` : "Today's sea level");
  $('slr-ticks').innerHTML = SEA_LEVEL_STOPS.map((s, i) => `<span${i === state.slrIndex ? ' class="on"' : ''}>${esc(s.inches ? s.label : 'Today')}</span>`).join('');
  $('slr-note').textContent = stop.inches
    ? `Every water level is raised ${stop.inches} inches, the middle of the NYC Panel on Climate Change's likely range for the ${stop.label} (high-end estimate: ${stop.highEnd} in).`
    : 'Drag to raise the sea to the levels projected for later this century.';

  const series = replaySeries();
  $('tm-hour').hidden = !series;
  if (series) {
    const hr = $('hour-range');
    hr.max = String(series.level.length - 1);
    hr.value = String(hourOf(series));
    setFill(hr);
  } else stopPlay();

  for (const a of document.querySelectorAll('#tm-presets a')) {
    if (a.getAttribute('href') === location.hash) a.setAttribute('aria-current', 'true');
    else a.removeAttribute('aria-current');
  }
  renderFloodView();
}

function cssRgb(name) {
  const hex = getComputedStyle(document.documentElement).getPropertyValue(name).trim().replace('#', '');
  const n = parseInt(hex.length === 3 ? hex.replace(/./g, '$&$&') : hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const km2 = (v) => (v >= 100 ? Math.round(v) : v.toFixed(1));
const sqmi = (v) => Math.round(v / 2.59);

/** The flood overlay, the storm-hour readout and the "what changed" numbers. Cheap enough to run every animation frame. */
function renderFloodView() {
  const floods = state.hazard === 'floods';
  const series = replaySeries();
  const stop = SEA_LEVEL_STOPS[state.slrIndex];
  const slrFt = floods ? stop.inches / 12 : 0;
  const baseFt = floods ? waterNowFt() : 0;

  if (series) {
    const k = hourOf(series);
    const tide = (ft) => `<b>${Math.abs(ft).toFixed(1)} ft</b> ${ft < 0 ? 'below' : 'above'} normal high tide`;
    $('tm-readout').innerHTML = `${esc(storyTime(series.time[k]))}${k === series.peak ? ' (the peak)' : ''} · water at the Battery ${tide(baseFt)}${slrFt ? `; on ${esc(stop.label)} seas, ${tide(baseFt + slrFt)}` : ''}`;
  }

  const wanted = floods && (series || slrFt > 0);
  if (!wanted || !terrain) {
    mapView.setFloodExtent(null);
    $('flood-key').hidden = true;
    $('tm-delta').innerHTML = wanted ? '<p class="note">Loading the elevation map…</p>' : floods ? '' : '<p class="note">Sea level and flood extent apply to the Floods tab. Try a preset above.</p>';
    return;
  }

  const { grid } = terrain;
  const baseM = waterNavdMeters(baseFt);
  const base = floodMask(grid, baseM);
  const plus = slrFt ? floodMask(grid, waterNavdMeters(baseFt + slrFt)) : null;
  mapView.setFloodExtent(floodImage(grid, { base, plus, baseLevelM: baseM, baseRgb: cssRgb('--flood-base'), plusRgb: cssRgb('--delta') }), grid.size, grid.bbox);
  $('flood-key').hidden = false;
  $('flood-key').querySelector('.k-plus').parentElement.hidden = !plus;
  $('flood-key').querySelector('.k-worse').parentElement.hidden = !(riskDelta && riskDelta.worse.size);
  $('tm-delta').innerHTML = deltaHtml(floodCounts(grid, plus ? [base, plus] : [base]), { series, stop, baseFt });
}

function deltaHtml(counts, { series, stop, baseFt }) {
  const cell = terrain.cellKm2;
  const total = (arr) => {
    let s = 0;
    for (let c = 1; c < arr.length; c++) s += arr[c];
    return s;
  };
  const a = total(counts.wet[0]) * cell;
  const when = series ? 'at this hour' : 'at the highest tide of the next 48 hours';
  const stats = [
    `<div class="delta-stat"><span class="label">Land under water</span><span class="v">${km2(a)}<small>km²</small></span><span class="note">${sqmi(a)} sq mi ${esc(when)}${stop.inches ? ", today's seas" : ''}</span></div>`,
  ];
  let list = '';
  let note = '';
  if (counts.wet[1]) {
    const b = total(counts.wet[1]) * cell;
    const pct = a > 0.05 ? `+${Math.round(((b - a) / a) * 100)}%` : 'new';
    stats.push(
      `<div class="delta-stat"><span class="label">With +${stop.inches} in of sea</span><span class="v">${km2(b)}<small>km²</small></span><span class="d">+${km2(b - a)} km² · ${pct}</span></div>`,
    );
    // the rated neighborhoods that gain the most flooded land
    const rows = [];
    for (const [id, t] of terrain.areas) {
      let land = 0;
      let w0 = 0;
      let w1 = 0;
      for (const code of t.codes) {
        land += counts.land[code];
        w0 += counts.wet[0][code];
        w1 += counts.wet[1][code];
      }
      const pts = land ? ((w1 - w0) / land) * 100 : 0;
      if (pts >= 1) rows.push({ area: AREAS.find((x) => x.id === id), pts, now: (w1 / land) * 100 });
    }
    rows.sort((x, y) => y.pts - x.pts);
    if (rows.length)
      list = `<p class="label" style="margin-top:16px">Most newly flooded land</p><ul class="delta-list">${rows
        .slice(0, 5)
        .map((r) => `<li><span>${esc(r.area.name)}</span><span class="num">+${Math.round(r.pts)} pts → ${Math.round(r.now)}% of land</span></li>`)
        .join('')}</ul>`;
    const ups = riskDelta ? [...riskDelta.worse].map((id) => AREAS.find((x) => x.id === id).name) : [];
    note = ups.length
      ? `<p class="note delta-note"><b class="up">${ups.length} neighborhood${ups.length === 1 ? '' : 's'} move up a risk level</b> (dashed outline): ${esc(ups.slice(0, 6).join(', '))}${ups.length > 6 ? '…' : ''}.</p>`
      : `<p class="note delta-note">No neighborhood changes risk level${series ? `: in ${esc(scenarioById(state.scenario).short)} the hardest-hit places are already at the top of the scale` : ''}. The extra water shows up on the map instead, in orange.</p>`;
  } else {
    stats.push(`<div class="delta-stat"><span class="label">Water at the Battery</span><span class="v">${baseFt.toFixed(1)}<small>ft</small></span><span class="note">above normal high tide</span></div>`);
    note = '<p class="note delta-note">Raise the sea level above to see what the same water does on future seas.</p>';
  }
  return `<div class="delta-stats">${stats.join('')}</div>${note}${list}`;
}

let playFrame = 0;
function stopPlay() {
  if (!state.playing) return;
  state.playing = false;
  cancelAnimationFrame(playFrame);
  $('tm-play').setAttribute('aria-pressed', 'false');
  $('tm-play').textContent = '▶ Play';
}

function startPlay() {
  const series = replaySeries();
  if (!series) return;
  state.playing = true;
  $('tm-play').setAttribute('aria-pressed', 'true');
  $('tm-play').textContent = '❚❚ Pause';
  if (hourOf(series) >= series.level.length - 1) state.hour = 0;
  const msPerHour = reducedMotion() ? 600 : 160;
  let last = performance.now();
  const step = (now) => {
    if (!state.playing) return;
    if (now - last >= msPerHour) {
      last = now;
      const next = hourOf(series) + 1;
      if (next >= series.level.length) return stopPlay();
      state.hour = next;
      $('hour-range').value = String(next);
      setFill($('hour-range'));
      renderFloodView();
    }
    playFrame = requestAnimationFrame(step);
  };
  playFrame = requestAnimationFrame(step);
}

// ---------------- terrain: elevation grid for flood extent, higher ground and the comparison ----------------

function loadTerrain() {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = ELEVATION.url;
  }).then((img) => {
    const c = document.createElement('canvas');
    c.width = c.height = ELEVATION.size;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return gridFromPixels(ctx.getImageData(0, 0, ELEVATION.size, ELEVATION.size).data);
  });
}

/** Once the grid and the neighborhood shapes are both in, summarize each rated neighborhood. */
function prepareTerrain(grid, features) {
  const sandyFt = scenarioInputs('sandy').tides.battery.peak;
  const sandy = floodMask(grid, waterNavdMeters(sandyFt));
  const future = floodMask(grid, waterNavdMeters(sandyFt + FUTURE_STOP.inches / 12));
  const counts = floodCounts(grid, [sandy, future]);
  const medians = medianElevationByNta(grid);
  const areas = new Map();
  for (const area of AREAS) {
    const codes = [];
    features.forEach((f, k) => {
      if (f.properties.areas.includes(area.id)) codes.push(k + 1);
    });
    let land = 0;
    let w0 = 0;
    let w1 = 0;
    let elevSum = 0;
    for (const code of codes) {
      land += counts.land[code];
      w0 += counts.wet[0][code];
      w1 += counts.wet[1][code];
      if (medians.has(code)) elevSum += medians.get(code) * counts.land[code];
    }
    areas.set(area.id, land ? { codes, medianM: elevSum / land, sandyPct: (w0 / land) * 100, futurePct: (w1 / land) * 100 } : { codes, medianM: null, sandyPct: null, futurePct: null });
  }
  return { grid, cellKm2: cellAreaKm2(grid), sandyFt, areas };
}

/** Elevation-based refuge for a point: where a Sandy-size storm reaches, and the nearest ground well above it. */
function terrainRefuge(lat, lon) {
  if (!terrain) return false;
  const { grid, sandyFt } = terrain;
  const hereM = elevationAt(grid, lat, lon);
  const sandyM = waterNavdMeters(sandyFt);
  const futureM = waterNavdMeters(sandyFt + FUTURE_STOP.inches / 12);
  const minM = futureM + HIGHER_MARGIN_M;
  let higher = null;
  if (hereM != null && hereM < minM) {
    const h = nearestHigherGround(grid, lat, lon, minM, 5);
    if (h) higher = { ...h, compass: compassWord(lat, lon, h.lat, h.lon), minutes: walkMinutes(Math.max(h.km, h.routeKm)) };
  }
  return { hereM, sandyM, futureM, minM, higher };
}

function nearestCenter(centers, lat, lon) {
  let best = null;
  for (const c of centers) {
    const km = distanceKm(lat, lon, c.lat, c.lon);
    if (!best || km < best.km) best = { ...c, km };
  }
  return best && { ...best, compass: compassWord(lat, lon, best.lat, best.lon) };
}

// ---------------- routing ----------------

/** #heat, #floods/sandy, #floods/live/2080s: shareable links into a view. */
function readHash() {
  const [hazard, scenario, slr] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (!HAZARD_ORDER.includes(hazard)) return false;
  state.hazard = hazard;
  const next = scenario && scenariosFor(hazard).some((s) => s.id === scenario) ? scenario : 'live';
  if (next !== state.scenario) state.hour = null;
  state.scenario = next;
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

// ---------------- views and tabs ----------------

let stageStarted = false;
function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  const toStory = view === 'story';
  $('view-toggle').textContent = toStory ? 'Dashboard' : '3D story';
  window.scrollTo(0, 0);
  if (toStory) {
    // the 3D stage (and its 600 KB of three.js) only loads for people who ask for the story
    if (!stageStarted) {
      stageStarted = true;
      (window.requestIdleCallback || ((f) => setTimeout(f, 200)))(startStage);
    }
    story.start();
  } else {
    story.pause();
  }
  mapView.invalidate();
}

const TABS = ['ranking', 'details', 'ready', 'method'];
function selectTab(name, focus = false) {
  state.tab = name;
  for (const t of TABS) {
    const on = t === name;
    $(`tab-${t}`).setAttribute('aria-selected', String(on));
    $(`tab-${t}`).tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
  }
  if (focus) $(`tab-${name}`).focus();
}

// ---------------- neighborhood vs. neighborhood ----------------

function fillCompareSelects() {
  const byBorough = new Map();
  for (const a of AREAS) {
    if (!byBorough.has(a.borough)) byBorough.set(a.borough, []);
    byBorough.get(a.borough).push(a);
  }
  const html = [...byBorough]
    .map(([b, list]) => `<optgroup label="${esc(b)}">${list.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</optgroup>`)
    .join('');
  $('cmp-a').innerHTML = html;
  $('cmp-b').innerHTML = html;
  const name = (id) => AREAS.find((a) => a.id === id).name;
  $('cmp-presets').innerHTML =
    '<span class="label" style="align-self:center;margin-right:4px">Try</span>' +
    COMPARE_PRESETS.map(([a, b]) => `<button type="button" data-a="${a}" data-b="${b}">${esc(name(a))} vs. ${esc(name(b))}</button>`).join('');
}

function openCompare() {
  $('compare').showModal();
  renderCompare();
}

function compareSide(id) {
  const i = AREAS.findIndex((a) => a.id === id);
  const area = AREAS[i];
  const results = Object.fromEntries(HAZARD_ORDER.map((h) => [h, assessPlace(h, area, inputsFor(h), i)]));
  if (!zoneCache.has(id)) {
    zoneCache.set(id, undefined);
    fetchEvacuationZone(area.lat, area.lon)
      .catch(() => 'error')
      .then((z) => {
        zoneCache.set(id, z);
        if ($('compare').open) renderCompare();
      });
  }
  return { area, results, terrain: terrain ? terrain.areas.get(id) : null, zone: zoneCache.get(id) };
}

function renderCompare() {
  const { a, b } = state.compare;
  $('cmp-a').value = a;
  $('cmp-b').value = b;
  const s = scenarioById(state.scenario);
  const stop = SEA_LEVEL_STOPS[state.slrIndex];
  const available = Object.fromEntries(HAZARD_ORDER.map((h) => [h, !(isLive() && !state.liveLoaded) && hasData(h, inputsFor(h))]));
  $('cmp-body').innerHTML = compareHtml(compareSide(a), compareSide(b), {
    available,
    when: s ? `in the ${s.short} ${s.year} replay` : 'right now',
    slrLabel: stop.inches ? `${stop.label} (+${stop.inches} in)` : '',
  });
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
  state.point = { place, idx, loading: true, fema: null, history: null, pointWeather: null, refuge: { zone: undefined, center: undefined } };
  mapView.showPoint(lat, lon);
  mapView.clearRefuge();
  renderPoint();
  if (scroll) $('report').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });

  // the safety plan fills in as each piece answers
  const zoneP = track('evac', fetchEvacuationZone(lat, lon)).then((z) => (z === null && state.status.evac && !state.status.evac.ok ? 'error' : z));
  const centerP = fetchEvacuationCenters()
    .then((list) => nearestCenter(list, lat, lon))
    .catch(() => 'error');
  for (const [key, p] of [['zone', zoneP], ['center', centerP]]) {
    p.then((v) => {
      if (id !== pointRequest) return;
      state.point.refuge[key] = v;
      renderPoint();
      // markers go up as soon as the nearest center is known; no need to wait for FEMA or 311
      if (key === 'center') drawRefuge({ frame: true });
    });
  }

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
  Object.assign(state.point, { place, idx, loading: false, fema, history, pointWeather });
  renderPoint();
  renderSources(SOURCES, state.status);
}

/** Markers for the evacuation center and higher ground; `frame` zooms to fit them. */
function drawRefuge({ frame = false } = {}) {
  const p = state.point;
  if (!p) return;
  const c = p.refuge.center;
  const t = p.refuge.terrain || null;
  const higher = t && t.higher ? t.higher : null;
  const ec = c && c !== 'error' ? c : null;
  mapView.showRefuge(p.place, { center: ec, higher });
  if (frame) mapView.frame([p.place, higher, ec && ec.km < 6 ? ec : null]);
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
  if (!p.refuge.terrain && terrain) p.refuge.terrain = terrainRefuge(p.place.lat, p.place.lon);
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
    pending: isLive() && !state.liveLoaded,
    refuge: { ...p.refuge, terrain: p.refuge.terrain || false },
  };
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
      results.innerHTML = "<p>Address search isn't responding right now. You can click any spot on the map instead.</p>";
    }
  });
  input.addEventListener('input', () => {
    if (!input.value) results.innerHTML = '';
  });
}

// ---------------- events ----------------

let renderQueued = false;
/** Coalesce rapid slider input into one render per frame, so dragging stays snappy. */
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderApp();
  });
}

$('mode-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-scenario]');
  if (!b) return;
  if (b.dataset.scenario !== state.scenario) state.hour = null;
  state.scenario = b.dataset.scenario;
  stopPlay();
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
$('slr-range').addEventListener('input', (e) => {
  state.slrIndex = +e.target.value;
  setFill(e.target);
  queueRender();
});
$('hour-range').addEventListener('input', (e) => {
  stopPlay();
  state.hour = +e.target.value;
  setFill(e.target);
  renderFloodView();
});
$('tm-play').addEventListener('click', () => (state.playing ? stopPlay() : startPlay()));
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
  // the map is sticky beside the table on wide screens, so this only scrolls on phones
  $('map').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
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
$('dash-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[role="tab"]');
  if (b) selectTab(b.id.replace('tab-', ''));
});
$('dash-tabs').addEventListener('keydown', (e) => {
  const i = TABS.indexOf(state.tab);
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
  if (next == null) return;
  e.preventDefault();
  selectTab(TABS[(next + TABS.length) % TABS.length], true);
});
$('view-toggle').addEventListener('click', () => setView(state.view === 'story' ? 'dashboard' : 'story'));
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b && b.tagName === 'BUTTON') setView(b.dataset.view);
});
for (const id of ['open-compare', 'compare-inline']) $(id).addEventListener('click', openCompare);
$('compare-close').addEventListener('click', () => $('compare').close());
$('compare').addEventListener('click', (e) => {
  if (e.target === $('compare')) $('compare').close(); // a click on the backdrop
});
for (const side of ['a', 'b']) {
  $(`cmp-${side}`).addEventListener('change', (e) => {
    state.compare[side] = e.target.value;
    renderCompare();
  });
}
$('cmp-swap').addEventListener('click', () => {
  state.compare = { a: state.compare.b, b: state.compare.a };
  renderCompare();
});
$('cmp-presets').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-a]');
  if (!b) return;
  state.compare = { a: b.dataset.a, b: b.dataset.b };
  renderCompare();
});
window.addEventListener('hashchange', () => {
  if (readHash()) setHazard(state.hazard);
});

// theme: the button names the theme you'd switch to. The map needs nothing: CSS re-filters the same tiles.
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
  renderFloodView(); // the overlay's colors come from the theme
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (document.documentElement.dataset.theme) return;
  story.setTheme(effectiveTheme());
  syncThemeButton();
  renderFloodView();
});

// ---------------- 3D: only when the story view opens, and only where it will run well ----------------

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
  onClick: (lat, lon) => {
    const area = AREAS[nearestAreaIndex(lat, lon)];
    checkPoint({ lat, lon, label: `A spot near ${area.name}`, borough: null, needsName: true });
  },
});
renderLayers();
fillCompareSelects();
const checklist = initChecklist(state.hazard, {
  onProgress: (done, total) => {
    $('ready-count').textContent = `${done}/${total}`;
  },
});
renderSeaLevel();
renderMethodology(state.hazard);
selectTab('ranking');
renderApp();
const ntaLoad = mapView.loadNtas().then((features) => {
  renderApp();
  return features;
});
// the map box can change size after fonts load; reframe the city when it first scrolls into view
new IntersectionObserver((entries, obs) => {
  if (entries.some((e) => e.isIntersecting)) {
    mapView.fitCity();
    obs.disconnect();
  }
}).observe($('map'));
wireSearch('address-form', 'address-input', 'address-results', { scroll: true });
wireSearch('address-form-2', 'address-input-2', 'address-results-2', { scroll: false });

loadLive();
setInterval(() => {
  if (!document.hidden) loadLive();
}, REFRESH_MS);

// the elevation grid (290 KB) powers the time machine's flood map, higher ground and the comparison
Promise.all([loadTerrain(), ntaLoad])
  .then(([grid, features]) => {
    terrain = prepareTerrain(grid, features);
    state.status.elevation = { ok: true };
    renderApp();
    if (state.point && state.point.refuge.center !== undefined) drawRefuge();
  })
  .catch((err) => {
    console.warn('[DrainWatch] elevation map failed to load', err);
    state.status.elevation = { ok: false, message: 'offline' };
    renderSources(SOURCES, state.status);
  });

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
