// HTML for the sidebar cards, map popups and the address report card.
// Pure functions of their inputs: app.js decides when to call them.

import { AREAS, RAIN_BENCHMARKS, TIDE_STATIONS } from './config.js';
import { LEVELS, levelLabel } from './risk.js';
import { aqiCategory } from './air-risk.js';
import { WIND_THRESHOLDS } from './storm-risk.js';
import { HAZARDS, HAZARD_ORDER, alertsFor } from './hazards.js';
import { timeChartSvg } from './charts.js';
import { tideChartSvg } from './tide-chart.js';
import { badge, empty, esc, exposureWord, fmtTime, icon, stat, windExposureWord } from './ui.js';

const ICON = { floods: 'floods', heat: 'heat', air: 'air', wind: 'wind' };

// ---------------- sidebar cards ----------------

function card(title, body, { sub = '', iconName = null } = {}) {
  return `<section class="card">
    <div class="card-head"><h2>${iconName ? icon(iconName) : ''}${esc(title)}</h2>${sub ? `<span class="card-sub">${sub}</span>` : ''}</div>
    ${body}
  </section>`;
}

function alertsCard(hazard, inputs, failed) {
  let body;
  if (failed) {
    body = empty(`Couldn't reach the National Weather Service. Check <a href="https://www.weather.gov/okx/" target="_blank" rel="noopener">weather.gov/okx</a>.`, { error: true });
  } else {
    const alerts = alertsFor(inputs.alerts, hazard);
    body = alerts.length
      ? `<ul class="alert-list">${alerts
          .map(
            (a) => `<li class="alert sev-${a.severity}">${icon('alert')}<div>
              <strong>${esc(a.event)}</strong>
              <span>${esc(a.boroughs.length === 5 ? 'All five boroughs' : a.boroughs.join(', '))}${a.ends ? ` · until ${esc(fmtTime(a.ends))}` : ''}</span>
            </div></li>`,
          )
          .join('')}</ul>`
      : empty(`No active ${HAZARDS[hazard].noun} alerts for New York City.`);
  }
  return card('Weather alerts', body, { iconName: 'alert', sub: 'National Weather Service' });
}

function worstIndex(list, key) {
  let best = -1;
  (list || []).forEach((x, i) => {
    if (x && x[key] != null && (best < 0 || x[key] > list[best][key])) best = i;
  });
  return best;
}

