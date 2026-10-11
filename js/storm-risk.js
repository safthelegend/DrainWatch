// Pure wind & storm scoring. No network or page access, so it can be tested on its own.
//
// Hazard (0–4) comes from the strongest forecast gust and sustained wind, measured
// against the NWS New York wind advisory / high wind warning criteria, plus
// thunderstorms in the forecast. It is scaled by how exposed the neighborhood is:
// open ocean and Long Island Sound shorelines get the full force of the wind, and
// streets lined with big trees get the downed limbs and power lines.

import { alertSeverity, clamp, levelFor, round2 } from './risk.js';

export const WIND_THRESHOLDS = {
  advisoryGust: 46, // NWS Wind Advisory: gusts 46–57 mph (or sustained 31–39)
  warningGust: 58, // NWS High Wind Warning: gusts 58+ mph (or sustained 40+)
  hurricaneGust: 74, // hurricane force
};

/** 0–4 hazard from the peak gust and sustained wind (mph). */
export function windHazard(maxGust, maxSustained = null) {
  let h = 0;
  if (maxGust != null && !Number.isNaN(maxGust)) {
    if (maxGust >= WIND_THRESHOLDS.hurricaneGust) h = 4;
    else if (maxGust >= WIND_THRESHOLDS.warningGust) h = 3;
    else if (maxGust >= WIND_THRESHOLDS.advisoryGust) h = 2;
    else if (maxGust >= 30) h = 1;
  }
  if (maxSustained != null && !Number.isNaN(maxSustained)) {
    if (maxSustained >= 74) h = Math.max(h, 4);
    else if (maxSustained >= 40) h = Math.max(h, 3);
    else if (maxSustained >= 31) h = Math.max(h, 2);
  }
  return h;
}

/** WMO weather codes 95 (thunderstorm) and 96 / 99 (thunderstorm with hail). */
export function thunderHazard(codes) {
  if (!codes || !codes.length) return 0;
  if (codes.some((c) => c === 96 || c === 99)) return 2;
  if (codes.some((c) => c === 95)) return 1;
  return 0;
}

/** 1 sheltered → ×0.8, 2 → ×1.0, 3 exposed shoreline → ×1.2 */
export function exposureFactor(windExposure) {
  return 0.6 + 0.2 * clamp(windExposure ?? 2, 1, 3);
}

const WIND_ALERT = /wind|hurricane|tropical storm|tornado|thunderstorm|blizzard|gale/i;

/** { severity } for wind and storm NWS alerts, otherwise null. */
export function classifyWindAlert(event) {
  if (!WIND_ALERT.test(event)) return null;
  let severity = alertSeverity(event);
  if (/tornado warning|hurricane warning/i.test(event)) severity = 'emergency';
  return { severity };
}

const ALERT_WEIGHT = { emergency: 1.5, warning: 1, watch: 0.5, advisory: 0.5, statement: 0 };

/**
 * input: { windExposure, maxGust, maxSustained, weatherCodes, alerts: [{ event, severity }] }
 */
export function assessStorm(input) {
  const wind = windHazard(input.maxGust, input.maxSustained);
  const thunder = thunderHazard(input.weatherCodes);
  const hazard = Math.max(wind, thunder);
  const alerts = input.alerts || [];
  const alert = alerts.reduce((m, a) => Math.max(m, ALERT_WEIGHT[a.severity] ?? 0), 0);
  const score = round2(clamp((hazard + alert) * exposureFactor(input.windExposure), 0, 4));

  const reasons = [];
  if (wind >= 3) reasons.push(`Damaging gusts up to ${f0(input.maxGust)} mph: trees and power lines can come down`);
  else if (wind === 2) reasons.push(`Strong gusts up to ${f0(input.maxGust)} mph`);
  else if (wind === 1) reasons.push(`Breezy: gusts up to ${f0(input.maxGust)} mph`);
  if (thunder === 2) reasons.push('Thunderstorms with hail possible');
  else if (thunder === 1) reasons.push('Thunderstorms possible: lightning and sudden gusts');
  for (const a of alerts) reasons.push(`NWS: ${a.event}`);
  if (score > 0 && input.windExposure >= 3) reasons.push('Exposed shoreline: winds hit hardest here');
  if (reasons.length === 0) reasons.push('No damaging wind or storms in the forecast');

  const driver = hazard === 0 && alert === 0 ? 'none' : thunder > wind ? 'thunder' : 'wind';
  return { score, level: levelFor(score), hazard, driver, reasons };
}

function f0(n) {
  return n == null ? '?' : Math.round(n).toString();
}
