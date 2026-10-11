// Pure flood-risk scoring. No network or page access here, so it can be tested on its own.
//
// Each hazard is scored 0–4 from live data, then scaled by the location's
// exposure (0–3). The larger of coastal and stormwater risk wins, plus small
// boosts for active NWS alerts and recent 311 flooding reports.

export const LEVELS = [
  { level: 'low', label: 'Low', min: 0 },
  { level: 'elevated', label: 'Elevated', min: 1 },
  { level: 'high', label: 'High', min: 2 },
  { level: 'severe', label: 'Severe', min: 3 },
];

const M_TO_FT = 3.28084;

/**
 * NOAA derived high-tide flooding thresholds, in feet above MHHW
 * (Sweet et al. 2018, NOAA Technical Report NOS CO-OPS 086).
 */
export function thresholdsFromGreatDiurnalRange(gtFt) {
  const gt = gtFt / M_TO_FT;
  const toFt = (m) => Math.round(m * M_TO_FT * 100) / 100;
  return {
    minor: toFt(0.04 * gt + 0.5),
    moderate: toFt(0.03 * gt + 0.8),
    major: toFt(0.04 * gt + 1.17),
  };
}

/** 0–4 coastal hazard from peak water level (ft above MHHW). */
export function coastalHazard(peakFt, t) {
  if (peakFt == null || Number.isNaN(peakFt)) return 0;
  if (peakFt >= t.major) return 4;
  if (peakFt >= t.moderate) return 3;
  if (peakFt >= t.minor) return 2;
  if (peakFt >= t.minor - 0.5) return 1;
  return 0;
}

/**
 * 0–4 stormwater hazard from the max forecast hourly rainfall (in/hr).
 * Hourly model totals smooth out short bursts, so the bands sit below DEP's
 * 1.75 in/hr sewer design capacity. Saturated ground (>1.5 in in the past 24 h)
 * bumps a non-zero hazard by one step.
 */
export function rainfallHazard(maxHourlyIn, past24In = null) {
  if (maxHourlyIn == null || Number.isNaN(maxHourlyIn)) return 0;
  let h = 0;
  if (maxHourlyIn >= 1.75) h = 4;
  else if (maxHourlyIn >= 1.0) h = 3;
  else if (maxHourlyIn >= 0.5) h = 2;
  else if (maxHourlyIn >= 0.1) h = 1;
  if (h > 0 && past24In != null && past24In > 1.5) h = Math.min(4, h + 1);
  return h;
}

const COASTAL_ALERT = /coastal|storm surge|hurricane|tropical/i;
const STORMWATER_ALERT = /flash flood|flood/i;

/** NWS product tier from an event name: emergency > warning > watch / advisory > statement. */
export function alertSeverity(event) {
  if (/emergency/i.test(event)) return 'emergency';
  if (/warning/i.test(event)) return 'warning';
  if (/watch/i.test(event)) return 'watch';
  if (/advisory/i.test(event)) return 'advisory';
  return 'statement';
}

/** Sort an NWS alert event name into { kind, severity }, or null if it isn't flood related. */
export function classifyAlert(event) {
  let kind = null;
  if (COASTAL_ALERT.test(event)) kind = 'coastal';
  else if (STORMWATER_ALERT.test(event)) kind = 'stormwater';
  if (!kind) return null;
  return { kind, severity: alertSeverity(event) };
}

const ALERT_WEIGHT = { emergency: 2, warning: 1.5, watch: 0.75, advisory: 0.75, statement: 0.25 };

export function alertBoost(alerts, kind) {
  return alerts.filter((a) => a.kind === kind).reduce((max, a) => Math.max(max, ALERT_WEIGHT[a.severity]), 0);
}

/** Recent 311 street-flooding / sewer-backup reports nearby mean flooding is already happening. */
export function complaintBoost(count) {
  if (count == null) return 0;
  if (count >= 15) return 1;
  if (count >= 5) return 0.5;
  return 0;
}

