// HTML for the app section: the forecast and alerts column, the neighborhood
// table, the address report and map popups. Pure functions of their inputs.

import { AREAS, RAIN_BENCHMARKS, TIDE_STATIONS } from './config.js';
import { LEVELS } from './risk.js';
import { aqiCategory } from './air-risk.js';
import { WIND_THRESHOLDS } from './storm-risk.js';
import { HAZARDS, HAZARD_ORDER, alertsFor } from './hazards.js';
import { timeChartSvg } from './charts.js';
import { tideChartSvg } from './tide-chart.js';
import { esc, exposureWord, fmtTime, level, windExposureWord } from './ui.js';

const quiet = (text) => `<p class="quiet">${text}</p>`;
/** Live data covers the next 48 hours; a replay covers its own window, so it says nothing. */
const span = (ctx, text = ', next 48 hours') => (ctx.isLive ? text : '');

function block(title, body) {
  return `<section><h3 class="h3">${esc(title)}</h3>${body}</section>`;
}

function worstIndex(list, key) {
  let best = -1;
  (list || []).forEach((x, i) => {
    if (x && x[key] != null && (best < 0 || x[key] > list[best][key])) best = i;
  });
  return best;
}

function alertsBlock(hazard, inputs, failed) {
  if (failed) return block('Weather alerts', quiet(`Couldn't reach the National Weather Service. Check <a href="https://www.weather.gov/okx/" target="_blank" rel="noopener">weather.gov/okx</a>.`));
  const alerts = alertsFor(inputs.alerts, hazard);
  if (!alerts.length) return block('Weather alerts', quiet(`No active ${HAZARDS[hazard].noun} alerts for New York City.`));
  return block(
    'Weather alerts',
    `<ul class="alerts">${alerts
      .map(
        (a) => `<li><strong>${esc(a.event)}</strong>
          <span>${esc(a.boroughs.length === 5 ? 'All five boroughs' : a.boroughs.join(', '))}${a.ends ? ` · until ${esc(fmtTime(a.ends))}` : ''}</span></li>`,
      )
      .join('')}</ul>`,
  );
}

function floodBlocks(ctx) {
  const { inputs, selectedStation } = ctx;
  const out = [];
  const tide = inputs.tides ? inputs.tides[selectedStation] : null;
  const options = Object.entries(TIDE_STATIONS)
    .map(([k, s]) => `<option value="${k}"${k === selectedStation ? ' selected' : ''}>${esc(s.name)}</option>`)
    .join('');
  let tideBody = `<label class="note">Tide gauge <select id="station-select">${options}</select></label>`;
  if (!tide) tideBody += quiet('No tide data from NOAA for this gauge right now.');
  else {
    tideBody += `<p class="stat-line">${tide.peak.toFixed(1)} ft<small>peak above normal high tide${span(ctx)}</small></p>
      ${tideChartSvg(tide, { live: ctx.isLive })}`;
  }
  out.push(block('Tide and storm surge', tideBody));

  const w = inputs.weather;
  const i = worstIndex(w, 'maxHourly');
  if (!w || i < 0) out.push(block('Rain', quiet("Couldn't load the rainfall forecast.")));
  else {
    const top = w[i];
    const pct = Math.round((top.maxHourly / RAIN_BENCHMARKS.sewerDesign) * 100);
    out.push(
      block(
        'Rain',
        `<p class="stat-line">${top.maxHourly.toFixed(2)} in/hr<small>peak, ${pct}% of what most sewers can drain</small></p>
        ${timeChartSvg({
          live: ctx.isLive,
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
        })}
        <p class="note">Near ${esc(AREAS[i].name)}${top.maxHourlyTime ? `, heaviest ${esc(fmtTime(top.maxHourlyTime))}` : ''}. Hourly forecasts smooth out short cloudbursts, so real peaks can be higher.</p>`,
      ),
    );
  }
  return out;
}

