// "Neighborhood vs. neighborhood": two rated places side by side, every hazard
// plus the reasons behind it (exposure ratings, ground elevation, how much land
// a Sandy-size surge covers, evacuation zone). Pure HTML from its inputs.

import { HAZARDS, HAZARD_ORDER } from './hazards.js';
import { esc, exposureWord, level, windExposureWord } from './ui.js';

/** Sensible first pairs for a quick look: the same water, very different outcomes. */
export const COMPARE_PRESETS = [
  ['fidi', 'red-hook'],
  ['central-harlem', 'bpc'],
  ['rockaway', 'park-slope'],
  ['mott-haven', 'ues'],
];

const ft = (m) => Math.round(m / 0.3048);

/**
 * side: { area, results: { [hazard]: result }, terrain: null | { medianM, sandyPct, futurePct }, zone: undefined | null | 'error' | '1'–'6' }
 * ctx:  { available: { [hazard]: bool }, when: 'right now' | 'in the Sandy 2012 replay' …, slrLabel: '' | '2080s (+29 in)' }
 */
export function compareHtml(a, b, ctx) {
  const rows = [];
  let aWorse = 0;
  let bWorse = 0;

  // value rows: `worse` says which direction is riskier ('up' or 'down')
  const row = (label, va, vb, { worse = 'up', fmt = (v) => esc(v), hazard = null, note = '' } = {}) => {
    let cls = ['', ''];
    if (typeof va === 'number' && typeof vb === 'number' && va !== vb) {
      const aIsWorse = worse === 'up' ? va > vb : va < vb;
      cls = aIsWorse ? ['worse-side', ''] : ['', 'worse-side'];
    }
    rows.push(`<tr${hazard ? ` data-hazard="${hazard}"` : ''}>
      <th scope="row">${esc(label)}${note ? `<small>${esc(note)}</small>` : ''}</th>
      <td class="${cls[0]}">${fmt(va, a)}</td>
      <td class="${cls[1]}">${fmt(vb, b)}</td>
    </tr>`);
  };
  const group = (title) => rows.push(`<tr class="cmp-group"><th scope="rowgroup" colspan="3">${esc(title)}</th></tr>`);

  group(`Risk ${ctx.when}${ctx.slrLabel ? ` · floods on ${ctx.slrLabel} seas` : ''}`);
  for (const h of HAZARD_ORDER) {
    const ra = a.results[h];
    const rb = b.results[h];
    const ok = ctx.available[h];
    if (ok) {
      if (ra.score > rb.score) aWorse++;
      if (rb.score > ra.score) bWorse++;
    }
    row(HAZARDS[h].label, ok ? ra.score : null, ok ? rb.score : null, {
      hazard: h,
      fmt: (v, side) => (v == null ? level('none') : `${level(side.results[h].level)}<span class="cmp-bar lvl-${side.results[h].level}" aria-hidden="true"><span style="width:${(v / 4) * 100}%"></span></span><span class="num cmp-score">${v.toFixed(1)}</span>`),
    });
  }

  group('Why: built-in vulnerability');
  row('Coastal exposure', a.area.coastalExposure, b.area.coastalExposure, { fmt: (v) => `${exposureWord(v)} <span class="num">${v}/3</span>`, note: 'FEMA zones, Sandy inundation' });
  row('Stormwater exposure', a.area.stormwaterExposure, b.area.stormwaterExposure, { fmt: (v) => `${exposureWord(v)} <span class="num">${v}/3</span>`, note: 'DEP stormwater maps, Ida' });
  row('Heat Vulnerability Index', a.area.hvi, b.area.hvi, { fmt: (v) => `<span class="num">${v}</span> of 5`, note: 'NYC Health, 5 = most vulnerable' });
  row('Asthma burden', a.area.asthma, b.area.asthma, { fmt: (v) => `<span class="num">${v}</span> of 5` });
  row('Wind exposure', a.area.windExposure, b.area.windExposure, { fmt: (v) => esc(windExposureWord(v)) });

  group('Ground and water');
  const terr = (side, key) => (side.terrain ? side.terrain[key] : null);
  row('Typical ground elevation', terr(a, 'medianM'), terr(b, 'medianM'), {
    worse: 'down',
    note: 'median, above sea level',
    fmt: (v) => (v == null ? '<span class="note">loading…</span>' : `<span class="num">${ft(v)}</span> ft`),
  });
  row('Land under a Sandy-size surge', terr(a, 'sandyPct'), terr(b, 'sandyPct'), {
    fmt: (v) => (v == null ? '<span class="note">loading…</span>' : `<span class="num">${Math.round(v)}%</span>`),
    note: "Sandy's peak water level, connected bathtub model",
  });
  row('… with 2080s sea level (+29 in)', terr(a, 'futurePct'), terr(b, 'futurePct'), {
    fmt: (v, side) => (v == null ? '<span class="note">loading…</span>' : `<span class="num">${Math.round(v)}%</span>${side.terrain.futurePct - side.terrain.sandyPct >= 0.5 ? ` <span class="delta">+${Math.round(side.terrain.futurePct - side.terrain.sandyPct)} pts</span>` : ''}`),
  });
  const zoneNum = (z) => (z && /^[1-6]$/.test(z) ? 7 - Number(z) : z === null ? 0 : undefined);
  row('Hurricane evacuation zone', zoneNum(a.zone), zoneNum(b.zone), {
    note: "at the neighborhood's center",
    fmt: (v, side) => (side.zone === undefined ? '<span class="note">checking…</span>' : side.zone === 'error' ? '<span class="note">unavailable</span>' : side.zone ? `Zone <span class="num">${esc(side.zone)}</span>` : 'Not in a zone'),
  });

  let verdict;
  const rated = HAZARD_ORDER.filter((h) => ctx.available[h]).length;
  if (!rated) verdict = 'Live ratings are still loading; the vulnerability rows below are already final.';
  else if (aWorse === bWorse) verdict = `${esc(a.area.name)} and ${esc(b.area.name)} rate about the same ${esc(ctx.when)}.`;
  else {
    const [w, l, n] = aWorse > bWorse ? [a, b, aWorse] : [b, a, bWorse];
    verdict = `<b>${esc(w.area.name)}</b> rates riskier than ${esc(l.area.name)} on ${n} of ${rated} hazards ${esc(ctx.when)}.`;
  }
  if (a.terrain && b.terrain) {
    const diff = ft(a.terrain.medianM) - ft(b.terrain.medianM);
    if (Math.abs(diff) >= 5) verdict += ` ${esc((diff < 0 ? a : b).area.name)} sits about ${Math.abs(diff)} ft lower.`;
  }

  return `<p class="cmp-verdict">${verdict}</p>
    <table class="table cmp-table">
      <caption class="sr-only">${esc(a.area.name)} compared with ${esc(b.area.name)}</caption>
      <thead><tr><th scope="col"><span class="sr-only">Measure</span></th><th scope="col">${esc(a.area.name)}<small>${esc(a.area.borough)}</small></th><th scope="col">${esc(b.area.name)}<small>${esc(b.area.borough)}</small></th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
    <p class="note">Shaded cell: the riskier side of each row. Scores run 0–4 (Low, Elevated, High, Severe). Elevation from USGS 3DEP; evacuation zones from NYC Emergency Management.</p>`;
}
