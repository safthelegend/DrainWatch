// Pure heat-risk scoring. No network or page access, so it can be tested on its own.
//
// Hazard (0–4) comes from the peak NWS heat index in the forecast, nudged up when
// nights stay too warm to recover. It is then scaled by the neighborhood's Heat
// Vulnerability Index (HVI 1–5): the same heat is more dangerous where there are
// fewer trees, less air conditioning and more older or low-income residents.

import { alertSeverity, clamp, levelFor, round2 } from './risk.js';

/**
 * NWS heat index (°F) from air temperature (°F) and relative humidity (%).
 * Rothfusz regression with the NWS low/high humidity adjustments.
 * https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml
 */
export function heatIndexF(t, rh) {
  if (t == null || rh == null || Number.isNaN(t) || Number.isNaN(rh)) return null;
  const simple = 0.5 * (t + 61 + (t - 68) * 1.2 + rh * 0.094);
  if ((simple + t) / 2 < 80) return round1(simple);

  let hi =
    -42.379 +
    2.04901523 * t +
    10.14333127 * rh -
    0.22475541 * t * rh -
    0.00683783 * t * t -
    0.05481717 * rh * rh +
    0.00122874 * t * t * rh +
    0.00085282 * t * rh * rh -
    0.00000199 * t * t * rh * rh;
  if (rh < 13 && t >= 80 && t <= 112) hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(t - 95)) / 17);
  else if (rh > 85 && t >= 80 && t <= 87) hi += ((rh - 85) / 10) * ((87 - t) / 5);
  return round1(hi);
}

/**
 * 0–4 heat hazard from the peak heat index (°F).
 * NWS New York issues a Heat Advisory at a heat index of 95°F for two days or 100°F
 * for any length of time, and an Extreme Heat Warning at 105°F.
 */
export function heatHazard(maxHeatIndex) {
  if (maxHeatIndex == null || Number.isNaN(maxHeatIndex)) return 0;
  if (maxHeatIndex >= 105) return 4;
  if (maxHeatIndex >= 100) return 3;
  if (maxHeatIndex >= 90) return 2;
  if (maxHeatIndex >= 80) return 1;
  return 0;
}

/** Bodies recover overnight only if it cools down. Lows of 75°F+ add risk, 80°F+ more. */
export function warmNightBoost(overnightLowF) {
  if (overnightLowF == null) return 0;
  if (overnightLowF >= 80) return 0.5;
  if (overnightLowF >= 75) return 0.25;
  return 0;
}

/** HVI 1 → ×0.55 … HVI 4 → ×1.0 … HVI 5 → ×1.15 */
export function vulnerabilityFactor(hvi) {
  return 0.4 + 0.15 * clamp(hvi ?? 3, 1, 5);
}

/** { severity } for heat-related NWS alerts, otherwise null. */
export function classifyHeatAlert(event) {
  if (!/heat/i.test(event)) return null;
  return { severity: alertSeverity(event) };
}

// The heat index already carries most of what an alert says, so alerts only nudge.
const ALERT_WEIGHT = { emergency: 0.5, warning: 0.5, watch: 0.25, advisory: 0.25, statement: 0 };

/**
 * input: { hvi, maxHeatIndex, maxTemp, overnightLow, alerts: [{ event, severity }] }
 */
export function assessHeat(input) {
  const hazard = heatHazard(input.maxHeatIndex);
  const night = hazard > 0 ? warmNightBoost(input.overnightLow) : 0;
  const alerts = input.alerts || [];
  const alert = alerts.reduce((m, a) => Math.max(m, ALERT_WEIGHT[a.severity] ?? 0), 0);
  const factor = vulnerabilityFactor(input.hvi);
  const score = round2(clamp((hazard + night + alert) * factor, 0, 4));

  const reasons = [];
  if (hazard >= 3) reasons.push(`Dangerous heat: heat index up to ${f0(input.maxHeatIndex)}°F`);
  else if (hazard === 2) reasons.push(`Hot and humid: heat index up to ${f0(input.maxHeatIndex)}°F`);
  else if (hazard === 1) reasons.push(`Warm: heat index up to ${f0(input.maxHeatIndex)}°F`);
  if (night >= 0.5) reasons.push(`Nights stay above ${f0(input.overnightLow)}°F: almost no relief`);
  else if (night > 0) reasons.push(`Warm night (low ${f0(input.overnightLow)}°F) limits recovery`);
  for (const a of alerts) reasons.push(`NWS: ${a.event}`);
  if (score > 0 && input.hvi >= 4) reasons.push(`High heat vulnerability (HVI ${input.hvi} of 5)`);
  if (reasons.length === 0) reasons.push('No dangerous heat in the forecast');

  return { score, level: levelFor(score), hazard, driver: hazard > 0 || alert > 0 ? 'heat' : 'none', reasons };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
function f0(n) {
  return n == null ? '?' : Math.round(n).toString();
}