function floodCards(ctx) {
  const { inputs, selectedStation } = ctx;
  const out = [];

  // tides
  const options = Object.entries(TIDE_STATIONS)
    .map(([k, s]) => `<option value="${k}"${k === selectedStation ? ' selected' : ''}>${esc(s.name)}</option>`)
    .join('');
  const tide = inputs.tides ? inputs.tides[selectedStation] : null;
  let tideBody = `<label class="select">Tide gauge <select id="station-select">${options}</select></label>`;
  if (!tide) {
    tideBody += empty('No tide data from NOAA for this gauge right now.', { error: true });
  } else {
    const surge = tide.surge == null ? '—' : `${tide.surge > 0 ? '+' : ''}${tide.surge.toFixed(1)}`;
    tideBody += `<dl class="stats">
        ${stat('Now', tide.latest ? tide.latest.v.toFixed(1) : '—', 'ft')}
        ${stat('Storm surge', surge, 'ft')}
        ${stat('48 h peak', tide.peak != null ? tide.peak.toFixed(1) : '—', 'ft')}
      </dl>
      ${tideChartSvg(tide)}
      <p class="note">Hurricane Sandy peaked around 9 ft above normal high tide at the Battery.</p>`;
  }
  out.push(card('Coastal: tide & storm surge', tideBody, { iconName: 'wave', sub: 'NOAA' }));

  // rain
  const w = inputs.weather;
  const i = worstIndex(w, 'maxHourly');
  let rainBody;
  if (!w || i < 0) {
    rainBody = empty("Couldn't load the rainfall forecast.", { error: true });
  } else {
    const top = w[i];
    const total = Math.max(...w.map((r) => r.next48Total));
    const past = Math.max(...w.map((r) => r.past24));
    const pct = (top.maxHourly / RAIN_BENCHMARKS.sewerDesign) * 100;
    const level = pct >= 100 ? 'severe' : pct >= 57 ? 'high' : pct >= 28 ? 'elevated' : 'low';
    rainBody = `<dl class="stats">
        ${stat('Peak rate', top.maxHourly.toFixed(2), 'in/hr')}
        ${stat('Next 48 h', total.toFixed(1), 'in')}
        ${stat('Past 24 h', past.toFixed(1), 'in')}
      </dl>
      <div class="meter lvl-${level}" role="img" aria-label="Peak rain rate is ${pct.toFixed(0)}% of sewer design capacity">
        <div class="meter-fill" style="width:${Math.min(100, pct).toFixed(1)}%"></div>
      </div>
      <div class="meter-labels"><span>${pct.toFixed(0)}% of sewer capacity</span><span>${RAIN_BENCHMARKS.sewerDesign} in/hr</span></div>
      <div style="margin-top:14px">
      ${timeChartSvg({
        rows: top.hourly.map((r) => ({ t: r.t, v: r.precip })),
        type: 'bar',
        unit: ' in',
        decimals: 2,
        yMin: 0,
        thresholds: [
          { value: 0.5, label: 'Heavy', level: 'elevated' },
          { value: 1, label: 'Intense', level: 'high' },
          { value: RAIN_BENCHMARKS.sewerDesign, label: 'Sewers full', level: 'severe' },
        ],
        ariaLabel: `Hourly rainfall forecast near ${AREAS[i].name}`,
      })}</div>
      <p class="note">Hourly rain near ${esc(AREAS[i].name)}${top.maxHourlyTime ? `, heaviest ${esc(fmtTime(top.maxHourlyTime))}` : ''}. Hourly forecasts smooth out short cloudbursts, so real peaks can be higher.</p>`;
  }
  out.push(card('Stormwater: rainfall', rainBody, { iconName: 'floods', sub: 'Open-Meteo' }));
  return out;
}

function heatCards(ctx) {
  const w = ctx.inputs.weather;
  const i = worstIndex(w, 'maxHeatIndex');
  if (!w || i < 0) return [card('Heat index', empty("Couldn't load the temperature forecast.", { error: true }), { iconName: 'heat' })];
  const top = w[i];
  const body = `<dl class="stats">
      ${stat('Feels like', Math.round(top.maxHeatIndex), '°F')}
      ${stat('High', top.maxTemp != null ? Math.round(top.maxTemp) : '—', '°F')}
      ${stat('Overnight low', top.overnightLow != null ? Math.round(top.overnightLow) : '—', '°F')}
    </dl>
    ${timeChartSvg({
      rows: top.hourly.map((r) => ({ t: r.t, v: r.hi })),
      unit: '°F',
      thresholds: [
        { value: 90, label: 'Hot', level: 'elevated' },
        { value: 100, label: 'Advisory', level: 'high' },
        { value: 105, label: 'Warning', level: 'severe' },
      ],
      ariaLabel: `Heat index for the next 48 hours near ${AREAS[i].name}`,
    })}
    <p class="note">Heat index (temperature plus humidity) near ${esc(AREAS[i].name)}, the hottest tracked neighborhood${top.maxHeatIndexTime ? `, peaking ${esc(fmtTime(top.maxHeatIndexTime))}` : ''}.</p>`;

  const vulnerable = AREAS.filter((a) => a.hvi === 5).map((a) => a.name);
  const why = `<p class="small">Heat kills more New Yorkers than any other kind of extreme weather. The risk is not shared equally:
      neighborhoods with fewer trees, more pavement and less air conditioning stay hotter, day and night.</p>
    <p class="note">Highest heat vulnerability (HVI 5 of 5) among tracked neighborhoods: ${esc(vulnerable.join(', '))}.</p>`;
  return [card('Heat index', body, { iconName: 'heat', sub: 'Open-Meteo' }), card('Who is most at risk', why, { iconName: 'shield', sub: 'NYC Heat Vulnerability Index' })];
}

