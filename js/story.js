// The sections below the dashboard: the sea level rise chart, the preparedness
// checklist (saved in this browser only) and the methodology notes.

import { SEA_LEVEL_PROJECTIONS } from './config.js';
import { LEVELS } from './risk.js';
import { HAZARDS, HAZARD_ORDER } from './hazards.js';
import { CHECKLIST, METHODOLOGY } from './content.js';
import { ringSvg, seaLevelChartSvg } from './charts.js';
import { esc, icon } from './ui.js';

const STORE_KEY = 'drainwatch-checklist';

export function renderSeaLevel() {
  document.getElementById('slr-chart').innerHTML = seaLevelChartSvg(SEA_LEVEL_PROJECTIONS);
  document.getElementById('slr-body').innerHTML = SEA_LEVEL_PROJECTIONS.map(
    (p) => `<tr><td>${esc(p.period)}</td><td>${p.low}–${p.high} in</td><td>${p.highEnd} in</td></tr>`,
  ).join('');
}

export function renderMethodology() {
  document.getElementById('methodology').innerHTML = HAZARD_ORDER.map(
    (h, i) => `<details data-hazard="${h}"${i === 0 ? ' open' : ''}>
      <summary>${icon(h)}${esc(METHODOLOGY[h].title)}</summary>
      <div>${METHODOLOGY[h].html}</div>
    </details>`,
  ).join('');
  const ranges = ['0–1', '1–2', '2–3', '3–4'];
  document.getElementById('level-scale').innerHTML = LEVELS.map(
    (l, i) => `<div class="lvl-${l.level}">${l.label}<small>score ${ranges[i]}</small></div>`,
  ).join('');
}

// ---------------- checklist ----------------

function loadChecked() {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORE_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function saveChecked(set) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify([...set]));
  } catch {
    // Private mode or storage blocked: the checklist still works for this visit.
  }
}

export function initChecklist(initialHazard = 'floods') {
  const checked = loadChecked();
  let active = initialHazard;
  const tabs = document.getElementById('prep-tabs');
  const list = document.getElementById('checklist');
  const progress = document.getElementById('prep-progress');

  const total = HAZARD_ORDER.reduce((n, h) => n + CHECKLIST[h].length, 0);
  const doneIn = (h) => CHECKLIST[h].filter((item) => checked.has(`${h}:${item.id}`)).length;

  function renderTabs() {
    tabs.innerHTML = HAZARD_ORDER.map(
      (h) => `<button type="button" class="prep-tab" role="tab" id="prep-tab-${h}" data-hazard="${h}" aria-selected="${h === active}" tabindex="${h === active ? 0 : -1}" aria-controls="checklist">
        ${icon(h)}${esc(HAZARDS[h].label)} <small>${doneIn(h)}/${CHECKLIST[h].length}</small>
      </button>`,
    ).join('');
    list.setAttribute('aria-labelledby', `prep-tab-${active}`);
  }

  function renderProgress() {
    const done = HAZARD_ORDER.reduce((n, h) => n + doneIn(h), 0);
    const msg = done === total ? 'You are ready. Share this with a neighbor.' : done === 0 ? 'Check off what you have already done.' : 'Keep going: every step counts.';
    progress.innerHTML = `${ringSvg(done, total)}<div><strong>${done} of ${total} steps</strong><span>${msg}</span></div>`;
  }

  function renderList() {
    list.innerHTML = CHECKLIST[active]
      .map((item) => {
        const key = `${active}:${item.id}`;
        return `<li><label class="check">
          <input type="checkbox" data-key="${key}"${checked.has(key) ? ' checked' : ''} />
          <span class="check-box">${icon('check')}</span>
          <span class="check-text"><strong>${esc(item.title)}</strong><span>${esc(item.text)}</span>
            ${item.link ? `<a href="${item.link.href}" target="_blank" rel="noopener">${esc(item.link.label)}${icon('external')}</a>` : ''}
          </span>
        </label></li>`;
      })
      .join('');
  }

  function select(h, focus = false) {
    active = h;
    renderTabs();
    renderList();
    if (focus) document.getElementById(`prep-tab-${h}`).focus();
  }

  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('.prep-tab');
    if (b) select(b.dataset.hazard);
  });
  tabs.addEventListener('keydown', (e) => {
    const i = HAZARD_ORDER.indexOf(active);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: HAZARD_ORDER.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    select(HAZARD_ORDER[(next + HAZARD_ORDER.length) % HAZARD_ORDER.length], true);
  });
  list.addEventListener('change', (e) => {
    const key = e.target.dataset.key;
    if (!key) return;
    if (e.target.checked) checked.add(key);
    else checked.delete(key);
    saveChecked(checked);
    renderTabs();
    renderProgress();
  });

  select(active);
  renderProgress();
  return { select };
}
