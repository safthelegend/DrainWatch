// 48 h of water levels at a tide gauge (live or replayed), with NOAA's minor / moderate / major
// flood thresholds drawn across it. Built on the shared time chart.

import { timeChartSvg } from './charts.js';

export function tideChartSvg(tide, { live = true } = {}) {
  const { predictions, surge, thresholds } = tide;
  if (!predictions.length) return '';
  // Live predictions are astronomical tide only, so add the current surge on top.
  // Replays already include the surge in their reconstructed water level.
  const shift = !tide.includesSurge && surge != null && surge > 0 ? surge : 0;
  const rows = predictions.map((p) => ({ t: p.t, v: p.v + shift }));
  const chart = timeChartSvg({
    rows,
    unit: ' ft',
    decimals: 1,
    minTop: thresholds.major + 0.5,
    thresholds: [
      { value: thresholds.minor, label: 'Minor', level: 'elevated' },
      { value: thresholds.moderate, label: 'Moderate', level: 'high' },
      { value: thresholds.major, label: 'Major', level: 'severe' },
    ],
    ariaLabel: `Water level${live ? ' for the next 48 hours' : ''} compared with NOAA flood thresholds`,
    live,
  });
  const what = tide.includesSurge ? 'Reconstructed water level' : `Forecast = predicted tide${shift ? ` + ${shift.toFixed(2)} ft current surge` : ''}`;
  const slr = tide.seaLevelRiseFt ? ` Includes +${Math.round(tide.seaLevelRiseFt * 12)} in of projected sea level rise.` : '';
  return `${chart}<p class="note">Feet above normal high tide (MHHW). ${what}.${slr}</p>`;
}
