// Small, dependency-free SVG charts. Each builder returns a markup string;
// app.js drops it into the page and wires the hover layer with attachChartHover().
//
// Conventions: 2px lines in the hazard's ramp, a faint area wash, hairline
// gridlines, threshold lines labelled in ink, and one labelled peak.

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** "Tue 9 PM" from "2026-09-29T21:00" or NOAA's "2026-09-29 21:00". */
export function hourLabel(t) {
  if (!t) return '';
  const d = new Date(`${t.slice(0, 10)}T12:00:00`);
  const day = d.toLocaleDateString('en-US', { weekday: 'short' });
  const h = +t.slice(11, 13);
  const m = t.slice(14, 16);
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${day} ${hh}${m && m !== '00' ? `:${m}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

// ---------------- hourly time chart ----------------

function niceStep(range, target = 4) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n >= 5 ? 10 : n >= 2 ? 5 : n >= 1 ? 2 : 1) * mag;
}

/**
 * rows: [{ t, v }] hourly (or finer) values, starting now when live (else at a replay's start).
 * thresholds: [{ value, label, level }] reference lines.
 * type: 'line' (area + line) or 'bar' (for rainfall amounts).
 */
export function timeChartSvg({ rows, thresholds = [], type = 'line', unit = '', decimals = 0, yMin, yMax, ariaLabel, minTop, live = true }) {
  const pts = rows.filter((r) => r.v != null);
  if (pts.length < 2) return '<p class="note">Not enough data to chart.</p>';

  const W = 360;
  const H = 176;
  const P = { top: 16, right: thresholds.length ? 62 : 12, bottom: 22, left: 34 };
  const values = pts.map((p) => p.v);
  const lo = yMin ?? Math.min(...values, ...thresholds.map((t) => t.value));
  let hi = yMax ?? Math.max(...values, ...thresholds.map((t) => t.value));
  if (minTop != null) hi = Math.max(hi, minTop);
  if (hi === lo) hi = lo + 1;
  const step = niceStep(hi - lo);
  const y0 = Math.floor(lo / step) * step;
  const y1 = Math.ceil(hi / step) * step;

  const n = rows.length;
  const plotW = W - P.left - P.right;
  const x = (i) => P.left + (type === 'bar' ? ((i + 0.5) / n) * plotW : (i / (n - 1)) * plotW);
  const y = (v) => P.top + (1 - (v - y0) / (y1 - y0)) * (H - P.top - P.bottom);

  // grid + y ticks
  let grid = '';
  for (let v = y0; v <= y1 + step / 1000; v += step) {
    const yy = y(v).toFixed(1);
    grid += `<line class="c-grid" x1="${P.left}" x2="${W - P.right}" y1="${yy}" y2="${yy}" />`;
    grid += `<text class="c-tick" x="${P.left - 6}" y="${(+yy + 3).toFixed(1)}" text-anchor="end">${+v.toFixed(2)}</text>`;
  }

  // day labels at each midnight
  let days = '';
  rows.forEach((r, i) => {
    if (i > 0 && r.t.slice(11, 16) === '00:00') {
      const xx = (type === 'bar' ? x(i) - plotW / n / 2 : x(i)).toFixed(1);
      const d = new Date(`${r.t.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
      days += `<line class="c-axis" x1="${xx}" x2="${xx}" y1="${P.top}" y2="${H - P.bottom}" />`;
      days += `<text class="c-tick" x="${(+xx + 4).toFixed(1)}" y="${H - 7}">${d}</text>`;
    }
  });
  const first = live ? 'Now' : new Date(`${rows[0].t.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
  days += `<text class="c-tick" x="${P.left}" y="${H - 7}">${first}</text>`;

  // thresholds, labels nudged apart so they never overlap
  let lastY = Infinity;
  const thr = [...thresholds]
    .sort((a, b) => a.value - b.value)
    .filter((t) => t.value >= y0 && t.value <= y1)
    .map((t) => {
      const yy = y(t.value);
      const ly = Math.min(yy + 3.5, lastY - 12);
      lastY = ly;
      return `<line class="c-thr lvl-${t.level}" x1="${P.left}" x2="${W - P.right}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" />
        <rect class="c-swatch lvl-${t.level}" x="${W - P.right + 5}" y="${(ly - 7).toFixed(1)}" width="3" height="9" rx="1.5" />
        <text class="c-thr-label" x="${W - P.right + 11}" y="${ly.toFixed(1)}">${esc(t.label)}</text>`;
    })
    .join('');

  // marks
  let marks = '';
  if (type === 'bar') {
    const bw = Math.max(1.5, Math.min(10, plotW / n - 1.5));
    marks = rows
      .map((r, i) => {
        if (!r.v) return '';
        const top = y(Math.max(r.v, 0));
        const h = Math.max(1, y(y0) - top);
        return `<rect class="c-bar" x="${(x(i) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(2, bw / 2)}" />`;
      })
      .join('');
  } else {
    const line = rows
      .map((r, i) => (r.v == null ? null : `${x(i).toFixed(1)},${y(r.v).toFixed(1)}`))
      .filter(Boolean);
    marks = `<path class="c-area" d="M${line[0].split(',')[0]},${y(y0).toFixed(1)}L${line.join('L')}L${line[line.length - 1].split(',')[0]},${y(y0).toFixed(1)}Z" />
      <path class="c-line" d="M${line.join('L')}" />
      <circle class="c-now" cx="${x(0).toFixed(1)}" cy="${y(rows[0].v ?? values[0]).toFixed(1)}" r="4" />`;
  }

  // peak label
  let peakI = 0;
  rows.forEach((r, i) => {
    if (r.v != null && r.v > (rows[peakI].v ?? -Infinity)) peakI = i;
  });
  const peak = rows[peakI];
  const px = x(peakI);
  const py = y(peak.v);
  const anchor = px > W - P.right - 40 ? 'end' : px < P.left + 40 ? 'start' : 'middle';
  const peakMark = `${type === 'line' ? `<circle class="c-peak" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4" />` : ''}
    <text class="c-peak-label" x="${px.toFixed(1)}" y="${Math.max(10, py - 8).toFixed(1)}" text-anchor="${anchor}">${peak.v.toFixed(decimals)}${esc(unit)} peak</text>`;

  // hover data: x positions in viewBox units with display values
  const hover = rows.map((r, i) => [+x(i).toFixed(1), r.v == null ? null : +y(r.v).toFixed(1), r.v == null ? '—' : `${r.v.toFixed(decimals)}${unit}`, hourLabel(r.t)]);

  return `<div class="chart" data-w="${W}" data-points='${esc(JSON.stringify(hover))}'>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">
      ${grid}${days}${thr}${marks}${peakMark}
      <line class="c-cross" x1="0" x2="0" y1="${P.top}" y2="${H - P.bottom}" />
      <circle class="c-cross-dot" cx="0" cy="0" r="4" />
    </svg>
  </div>`;
}

/** Crosshair + tooltip for every chart inside `root`. */
export function attachChartHover(root, tip) {
  root.querySelectorAll('.chart[data-points]').forEach((chart) => {
    const svg = chart.querySelector('svg');
    const points = JSON.parse(chart.dataset.points);
    const W = +chart.dataset.w;
    const cross = svg.querySelector('.c-cross');
    const dot = svg.querySelector('.c-cross-dot');
    const move = (clientX) => {
      const box = svg.getBoundingClientRect();
      const vx = ((clientX - box.left) / box.width) * W;
      let best = points[0];
      for (const p of points) if (Math.abs(p[0] - vx) < Math.abs(best[0] - vx)) best = p;
      cross.setAttribute('x1', best[0]);
      cross.setAttribute('x2', best[0]);
      if (best[1] != null) {
        dot.setAttribute('cx', best[0]);
        dot.setAttribute('cy', best[1]);
      }
      chart.classList.add('hovering');
      const scale = box.width / W;
      const vb = svg.viewBox.baseVal;
      tip.innerHTML = `<strong>${esc(best[2])}</strong> · ${esc(best[3])}`;
      tip.style.left = `${box.left + best[0] * scale}px`;
      tip.style.top = `${box.top + (best[1] ?? vb.height / 2) * (box.height / vb.height)}px`;
      tip.hidden = false;
    };
    const leave = () => {
      chart.classList.remove('hovering');
      tip.hidden = true;
    };
    svg.addEventListener('pointermove', (e) => move(e.clientX));
    svg.addEventListener('pointerleave', leave);
    svg.addEventListener('pointerdown', (e) => move(e.clientX));
  });
}

// ---------------- sea level rise ----------------

/** Horizontal range bars: likely range per period, a ring at the high-end estimate. */
export function seaLevelChartSvg(projections, { referenceIn = 12, referenceLabel = '1 ft' } = {}) {
  const W = 560;
  const rowH = 46;
  const P = { top: 24, right: 24, bottom: 30, left: 64 };
  const H = P.top + projections.length * rowH + P.bottom;
  const max = Math.ceil(Math.max(...projections.map((p) => p.highEnd)) / 12) * 12;
  const x = (v) => P.left + (v / max) * (W - P.left - P.right);

  let grid = '';
  for (let v = 0; v <= max; v += 12) {
    grid += `<line class="c-grid" x1="${x(v)}" x2="${x(v)}" y1="${P.top - 8}" y2="${H - P.bottom}" />`;
    grid += `<text class="c-tick" x="${x(v)}" y="${H - P.bottom + 16}" text-anchor="middle">${v / 12} ft</text>`;
  }

  const rows = projections
    .map((p, i) => {
      const cy = P.top + i * rowH + rowH / 2;
      const bx = x(p.low);
      const bw = Math.max(4, x(p.high) - x(p.low));
      return `
        <text class="slr-cat" x="${P.left - 12}" y="${cy + 4}" text-anchor="end">${esc(p.period)}</text>
        <rect class="slr-bar" x="${bx.toFixed(1)}" y="${cy - 10}" width="${bw.toFixed(1)}" height="20" rx="4">
          <title>${esc(p.period)}: ${p.low}–${p.high} in likely, up to ${p.highEnd} in</title>
        </rect>
        <line class="c-axis" x1="${(bx + bw).toFixed(1)}" x2="${x(p.highEnd).toFixed(1)}" y1="${cy}" y2="${cy}" />
        <circle class="slr-hi" cx="${x(p.highEnd).toFixed(1)}" cy="${cy}" r="6" />
        <text class="slr-bar-label" x="${(x(p.highEnd) + 12).toFixed(1)}" y="${cy + 4}">${p.low}–${p.high} in</text>`;
    })
    .join('');

  const ref = `<line class="slr-ref" x1="${x(referenceIn)}" x2="${x(referenceIn)}" y1="${P.top - 14}" y2="${H - P.bottom}" />
    <text class="slr-ref-label" x="${x(referenceIn) + 6}" y="${P.top - 6}">${esc(referenceLabel)}</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Projected sea level rise for New York City by period. The data is also in the table below.">
    ${grid}${ref}${rows}
  </svg>`;
}
