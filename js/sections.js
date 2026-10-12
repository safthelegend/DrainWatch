// The essays below the app: the preparedness checklist (saved in this browser
// only), the methodology, the sea level chart, the source list and the replay's
// numbers as a plain table.

import { SEA_LEVEL_PROJECTIONS } from './config.js';
import { HAZARDS, HAZARD_ORDER } from './hazards.js';
import { CHECKLIST, METHODOLOGY } from './content.js';
import { seaLevelChartSvg } from './charts.js';
import { storyTime } from './story/stories.js';
import { esc } from './ui.js';

const STORE_KEY = 'drainwatch-checklist';

export function renderSeaLevel() {
  document.getElementById('slr-chart').innerHTML = seaLevelChartSvg(SEA_LEVEL_PROJECTIONS);
  document.getElementById('slr-body').innerHTML = SEA_LEVEL_PROJECTIONS.map(
    (p) => `<tr><td>${esc(p.period)}</td><td>${p.low}–${p.high} in</td><td>${p.highEnd} in</td></tr>`,
  ).join('');
}

export function renderMethodology(open = 'heat') {
  document.getElementById('methodology').innerHTML = HAZARD_ORDER.map(
    (h) => `<details data-hazard="${h}"${h === open ? ' open' : ''}>
      <summary>${esc(METHODOLOGY[h].title)}</summary>
      <div>${METHODOLOGY[h].html}</div>
    </details>`,
  ).join('');
}

export function renderSources(sources, status) {
  document.getElementById('sources').innerHTML = Object.entries(sources)
    .map(([key, s]) => {
      const st = status[key];
      const note = !st ? 'used on demand' : st.ok ? (st.message ? `partial: ${st.message}` : 'live') : st.message || 'offline';
      return `<li><a href="${s.url}" target="_blank" rel="noopener">${esc(s.name)}</a><span class="st">${esc(note)}</span></li>`;
    })
    .join('');
}

/** Every number the 3D story shows, as a table (every third hour). */
export function renderStoryTable(story) {
  const rows = story.time
    .map((t, k) => ({ t, k }))
    .filter(({ k }) => k % 3 === 0 || k === story.peak.index)
    .map(({ t, k }) => `<tr><td>${esc(storyTime(t))}</td><td class="num">${story.hazard === 'floods' ? story.citywide[k].toFixed(1) : Math.round(story.citywide[k])}${esc(story.unit)}</td></tr>`)
    .join('');
  const what = { heat: 'Highest heat index in any rated neighborhood', floods: 'Water level at the Battery, above normal high tide', air: 'Highest Air Quality Index in any rated neighborhood', wind: 'Strongest gust in any rated neighborhood' }[story.hazard];
  document.getElementById('story-table').innerHTML = `<table class="table">
    <caption class="note" style="text-align:left;padding:4px 0 10px">${esc(story.scenarioMeta.name)}, ${esc(story.scenarioMeta.date)}. ${esc(what)}.</caption>
    <thead><tr><th scope="col">Hour</th><th scope="col" class="num">Value</th></tr></thead><tbody>${rows}</tbody></table>`;
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

/** onProgress(done, total) runs whenever a box changes, e.g. to badge the "Be ready" tab. */
export function initChecklist(initialHazard = 'heat', { onProgress = () => {} } = {}) {
  const checked = loadChecked();
  let active = initialHazard;
  const tabs = document.getElementById('prep-tabs');
  const list = document.getElementById('checklist');
  const progress = document.getElementById('prep-progress');
  const total = HAZARD_ORDER.reduce((n, h) => n + CHECKLIST[h].length, 0);
  const doneIn = (h) => CHECKLIST[h].filter((item) => checked.has(`${h}:${item.id}`)).length;

  function renderTabs() {
    tabs.innerHTML = HAZARD_ORDER.map(
      (h) => `<button type="button" role="tab" id="prep-tab-${h}" data-hazard="${h}" aria-selected="${h === active}" tabindex="${h === active ? 0 : -1}" aria-controls="checklist">${esc(HAZARDS[h].label)}<small>${doneIn(h)}/${CHECKLIST[h].length}</small></button>`,
    ).join('');
    list.setAttribute('aria-labelledby', `prep-tab-${active}`);
  }

  function renderProgress() {
    const done = HAZARD_ORDER.reduce((n, h) => n + doneIn(h), 0);
    progress.innerHTML = `<b>${done}</b> of ${total} steps done${done === total ? '. You are ready; share this with a neighbor.' : '.'}`;
    onProgress(done, total);
  }

  function renderList() {
    list.innerHTML = CHECKLIST[active]
      .map((item) => {
        const key = `${active}:${item.id}`;
        return `<li><label class="check">
          <input type="checkbox" data-key="${key}"${checked.has(key) ? ' checked' : ''} />
          <span><strong>${esc(item.title)}</strong><span>${esc(item.text)}</span>
            ${item.link ? `<a href="${item.link.href}" target="_blank" rel="noopener">${esc(item.link.label)} ↗</a>` : ''}</span>
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
    const b = e.target.closest('button[data-hazard]');
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