function airCards(ctx) {
  const a = ctx.inputs.air;
  const i = worstIndex(a, 'peakAqi');
  if (!a || i < 0) return [card('Air Quality Index', empty("Couldn't load the air quality forecast.", { error: true }), { iconName: 'air' })];
  const top = a[i];
  const body = `<dl class="stats">
      ${stat('AQI now', top.currentAqi != null ? Math.round(top.currentAqi) : '—')}
      ${stat('48 h peak', Math.round(top.peakAqi))}
      ${stat('PM2.5 now', top.pm25 != null ? Math.round(top.pm25) : '—', 'µg/m³')}
    </dl>
    ${timeChartSvg({
      rows: top.hourly.map((r) => ({ t: r.t, v: r.aqi })),
      unit: '',
      yMin: 0,
      thresholds: [
        { value: 50, label: 'Moderate', level: 'elevated' },
        { value: 100, label: 'Sensitive', level: 'high' },
        { value: 150, label: 'Unhealthy', level: 'severe' },
      ],
      ariaLabel: `US Air Quality Index for the next 48 hours near ${AREAS[i].name}`,
    })}
    <p class="note">US AQI near ${esc(AREAS[i].name)}. Now: <strong>${esc(aqiCategory(top.currentAqi) || '—')}</strong>. Mostly ${top.dominant === 'ozone' ? 'ozone (smog)' : 'fine particles (PM2.5), the main pollutant in wildfire smoke'}.</p>`;
  return [card('Air Quality Index', body, { iconName: 'air', sub: 'Open-Meteo · EPA scale' })];
}

function windCards(ctx) {
  const w = ctx.inputs.weather;
  const i = worstIndex(w, 'maxGust');
  if (!w || i < 0) return [card('Wind gusts', empty("Couldn't load the wind forecast.", { error: true }), { iconName: 'wind' })];
  const top = w[i];
  const thunder = top.weatherCodes.some((c) => c >= 95);
  const body = `<dl class="stats">
      ${stat('Peak gust', Math.round(top.maxGust), 'mph')}
      ${stat('Sustained', top.maxWind != null ? Math.round(top.maxWind) : '—', 'mph')}
      ${stat('Thunder', thunder ? 'Yes' : 'No')}
    </dl>
    ${timeChartSvg({
      rows: top.hourly.map((r) => ({ t: r.t, v: r.gust })),
      unit: ' mph',
      yMin: 0,
      thresholds: [
        { value: WIND_THRESHOLDS.advisoryGust, label: 'Advisory', level: 'elevated' },
        { value: WIND_THRESHOLDS.warningGust, label: 'Warning', level: 'high' },
        { value: WIND_THRESHOLDS.hurricaneGust, label: 'Hurricane', level: 'severe' },
      ],
      ariaLabel: `Wind gusts for the next 48 hours near ${AREAS[i].name}`,
    })}
    <p class="note">Gusts near ${esc(AREAS[i].name)}${top.maxGustTime ? `, strongest ${esc(fmtTime(top.maxGustTime))}` : ''}. Gusts of ${WIND_THRESHOLDS.warningGust}+ mph bring down trees and power lines.</p>`;
  return [card('Wind gusts', body, { iconName: 'wind', sub: 'Open-Meteo' })];
}

const CARDS = { floods: floodCards, heat: heatCards, air: airCards, wind: windCards };

/** ctx: { hazard, inputs, status, selectedStation, isLive } */
export function hazardCardsHtml(ctx) {
  const failedAlerts = ctx.isLive && ctx.status.alerts && !ctx.status.alerts.ok;
  return [alertsCard(ctx.hazard, ctx.inputs, failedAlerts), ...CARDS[ctx.hazard](ctx)].join('');
}

// ---------------- ranking ----------------