function heatBlocks(ctx) {
  const { inputs } = ctx;
  const w = inputs.weather;
  const i = worstIndex(w, 'maxHeatIndex');
  if (!w || i < 0) return [block('Heat index', quiet("Couldn't load the temperature forecast."))];
  const top = w[i];
  return [
    block(
      `Heat index${span(ctx)}`,
      `<p class="stat-line">${Math.round(top.maxHeatIndex)}°F<small>peak feels-like · low ${top.overnightLow != null ? Math.round(top.overnightLow) : '—'}°F</small></p>
      ${timeChartSvg({
        live: ctx.isLive,
        rows: top.hourly.map((r) => ({ t: r.t, v: r.hi })),
        unit: '°F',
        thresholds: [
          { value: 90, label: 'Hot', level: 'elevated' },
          { value: 100, label: 'Advisory', level: 'high' },
          { value: 105, label: 'Warning', level: 'severe' },
        ],
        ariaLabel: `Heat index${span(ctx, ' for the next 48 hours')} near ${AREAS[i].name}`,
      })}
      <p class="note">Temperature plus humidity near ${esc(AREAS[i].name)}, the hottest tracked neighborhood${top.maxHeatIndexTime ? `, peaking ${esc(fmtTime(top.maxHeatIndexTime))}` : ''}.</p>`,
    ),
  ];
}

function airBlocks(ctx) {
  const { inputs } = ctx;
  const a = inputs.air;
  const i = worstIndex(a, 'peakAqi');
  if (!a || i < 0) return [block('Air Quality Index', quiet("Couldn't load the air quality forecast."))];
  const top = a[i];
  return [
    block(
      `Air Quality Index${span(ctx)}`,
      `<p class="stat-line">${Math.round(top.peakAqi)}<small>peak AQI, ${esc(aqiCategory(top.peakAqi))} · now ${top.currentAqi != null ? Math.round(top.currentAqi) : '—'}</small></p>
      ${timeChartSvg({
        live: ctx.isLive,
        rows: top.hourly.map((r) => ({ t: r.t, v: r.aqi })),
        yMin: 0,
        thresholds: [
          { value: 50, label: 'Moderate', level: 'elevated' },
          { value: 100, label: 'Sensitive', level: 'high' },
          { value: 150, label: 'Unhealthy', level: 'severe' },
        ],
        ariaLabel: `US Air Quality Index${span(ctx, ' for the next 48 hours')} near ${AREAS[i].name}`,
      })}
      <p class="note">Near ${esc(AREAS[i].name)}. Mostly ${top.dominant === 'ozone' ? 'ozone (smog)' : 'fine particles (PM2.5), the main pollutant in wildfire smoke'}.</p>`,
    ),
  ];
}

function windBlocks(ctx) {
  const { inputs } = ctx;
  const w = inputs.weather;
  const i = worstIndex(w, 'maxGust');
  if (!w || i < 0) return [block('Wind gusts', quiet("Couldn't load the wind forecast."))];
  const top = w[i];
  const thunder = top.weatherCodes.some((c) => c >= 95);
  return [
    block(
      `Wind gusts${span(ctx)}`,
      `<p class="stat-line">${Math.round(top.maxGust)} mph<small>peak gust · ${thunder ? 'thunderstorms possible' : 'no thunderstorms forecast'}</small></p>
      ${timeChartSvg({
        live: ctx.isLive,
        rows: top.hourly.map((r) => ({ t: r.t, v: r.gust })),
        unit: ' mph',
        yMin: 0,
        thresholds: [
          { value: WIND_THRESHOLDS.advisoryGust, label: 'Advisory', level: 'elevated' },
          { value: WIND_THRESHOLDS.warningGust, label: 'Warning', level: 'high' },
          { value: WIND_THRESHOLDS.hurricaneGust, label: 'Hurricane', level: 'severe' },
        ],
        ariaLabel: `Wind gusts${span(ctx, ' for the next 48 hours')} near ${AREAS[i].name}`,
      })}
      <p class="note">Near ${esc(AREAS[i].name)}${top.maxGustTime ? `, strongest ${esc(fmtTime(top.maxGustTime))}` : ''}. Gusts of ${WIND_THRESHOLDS.warningGust}+ mph bring down trees and power lines.</p>`,
    ),
  ];
}

