// Tiny HTML helpers shared by the page modules.

import { levelLabel } from './risk.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function icon(name, cls = 'icon') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}" /></svg>`;
}

/** Level pill: a colored dot plus the level name, so color is never the only cue. */
export function badge(level, text) {
  if (!level || level === 'none') return `<span class="badge lvl-none">${esc(text || 'No data')}</span>`;
  return `<span class="badge lvl-${level}">${esc(text || levelLabel(level))}</span>`;
}

/** "Tue 3:00 PM" from an ISO or NOAA-style timestamp. */
export function fmtTime(t) {
  if (!t) return '';
  const d = new Date(String(t).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function exposureWord(n) {
  return ['Minimal', 'Low', 'Moderate', 'High'][n] || '—';
}

export function windExposureWord(n) {
  return { 1: 'Sheltered', 2: 'Waterfront or tree-lined', 3: 'Exposed shoreline' }[n] || '—';
}

export function stat(label, value, unit = '') {
  return `<div><dt>${esc(label)}</dt><dd>${value}${unit ? ` <small>${esc(unit)}</small>` : ''}</dd></div>`;
}

export function empty(text, { error = false } = {}) {
  return `<p class="empty${error ? ' is-error' : ''}">${icon(error ? 'alert' : 'check')}<span>${text}</span></p>`;
}