export function rankingHtml(results, available) {
  const sorted = [...results].sort((a, b) => b.score - a.score || a.area.name.localeCompare(b.area.name));
  return sorted
    .map((r, i) => {
      const level = available ? r.level : 'none';
      return `<li><button type="button" class="area-row" data-id="${r.area.id}">
        <span class="area-rank">${i + 1}</span>
        <span class="area-name"><span>${esc(r.area.name)}</span><small>${esc(r.area.borough)}</small></span>
        <span class="area-bar lvl-${level}" aria-hidden="true"><i style="width:${available ? Math.max(4, (r.score / 4) * 100) : 0}%"></i></span>
        <span class="area-level lvl-${level}"><span class="dot"></span>${available ? levelLabel(r.level) : 'No data'}</span>
      </button></li>`;
    })
    .join('');
}

// ---------------- legend ----------------

export function legendHtml(hazard) {
  const extra =
    hazard === 'floods'
      ? `<div class="legend-row"><span><i class="dot report"></i>311 flood report</span><span>${icon('wave')} Tide gauge</span></div>`
      : '';
  return `<div class="legend-title">${esc(HAZARDS[hazard].title)}</div>
    <div class="legend-row">${LEVELS.map((l) => `<span class="lvl-${l.level}"><i class="dot"></i>${l.label}</span>`).join('')}</div>${extra}`;
}

// ---------------- popups ----------------

function detailRows(hazard, r) {
  const a = r.area;
  if (hazard === 'floods') {
    return `<table class="mini"><tr><th></th><th>Exposure</th><th>Risk now</th></tr>
      <tr><td>Coastal</td><td>${exposureWord(a.coastalExposure)}</td><td>${r.coastal.toFixed(1)}</td></tr>
      <tr><td>Stormwater</td><td>${exposureWord(a.stormwaterExposure)}</td><td>${r.stormwater.toFixed(1)}</td></tr></table>`;
  }
  if (hazard === 'heat') {
    const w = r.weather;
    return `<table class="mini">
      <tr><th>Heat vulnerability</th><td>${a.hvi} of 5</td></tr>
      <tr><th>Peak heat index</th><td>${w && w.maxHeatIndex != null ? `${Math.round(w.maxHeatIndex)}°F` : '—'}</td></tr>
      <tr><th>Overnight low</th><td>${w && w.overnightLow != null ? `${Math.round(w.overnightLow)}°F` : '—'}</td></tr></table>`;
  }
  if (hazard === 'air') {
    const x = r.air;
    return `<table class="mini">
      <tr><th>Asthma burden</th><td>${a.asthma} of 5</td></tr>
      <tr><th>AQI now</th><td>${x && x.currentAqi != null ? Math.round(x.currentAqi) : '—'}</td></tr>
      <tr><th>48 h peak AQI</th><td>${x && x.peakAqi != null ? `${Math.round(x.peakAqi)} (${esc(aqiCategory(x.peakAqi))})` : '—'}</td></tr></table>`;
  }
  const w = r.weather;
  return `<table class="mini">
    <tr><th>Wind exposure</th><td>${windExposureWord(a.windExposure)}</td></tr>
    <tr><th>Peak gust</th><td>${w && w.maxGust != null ? `${Math.round(w.maxGust)} mph` : '—'}</td></tr>
    <tr><th>Sustained</th><td>${w && w.maxWind != null ? `${Math.round(w.maxWind)} mph` : '—'}</td></tr></table>`;
}