const BLOCKS = { floods: floodBlocks, heat: heatBlocks, air: airBlocks, wind: windBlocks };

/** ctx: { hazard, inputs, status, selectedStation, isLive, pending } */
export function detailsHtml(ctx) {
  if (ctx.pending) return block('Forecast', quiet('Loading live data…'));
  const failedAlerts = ctx.isLive && ctx.status.alerts && !ctx.status.alerts.ok;
  return [alertsBlock(ctx.hazard, ctx.inputs, failedAlerts), ...BLOCKS[ctx.hazard](ctx)].join('');
}

// ---------------- table, legend ----------------

/**
 * delta (optional): Map of area id → { scoreDelta, levelUp } against today's sea
 * level, shown in the time machine's change column.
 */
export function rankingRowsHtml(results, available, { limit = Infinity, delta = null } = {}) {
  const sorted = [...results].sort((a, b) => b.score - a.score || a.area.name.localeCompare(b.area.name));
  return sorted
    .slice(0, limit)
    .map((r, i) => {
      const d = delta && delta.get(r.area.id);
      const change = !d || !available ? '' : d.scoreDelta > 0.004 ? `<span class="${d.levelUp ? 'up' : ''}">+${d.scoreDelta.toFixed(1)}${d.levelUp ? ' ▲' : ''}</span>` : '<span class="same">0</span>';
      return `<tr${d && d.levelUp ? ' class="worse"' : ''}>
        <td class="num">${i + 1}</td>
        <td class="name"><button type="button" class="row-link" data-id="${r.area.id}">${esc(r.area.name)}</button> <small>${esc(r.area.borough)}</small></td>
        <td>${available ? level(r.level) : level('none')}</td>
        <td class="num">${available ? r.score.toFixed(1) : '—'}</td>
        <td class="num delta-col">${change}</td>
      </tr>`;
    })
    .join('');
}

export function legendHtml() {
  return `<span class="label">Risk</span>${LEVELS.map((l) => level(l.level, l.label)).join('')}<span class="unrated">Not rated</span>`;
}

// ---------------- popups ----------------

function detailLines(hazard, r) {
  const a = r.area;
  if (hazard === 'floods') return [`Coastal exposure: ${exposureWord(a.coastalExposure)}`, `Stormwater exposure: ${exposureWord(a.stormwaterExposure)}`];
  if (hazard === 'heat') return [`Heat Vulnerability Index ${a.hvi} of 5`, r.weather && r.weather.maxHeatIndex != null ? `Feels like up to ${Math.round(r.weather.maxHeatIndex)}°F` : null];
  if (hazard === 'air') return [`Asthma burden ${a.asthma} of 5`, r.air && r.air.peakAqi != null ? `AQI up to ${Math.round(r.air.peakAqi)}` : null];
  return [windExposureWord(a.windExposure), r.weather && r.weather.maxGust != null ? `Gusts up to ${Math.round(r.weather.maxGust)} mph` : null];
}

