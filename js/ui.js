// Tiny HTML helpers shared by the page modules.

import { levelLabel } from './risk.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** A risk level: a small square in the hazard's ramp plus the word, never color alone. */
export function level(lvl, text) {
  if (!lvl || lvl === 'none') return `<span class="level lvl-none">${esc(text || 'No data')}</span>`;
  return `<span class="level lvl-${lvl}"><span class="swatch"></span>${esc(text || levelLabel(lvl))}</span>`;
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