export function areaPopupHtml(hazard, r, available) {
  const a = r.area;
  return `<div class="popup">
      <h3>${esc(a.name)}</h3>
      <p class="sub">${esc(a.borough)} · ${esc(HAZARDS[hazard].title)}</p>
      <p>${available ? badge(r.level) : badge('none')} ${available ? `<span class="muted small">score ${r.score.toFixed(1)} / 4</span>` : ''}</p>
      ${available ? `<ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="small muted">Live data is unavailable.</p>'}
      ${detailRows(hazard, r)}
      ${r.missing.length && available ? `<p class="warn small">Missing data: ${esc(r.missing.join(', '))}</p>` : ''}
    </div>`;
}

export function areaTooltipHtml(hazard, r, available) {
  return `${esc(r.area.name)} <span class="tip-level">· ${available ? levelLabel(r.level) : 'No data'}</span>`;
}

export function reportPopupHtml(rep) {
  return `<div class="popup"><h3>${esc(rep.place.label)}</h3>
    <p class="sub">${esc(rep.borough)}</p>
    <table class="mini">${HAZARD_ORDER.map((h) => `<tr><th>${esc(HAZARDS[h].label)}</th><td>${rep.results[h] ? badge(rep.available[h] ? rep.results[h].level : 'none') : '…'}</td></tr>`).join('')}</table></div>`;
}

export function stationPopupHtml(key, s, tide) {
  const text = tide && tide.latest ? `${tide.latest.v.toFixed(2)} ft vs. normal high tide` : 'No data right now';
  return `<div class="popup"><h3>${esc(s.name)}</h3><p class="sub">NOAA tide gauge</p><p>${esc(text)}</p>
    <p><a href="https://tidesandcurrents.noaa.gov/stationhome.html?id=${s.id}" target="_blank" rel="noopener">NOAA station ${s.id}</a></p></div>`;
}

export function reportPinPopupHtml(rep) {
  return `<div class="popup"><h3>${esc(rep.descriptor)}</h3><p class="sub">311 report · ${esc(fmtTime(rep.created))}</p><p class="small">${esc(rep.address)}</p></div>`;
}

// ---------------- address report card ----------------

/**
 * rep: { place, borough, nearest, loading, fema, history, stationName,
 *        results: { hazard: result }, available: { hazard: bool } }
 */
export function reportCardHtml(rep, currentHazard) {
  const rows = HAZARD_ORDER.map((h) => {
    const r = rep.results[h];
    const ok = rep.available[h];
    const why = !r ? 'Checking…' : ok ? r.reasons[0] : 'Live data unavailable';
    return `<li><button type="button" class="report-row" data-hazard="${h}"${h === currentHazard ? ' aria-current="true"' : ''}>
      <span class="hz-icon" style="color:var(--hz-${h})">${icon(ICON[h])}</span>
      <span><strong>${esc(HAZARDS[h].label)}</strong><span class="why">${esc(why)}</span></span>
      ${r ? badge(ok ? r.level : 'none') : badge('none', '…')}
    </button></li>`;
  }).join('');

  let zone = 'Checking FEMA…';
  if (!rep.loading) {
    if (!rep.fema) zone = 'FEMA lookup failed. Using the nearest neighborhood rating.';
    else if (!rep.fema.zone) zone = 'Outside mapped FEMA flood zones';
    else {
      const sub = rep.fema.subtype ? ` (${rep.fema.subtype.toLowerCase()})` : '';
      zone = `Zone <strong>${esc(rep.fema.zone)}</strong>${esc(sub)}${/^[AV]/i.test(rep.fema.zone) ? ': inside the 1% annual chance (100-year) floodplain' : ''}`;
    }
  }
  const history = rep.loading ? 'Checking 311…' : rep.history == null ? '311 history unavailable' : `${rep.history} flooding reports within 500 m in the past year`;

  return `<section class="card report" aria-live="polite">
    <div class="report-head">
      ${icon('pin')}
      <div><h2>${esc(rep.place.label)}</h2><p>${esc(rep.borough)} · nearest tracked neighborhood: ${esc(rep.nearest.name)}</p></div>
      <button type="button" class="report-close" id="report-close" aria-label="Close report">${icon('close')}</button>
    </div>
    <ul class="report-rows">${rows}</ul>
    <dl class="facts-list">
      <dt>FEMA flood zone</dt><dd>${zone}</dd>
      <dt>311 history</dt><dd>${esc(history)}</dd>
      <dt>Tide gauge</dt><dd>${esc(rep.stationName)}</dd>
    </dl>
    <p class="note">Flood ratings use this exact spot. Heat, air and wind use the forecast here and the nearest neighborhood's vulnerability ratings. FEMA's effective maps date from 2007; newer maps and future sea level rise extend the floodplain.</p>
  </section>`;
}