export function areaPopupHtml(hazard, r, available, ntaName) {
  return `<div class="popup">
    <p class="label">${esc(r.area.borough)}${ntaName && ntaName !== r.area.name ? ` · ${esc(ntaName)}` : ''}</p>
    <h4>${esc(r.area.name)}</h4>
    <p>${available ? `${level(r.level)} <span class="note">score ${r.score.toFixed(1)} of 4</span>` : level('none')}</p>
    ${available ? `<ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <p class="note" style="margin-top:8px">${detailLines(hazard, r).filter(Boolean).map(esc).join(' · ')}</p>
  </div>`;
}

export function stationPopupHtml(key, s, tide) {
  const text = tide && tide.latest ? `${tide.latest.v.toFixed(2)} ft vs. normal high tide` : 'No data right now';
  return `<div class="popup"><p class="label">NOAA tide gauge</p><h4>${esc(s.name)}</h4><p>${esc(text)}</p>
    <p><a href="https://tidesandcurrents.noaa.gov/stationhome.html?id=${s.id}" target="_blank" rel="noopener">Station ${s.id}</a></p></div>`;
}

export function reportPinPopupHtml(rep) {
  return `<div class="popup"><p class="label">311 report · ${esc(fmtTime(rep.created))}</p><h4>${esc(rep.descriptor)}</h4><p class="note">${esc(rep.address)}</p></div>`;
}

// ---------------- the address report ----------------

/**
 * rep: { place, borough, nearest, loading, fema, history, stationName,
 *        results: { hazard: result }, available: { hazard: bool } }
 */
export function reportHtml(rep, currentHazard) {
  const rows = HAZARD_ORDER.map((h) => {
    const r = rep.results[h];
    const ok = rep.available[h];
    const why = !r ? 'Checking…' : ok ? r.reasons[0] : rep.pending ? 'Loading live data…' : 'Live data unavailable';
    return `<tr data-hazard="${h}"${h === currentHazard ? ' class="here"' : ''}>
      <td class="name">${esc(HAZARDS[h].label)}</td>
      <td>${r && !rep.pending ? level(ok ? r.level : 'none') : level('none', '…')}</td>
      <td class="why">${esc(why)}</td>
    </tr>`;
  }).join('');

  let zone = 'Checking FEMA…';
  if (!rep.loading) {
    if (!rep.fema) zone = "FEMA's map service didn't answer, so this uses the nearest neighborhood's rating.";
    else if (!rep.fema.zone) zone = 'Outside mapped FEMA flood zones';
    else {
      const sub = rep.fema.subtype ? ` (${rep.fema.subtype.toLowerCase()})` : '';
      zone = `Zone ${esc(rep.fema.zone)}${esc(sub)}${/^[AV]/i.test(rep.fema.zone) ? ', inside the 1% annual chance (100-year) floodplain' : ''}`;
    }
  }
  const history = rep.loading ? 'Checking 311…' : rep.history == null ? '311 history unavailable' : `${rep.history} street-flooding reports within 500 m in the past year`;

  return `<article class="report">
    <div class="report-title">
      <p class="label">Your address</p>
      <h3>${esc(rep.place.label)}</h3>
      <p class="note">${esc(rep.borough)} · nearest rated neighborhood: ${esc(rep.nearest.name)}</p>
      <button type="button" class="report-close" id="report-close">Clear this address</button>
    </div>
    <div class="report-body">
      <table class="table">
        <thead><tr><th scope="col">Hazard</th><th scope="col">Risk</th><th scope="col">Why</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${refugeHtml(rep.refuge, currentHazard)}
      <dl class="facts">
        <dt>FEMA flood zone</dt><dd>${zone}</dd>
        <dt>311 history</dt><dd>${esc(history)}</dd>
        <dt>Tide gauge</dt><dd>${esc(rep.stationName)}</dd>
      </dl>
      <p class="note" style="margin-top:12px">Flood ratings use this exact spot. Heat, air and wind use the forecast here and the nearest rated neighborhood's vulnerability. FEMA's effective maps date from 2007; newer maps and sea level rise extend the floodplain.</p>
    </div>
  </article>`;
}

// ---------------- the refuge quick-finder ----------------

const ZONE_TEXT = {
  1: 'the most exposed to storm surge, and the first ordered to leave',
  2: 'ordered to leave in strong storms, right after zone 1',
  3: 'ordered to leave in strong hurricanes',
  4: 'ordered to leave in major hurricanes',
  5: 'ordered to leave only in the most severe hurricanes',
  6: 'ordered to leave only in the most severe hurricanes',
};

const HAZARD_LINKS = {
  floods: { href: 'https://maps.nyc.gov/hurricane/', label: 'Hurricane evacuation finder' },
  heat: { href: 'https://finder.nyc.gov/coolingcenters/', label: 'Cooling center finder' },
  air: { href: 'https://www.airnow.gov/?city=New%20York&state=NY', label: 'AirNow for New York' },
  wind: { href: 'https://www.nyc.gov/site/em/ready/guides-resources.page', label: 'NYC storm guides' },
};

const ft = (m) => Math.round(m / 0.3048);

/**
 * r: { zone: undefined (checking) | null (no zone) | '1'–'6' | 'error',
 *      center: undefined | null | 'error' | { name, address, accessible, km, compass },
 *      terrain: false (still loading) | { hereM, sandyM, futureM, minM, higher: null | { km, routeKm, compass, elevM, minutes } } }
 */
export function refugeHtml(r, hazard) {
  if (!r) return '';
  let zone;
  if (r.zone === undefined) zone = 'Checking NYC Emergency Management…';
  else if (r.zone === 'error') zone = `The zone lookup didn't answer. <a href="https://maps.nyc.gov/hurricane/" target="_blank" rel="noopener">Look it up on the city's finder ↗</a>`;
  else if (!r.zone) zone = '<b>Not in an evacuation zone.</b> In a coastal storm you most likely stay home, unless officials say otherwise.';
  else zone = `<b>Zone ${esc(r.zone)}</b>: ${ZONE_TEXT[r.zone]}.`;

  let center;
  if (r.center === undefined) center = 'Finding the nearest one…';
  else if (r.center === 'error' || !r.center) center = `Couldn't load the list. <a href="https://maps.nyc.gov/hurricane/" target="_blank" rel="noopener">Find one on the city's map ↗</a>`;
  else {
    const c = r.center;
    center = `<b>${esc(c.name)}</b>, ${esc(c.address)}<br>${c.km.toFixed(1)} km ${esc(c.compass)}${c.accessible ? ' · wheelchair accessible' : ''}. <span class="note">Opens only when an evacuation is ordered.</span>`;
  }

  let high;
  let here = '';
  const t = r.terrain;
  if (!t) high = 'Reading the elevation map…';
  else if (t.hereM == null) high = 'This spot is outside the elevation map.';
  else {
    here = `<li><span class="refuge-k">This spot</span><span class="refuge-v">About <b>${ft(t.hereM)} ft</b> above sea level. Sandy's water peaked near ${ft(t.sandyM)} ft; with 2080s seas the same storm reaches ~${ft(t.futureM)} ft.</span></li>`;
    if (t.hereM >= t.minM) high = `<b>You're already on higher ground</b>, ${ft(t.hereM - t.futureM)} ft above where a Sandy-size storm would reach in the 2080s. Floodwater is unlikely here, but heat, wind and power cuts are not.`;
    else if (!t.higher) high = '<b>No high ground within 5 km on foot.</b> Leave early when an evacuation is ordered; this is what evacuation centers are for.';
    else {
      const h = t.higher;
      high = `<b>${ft(h.elevM)} ft ground ${h.km < 0.1 ? 'right nearby' : `about ${h.km.toFixed(1)} km ${esc(h.compass)}`}</b>${h.km < 0.1 ? '' : `, roughly ${h.minutes} min on foot`} (▲ on the map). That's ${ft(h.elevM - t.futureM)} ft above a Sandy-size storm with 2080s seas.`;
    }
  }

  const link = HAZARD_LINKS[hazard];
  return `<section class="refuge" aria-label="Safety plan for this spot">
    <h4 class="h3">Safety plan for this spot</h4>
    <ul class="refuge-list">
      <li><span class="refuge-k">Evacuation zone</span><span class="refuge-v">${zone}</span></li>
      <li><span class="refuge-k">Evacuation center</span><span class="refuge-v">${center}</span></li>
      <li><span class="refuge-k">Higher ground</span><span class="refuge-v">${high}</span></li>
      ${here}
    </ul>
    <p class="refuge-links">
      <a href="${link.href}" target="_blank" rel="noopener">${esc(link.label)} ↗</a>
      <a href="https://www.nyc.gov/site/em/ready/know-your-zone.page" target="_blank" rel="noopener">Know Your Zone ↗</a>
      <a href="https://www.nyc.gov/notifynyc" target="_blank" rel="noopener">Notify NYC alerts ↗</a>
      <a href="https://portal.311.nyc.gov/" target="_blank" rel="noopener">NYC 311 ↗</a>
    </p>
    <p class="note">Higher ground comes from a ~110 m elevation grid and a straight-line distance; it is not an official route. Always follow evacuation orders from NYC Emergency Management.</p>
  </section>`;
}

