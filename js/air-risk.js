// Pure air-quality scoring. No network or page access, so it can be tested on its own.
//
// Hazard (0–4) comes straight from the EPA's US Air Quality Index (AQI) over the next
// 48 hours. Neighborhoods with a heavy asthma burden move up half a step once the air
// is no longer "Good", because the same smoke or smog sends more people to the ER there.

import { alertSeverity, clamp, levelFor, round2 } from './risk.js';

export const AQI_CATEGORIES = [
  { max: 50, label: 'Good' },
  { max: 100, label: 'Moderate' },
  { max: 150, label: 'Unhealthy for sensitive groups' },
  { max: 200, label: 'Unhealthy' },
  { max: 300, label: 'Very unhealthy' },
  { max: Infinity, label: 'Hazardous' },
];

export function aqiCategory(aqi) {
  if (aqi == null || Number.isNaN(aqi)) return null;
  return AQI_CATEGORIES.find((c) => aqi <= c.max).label;
}

// EPA PM2.5 breakpoints (µg/m³, 24-hour), as revised in 2024.
const PM25_BREAKPOINTS = [
  [0, 9.0, 0, 50],
  [9.1, 35.4, 51, 100],
  [35.5, 55.4, 101, 150],
  [55.5, 125.4, 151, 200],
  [125.5, 225.4, 201, 300],
  [225.5, 325.4, 301, 500],
];

/** US AQI for a PM2.5 concentration, using the EPA's piecewise-linear formula. */
export function aqiFromPm25(c) {
  if (c == null || Number.isNaN(c) || c < 0) return null;
  const x = Math.floor(c * 10) / 10; // EPA truncates to one decimal
  for (const [cLo, cHi, iLo, iHi] of PM25_BREAKPOINTS) {
    if (x <= cHi) return Math.round(((iHi - iLo) / (cHi - cLo)) * (Math.max(x, cLo) - cLo) + iLo);
  }
  return 500;
}

/** 0–4 hazard from the peak AQI. */
export function aqiHazard(aqi) {
  if (aqi == null || Number.isNaN(aqi)) return 0;
  if (aqi > 200) return 4;
  if (aqi > 150) return 3;
  if (aqi > 100) return 2;
  if (aqi > 50) return 1;
  return 0;
}

/** { severity } for air-related NWS alerts, otherwise null. */
export function classifyAirAlert(event) {
  if (!/air quality|air stagnation|smoke/i.test(event)) return null;
  return { severity: alertSeverity(event) };
}

const POLLUTANT_NAMES = { pm2_5: 'fine particles (PM2.5), such as smoke', ozone: 'ozone (smog)' };

/**
 * input: { asthma, currentAqi, peakAqi, dominant: 'pm2_5' | 'ozone', alerts: [{ event, severity }] }
 */
export function assessAir(input) {
  const peak = Math.max(input.peakAqi ?? -1, input.currentAqi ?? -1);
  const worst = peak < 0 ? null : peak;
  const hazard = aqiHazard(worst);
  const sensitive = hazard >= 1 && input.asthma >= 4 ? 0.5 : 0;
  const alerts = input.alerts || [];
  const alert = alerts.length ? 0.5 : 0;
  const score = round2(clamp(hazard + sensitive + alert, 0, 4));

  const reasons = [];
  if (worst != null && hazard > 0) {
    reasons.push(`AQI up to ${Math.round(worst)}: ${aqiCategory(worst)}`);
    if (input.dominant && POLLUTANT_NAMES[input.dominant]) reasons.push(`Main pollutant: ${POLLUTANT_NAMES[input.dominant]}`);
  }
  for (const a of alerts) reasons.push(`NWS: ${a.event}`);
  if (sensitive) reasons.push(`High asthma burden (${input.asthma} of 5): sensitive groups affected first`);
  if (reasons.length === 0) reasons.push(worst == null ? 'No air quality data' : `Air quality is good (AQI ${Math.round(worst)})`);

  return { score, level: levelFor(score), hazard, aqi: worst, category: aqiCategory(worst), driver: hazard > 0 ? input.dominant || 'air' : 'none', reasons };
}