export function levelFor(score) {
  let result = 'low';
  for (const l of LEVELS) if (score >= l.min) result = l.level;
  return result;
}

export function levelLabel(level) {
  return LEVELS.find((l) => l.level === level).label;
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Combine everything into one assessment.
 * input: { coastalExposure, stormwaterExposure, thresholds, peakWaterFt,
 *          maxHourlyRainIn, past24hRainIn, alerts, recentComplaints }
 */
export function assess(input) {
  const cHaz = coastalHazard(input.peakWaterFt, input.thresholds);
  const sHaz = rainfallHazard(input.maxHourlyRainIn, input.past24hRainIn);

  const cExp = clamp(input.coastalExposure, 0, 3) / 3;
  const sExp = clamp(input.stormwaterExposure, 0, 3) / 3;

  const coastal = clamp((cHaz + alertBoost(input.alerts, 'coastal')) * cExp, 0, 4);
  const stormwater = clamp((sHaz + alertBoost(input.alerts, 'stormwater')) * sExp, 0, 4);
  const boost = complaintBoost(input.recentComplaints);
  const score = round2(clamp(Math.max(coastal, stormwater) + boost, 0, 4));

  const reasons = [];
  if (cHaz >= 2 && cExp > 0) reasons.push(`Water level forecast to reach ${fmt(input.peakWaterFt)} ft above normal high tide — at or above flood stage`);
  else if (cHaz === 1 && cExp > 0) reasons.push(`High tide close to minor flood stage (${fmt(input.peakWaterFt)} ft above normal high tide)`);
  if (sHaz >= 3 && sExp > 0) reasons.push(`Intense rain forecast (${fmt(input.maxHourlyRainIn)} in/hr) — may overwhelm sewers`);
  else if (sHaz >= 1 && sExp > 0) reasons.push(`Rain forecast (${fmt(input.maxHourlyRainIn)} in/hr at peak)`);
  for (const a of input.alerts) {
    if ((a.kind === 'coastal' && cExp > 0) || (a.kind === 'stormwater' && sExp > 0)) reasons.push(`NWS: ${a.event}`);
  }
  if (boost > 0) reasons.push(`${input.recentComplaints} flooding reports to 311 nearby in the past week`);
  if (reasons.length === 0) reasons.push('No flood drivers in the forecast');

  const top = Math.max(coastal, stormwater);
  const driver = top === 0 ? 'none' : coastal >= stormwater ? 'coastal' : 'stormwater';
  return { score, level: levelFor(score), coastal: round2(coastal), stormwater: round2(stormwater), driver, reasons };
}

// ---- helpers used by the data layer ----

/** Highest predicted tide plus the current storm surge (observed − predicted), if positive. */
export function peakWaterLevel(predictions, latestObserved, predictedAtObservation) {
  if (predictions.length === 0) return latestObserved;
  const surge = latestObserved != null && predictedAtObservation != null ? latestObserved - predictedAtObservation : 0;
  const peak = Math.max(...predictions) + Math.max(surge, 0);
  return round2(latestObserved != null ? Math.max(peak, latestObserved) : peak);
}

/** Great-circle distance in km. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** FEMA flood zone → coastal exposure (0–3). A/V zones are the 1% annual chance floodplain. */
export function exposureFromFemaZone(zone, subtype) {
  if (!zone) return 0;
  const z = zone.toUpperCase();
  if (z.startsWith('V') || z.startsWith('A')) return 3;
  if (z === 'X' && subtype && /0\.2\s*PCT/i.test(subtype)) return 1;
  return 0;
}

/** A year of 311 flooding reports within 500 m → stormwater exposure (1–3). */
export function exposureFromComplaintHistory(count) {
  if (count == null) return 1;
  if (count >= 25) return 3;
  if (count >= 8) return 2;
  return 1;
}

function fmt(n) {
  return n == null ? '?' : n.toFixed(2);
}
