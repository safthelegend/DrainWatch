// The 3D story for each hazard: which replay it tells, the hour-by-hour
// numbers, the beats of text and the neighborhoods it visits. Every number in
// the copy is computed from the replay data, never typed in. Pure: no DOM, no WebGL.

import { AREAS } from '../config.js';
import { aqiCategory } from '../air-risk.js';
import { vulnerabilityFactor } from '../heat-risk.js';
import { assessPlace } from '../hazards.js';
import { buildScenario, scenarioById, scenarioHourly, SEA_LEVEL_STOPS } from '../scenarios.js';
import { kmBetween } from './geo.js';

/** Mean higher high water at the Battery is about 2.2 ft (0.68 m) above NAVD88, the datum of the elevation data. */
export const MHHW_NAVD_M = 0.68;
export const FT = 0.3048;

/** The last share of the flood timeline raises the sea instead of the clock. */
export const SLR_SHARE = 0.22;

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Friday, 3 p.m." from "2019-07-19T15:00" (AP style). */
export function storyTime(key, { day = true } = {}) {
  const d = new Date(`${key.slice(0, 10)}T12:00:00Z`);
  const h = +key.slice(11, 13);
  const clock = h === 0 ? 'midnight' : h === 12 ? 'noon' : `${h % 12} ${h < 12 ? 'a.m.' : 'p.m.'}`;
  return day ? `${WEEKDAY[d.getUTCDay()]}, ${clock}` : clock;
}

const r0 = (v) => Math.round(v);
const r1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

export const STORIES = {
  heat: {
    hazard: 'heat',
    scenario: 'heat-2019',
    metric: 'heatIndex',
    unit: '°F',
    window: { from: '2019-07-19T00:00', hours: 72 },
    heroHour: '2019-07-20T20:00',
    hero: {
      kicker: 'July 20, 2019',
      megaUnit: '°F',
      megaLabel: 'feels like',
      headline: (c) => `New York's hottest weekend in years. At night, it never dropped below ${Math.floor(c.nightLow / 10) * 10}.`,
    },
    timeline: {
      kicker: '72 hours',
      title: 'Three days, and nights that never cooled off',
      dek: 'Play or drag through the heat wave hour by hour. Each neighborhood rises with how dangerous the heat is there: how hot it feels, weighed by who lives there.',
    },
    beats: [
      { at: '2019-07-19T15:00', write: (c) => `The thermometer says ${r0(c.temp)}°F, but the humidity makes the hottest blocks feel ${r0(c.value - c.temp)} degrees hotter.` },
      { at: '2019-07-19T23:00', write: (c) => `The sun has been down for hours, and it still feels like ${r0(c.value)}°F.` },
      { at: '2019-07-20T06:00', write: (c) => `Sunrise, and it already feels like ${r0(c.value)}°F.` },
      { at: '2019-07-20T16:00', write: () => 'The city has declared a heat emergency and opened hundreds of cooling centers.' },
      { at: '2019-07-21T05:00', write: (c) => `The coolest hour of the night, and the air is still ${r0(c.temp)}°F.` },
      { at: '2019-07-21T16:00', write: (c) => `A second straight day near ${r0(c.value)}°F.` },
    ],
    exposed: {
      kicker: "Who's exposed",
      title: 'The same heat is not equally dangerous everywhere',
      dek: 'Neighborhoods with less shade, more pavement and fewer air conditioners carry the most risk.',
      steps: [
        { id: 'east-harlem', bearing: 210 },
        { id: 'les', bearing: 330 },
        { id: 'central-harlem', bearing: 150 },
      ],
    },
  },

  floods: {
    hazard: 'floods',
    scenario: 'sandy',
    metric: 'water',
    unit: ' ft',
    window: { from: '2012-10-29T06:00', hours: 16 },
    heroHour: '2012-10-29T18:00',
    hero: {
      kicker: 'October 29, 2012',
      megaUnit: ' ft',
      megaLabel: 'above high tide',
      headline: () => 'Hurricane Sandy pushed New York Harbor into the streets. Higher seas will make the next storm worse.',
    },
    timeline: {
      kicker: 'One night',
      title: 'The harbor rose all day, then poured into the city',
      dek: 'Play or drag to raise the harbor to its measured level at each hour. Each neighborhood rises with how much of its land is under water.',
    },
    beats: [
      {
        at: '2012-10-29T08:00',
        write: (c) =>
          `Sandy is still offshore, but its winds are already piling water into the harbor${c.value > c.minor ? `, past the ${r1(c.minor)} ft where minor flooding starts` : `. Minor flooding starts at ${r1(c.minor)} ft`}.`,
      },
      {
        at: '2012-10-29T17:00',
        write: (c) => (c.value > c.minor ? `Still rising, now past the ${r1(c.minor)} ft where minor flooding starts.` : `Still rising toward the ${r1(c.minor)} ft where minor flooding starts.`),
      },
      { at: '2012-10-29T21:00', write: () => 'Seawater pours into subway tunnels, the Battery Tunnel and the Rockaways.' },
      { at: 'slr', write: (c) => `Now run the same storm on the seas projected for the ${c.slr.label}: ${c.slr.inches} inches higher. More of the city goes under.` },
    ],
    exposed: {
      kicker: "Who's exposed",
      title: 'Where the water reached first',
      dek: 'Low-lying neighborhoods on the open water flooded fastest and deepest.',
      steps: [
        { id: 'red-hook', bearing: 60 },
        { id: 'rockaway', bearing: 340 },
        { id: 'midland-beach', bearing: 300 },
      ],
    },
  },

  air: {
    hazard: 'air',
    scenario: 'smoke-2023',
    metric: 'aqi',
    unit: '',
    window: { from: '2023-06-07T00:00', hours: 48 },
    heroHour: '2023-06-07T19:00',
    hero: {
      kicker: 'June 7, 2023',
      megaUnit: '',
      megaLabel: 'Air Quality Index',
      headline: () => "Smoke from Canada's wildfires turned the sky orange and New York's air hazardous.",
    },
    timeline: {
      kicker: 'Two days',
      title: 'The smoke rolled in, and stayed',
      dek: "Play or drag through June 7 and 8. The haze thickens with each hour's Air Quality Index, and neighborhoods rise where the air is worse than the city's average.",
    },
    beats: [
      { at: '2023-06-07T09:00', write: (c) => `The air is "${aqiCategory(c.value)}," and schools cancel outdoor activities.` },
      { at: '2023-06-07T17:00', write: (c) => `"${aqiCategory(c.value)}." For a few hours New York has the worst air of any major city on Earth.` },
      { at: '2023-06-08T09:00', write: (c) => `A day later the air is still "${aqiCategory(c.value)}."` },
    ],
    exposed: {
      kicker: "Who's exposed",
      title: 'Smoke hits hardest where asthma already does',
      dek: 'Neighborhoods with the most asthma emergencies feel bad air first.',
      steps: [
        { id: 'mott-haven', bearing: 200 },
        { id: 'hunts-point', bearing: 250 },
        { id: 'east-harlem', bearing: 20 },
      ],
    },
  },

  wind: {
    hazard: 'wind',
    scenario: 'isaias',
    metric: 'gust',
    unit: ' mph',
    window: { from: '2020-08-04T04:00', hours: 24 },
    heroHour: '2020-08-04T19:00',
    hero: {
      kicker: 'August 4, 2020',
      megaUnit: ' mph',
      megaLabel: 'gusts',
      headline: () => "Tropical Storm Isaias tore through the city's trees in a single afternoon.",
    },
    timeline: {
      kicker: 'One afternoon',
      title: 'The wind built for six hours, then let go',
      dek: 'Play or drag through the day. Each neighborhood rises where the gusts are stronger than the city average.',
    },
    beats: [
      { at: '2020-08-04T08:00', write: () => 'Isaias races up the coast toward the city, and a Tropical Storm Warning is in effect.' },
      { at: '2020-08-04T12:00', write: () => 'Trees and power lines start coming down.' },
      { at: '2020-08-04T14:00', write: () => 'The strongest gusts hit the shore. More than 250,000 Con Edison customers lose power.' },
      { at: '2020-08-04T20:00', write: () => 'Calm again, but some blocks wait days for the lights to come back.' },
    ],
    exposed: {
      kicker: "Who's exposed",
      title: 'The open shoreline takes the full force',
      dek: 'Neighborhoods facing the ocean and Long Island Sound get the strongest gusts.',
      steps: [
        { id: 'rockaway', bearing: 20 },
        { id: 'throgs-neck', bearing: 120 },
        { id: 'coney-island', bearing: 340 },
      ],
    },
  },
};

const areaIndex = (id) => AREAS.findIndex((a) => a.id === id);

/** Value of a story's metric for one neighborhood across the window. */
function areaMetric(story, series, i) {
  if (story.metric === 'water') return series.water[AREAS[i].station];
  return series.areas[i][story.metric];
}

/** The 1–2 facts each annotation shows next to the risk level, from the story's own hours. */
function driversFor(hazard, area, series, i, extra) {
  const out = [];
  const peakOf = (arr) => Math.max(...arr);
  if (hazard === 'heat') {
    const row = series.areas[i];
    const nightLow = Math.min(...row.temp.filter((_, k) => +series.time[k].slice(11, 13) <= 7 && series.time[k] > series.time[0].slice(0, 10) + 'T23'));
    out.push(`Heat Vulnerability Index ${area.hvi} of 5`);
    out.push(`Felt like ${Math.round(peakOf(row.heatIndex))}°F; nights no cooler than ${Math.round(nightLow)}°F`);
  } else if (hazard === 'floods') {
    out.push(`Coastal flood exposure: ${['minimal', 'low', 'moderate', 'high'][area.coastalExposure]}`);
    out.push(`Water peaked ${r1(peakOf(series.water[area.station]))} ft above high tide nearby`);
  } else if (hazard === 'air') {
    const peak = peakOf(series.areas[i].aqi);
    out.push(`Asthma burden ${area.asthma} of 5`);
    out.push(`AQI peaked at ${Math.round(peak)}, "${aqiCategory(peak)}"`);
  } else {
    out.push(['', 'Sheltered streets', 'Waterfront and big trees', 'Open shoreline'][area.windExposure]);
    out.push(`Gusts up to ${Math.round(peakOf(series.areas[i].gust))} mph`);
  }
  if (extra) {
    if (extra.treeCanopy != null) out.push(`Tree canopy ${Math.round(extra.treeCanopy)}% of land`);
    if (extra.airConditioning != null) out.push(`${Math.round(100 - extra.airConditioning)}% of homes without air conditioning`);
  }
  return out;
}

/**
 * Everything the page needs to tell one hazard's story.
 * heatDrivers (optional): { byArea: { [areaId]: { treeCanopy, airConditioning } } } from data/heat-drivers.json.
 */
export function buildStory(hazard, { heatDrivers = null } = {}) {
  const story = STORIES[hazard];
  const scenario = scenarioById(story.scenario);
  const series = scenarioHourly(story.scenario, story.window.from, story.window.hours);
  const inputs = buildScenario(story.scenario);
  const values = AREAS.map((_, i) => areaMetric(story, series, i));
  const citywide = series.time.map((_, k) => (story.metric === 'water' ? series.water.battery[k] : Math.max(...values.map((v) => v[k]))));

  let peakIndex = 0;
  citywide.forEach((v, k) => {
    if (v > citywide[peakIndex]) peakIndex = k;
  });
  const hottest = values.reduce((best, v, i) => (Math.max(...v) > Math.max(...values[best]) ? i : best), 0);
  // the night after the peak: the next 16 hours' early-morning temperatures
  const nightLow = Math.min(...series.areas[hottest].temp.filter((_, k) => k > peakIndex && k <= peakIndex + 16 && +series.time[k].slice(11, 13) <= 7));
  const slrStop = SEA_LEVEL_STOPS.find((s) => s.id === '2080s');
  const minor = inputs.tides.battery.thresholds.minor;

  const beats = story.beats.map((b) => {
    const index = b.at === 'slr' ? peakIndex : series.time.indexOf(b.at);
    if (index < 0) throw new Error(`${hazard}: beat ${b.at} is outside the story window`);
    const ctx = { key: series.time[index], value: citywide[index], temp: series.areas[hottest].temp[index], minor, slr: slrStop };
    return { index, slr: b.at === 'slr', text: b.write(ctx) };
  });

  const stops = story.exposed.steps.map((step) => {
    const i = areaIndex(step.id);
    const area = AREAS[i];
    const r = assessPlace(hazard, area, inputs, i);
    const extra = hazard === 'heat' && heatDrivers ? heatDrivers.byArea?.[area.id] : null;
    return { area, bearing: step.bearing, level: r.level, score: r.score, drivers: driversFor(hazard, area, series, i, extra).slice(0, extra ? 3 : 2) };
  });

  // risk at the peak for every rated neighborhood: what "who's exposed" raises in 3D
  const riskByArea = Object.fromEntries(AREAS.map((area, i) => [area.id, assessPlace(hazard, area, inputs, i).score]));

  const heroIndex = Math.max(0, series.time.indexOf(story.heroHour));
  return {
    city: cityValues(hazard, values),
    ...story,
    scenarioMeta: scenario,
    time: series.time,
    water: series.water,
    values, // per neighborhood (AREAS order) per hour
    citywide,
    peak: { index: peakIndex, value: citywide[peakIndex], key: series.time[peakIndex] },
    heroIndex,
    beats,
    stops,
    riskByArea,
    slr: hazard === 'floods' ? slrStop : null,
    mega: Math.round(citywide[peakIndex]),
    headline: story.hero.headline({ nightLow }),
  };
}

/**
 * Heat hazard on the model's 0–4 scale, but continuous so the 3D city eases
 * instead of jumping: 80°F feels-like is 1, 90 is 2, 100 is 3, 105 is 4 (as heatHazard).
 */
export function heatHazardSmooth(heatIndex) {
  const knots = [
    [70, 0],
    [80, 1],
    [90, 2],
    [100, 3],
    [105, 4],
  ];
  if (heatIndex <= knots[0][0]) return 0;
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i];
    if (heatIndex <= x1) {
      const [x0, y0] = knots[i - 1];
      return y0 + ((heatIndex - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return 4;
}

/**
 * What the 3D city's blocks show in the timeline, per neighborhood per hour, with
 * the domain that maps them onto the ramp. Raw values from 39 points barely
 * differ across the city, so the city shows differences instead:
 *   heat:      heat danger = how hot it feels × the neighborhood's vulnerability
 *              (the risk model's Heat Vulnerability Index factor), on the 0–4 scale
 *   air, wind: the difference from the citywide average at that hour; at or below
 *              average stays in the quiet end (0.25 = Low's near-neutral color)
 *   floods:    the share of each neighborhood's land under water at that hour,
 *              computed in the browser from the elevation heightmap (fromTerrain)
 */
export function cityValues(hazard, values) {
  if (hazard === 'floods') {
    // computed in the browser from the elevation heightmap (terrain.js), hour by hour
    return {
      values: null,
      fromTerrain: true,
      domain: [0, FLOOD_FULL_SHARE],
      legend: {
        low: 'Dry',
        high: 'Half or more under water',
        text: "Height and color: how much of each neighborhood's land is under water at this hour, from USGS elevation and the water level at the Battery.",
      },
    };
  }
  const hours = values[0].length;
  if (hazard === 'heat') {
    const danger = values.map((row, i) => row.map((hi) => Math.min(4, heatHazardSmooth(hi) * vulnerabilityFactor(AREAS[i].hvi))));
    return {
      values: danger.map((row) => row.map((d) => d / 4)),
      domain: [0, 1],
      legend: { low: 'Less danger', high: 'More danger', text: 'Height and color: heat danger, how hot it feels times how vulnerable each neighborhood is (NYC Heat Vulnerability Index).' },
    };
  }
  const mean = Array.from({ length: hours }, (_, k) => values.reduce((sum, row) => sum + row[k], 0) / values.length);
  const diff = values.map((row) => row.map((v, k) => v - mean[k]));
  // above and below average scale separately, so the worst place always reaches the top of the ramp
  const up = Math.max(1e-6, ...diff.flat());
  const down = Math.max(1e-6, ...diff.flat().map((d) => -d));
  const what = hazard === 'air' ? 'the air is' : 'the gusts are';
  return {
    values: diff.map((row) => row.map((d) => (d >= 0 ? 0.25 + 0.75 * (d / up) : 0.25 * (1 + d / down)))),
    domain: [0, 1],
    legend: { low: 'Better than average', high: 'Worse than average', text: `Height and color: how much worse ${what} in each neighborhood than the city average at the same hour.` },
  };
}

/** In the flood story's 3D city, a neighborhood with this share of its land under water reaches the top of the ramp. */
export const FLOOD_FULL_SHARE = 0.5;

/** A beat stays on screen until the clock is more than this many hours past it. */
export const BEAT_HOURS = 1;

/**
 * Which beat's text to show at a story hour (−1 for none): the latest beat the
 * clock has reached, but only while the clock is within BEAT_HOURS of it, so the
 * text never describes a different hour from the clock above it. Uses the same
 * rounded hour as the clock. The sea level beat shows while the sea is rising.
 */
export function beatAt(story, hourF, slr = 0) {
  const hour = Math.round(hourF); // the hour the clock shows
  let beat = -1;
  story.beats.forEach((b, i) => {
    if (b.slr ? slr > 0.05 : hour >= b.index) beat = i;
  });
  if (beat < 0 || story.beats[beat].slr) return beat;
  return hour - story.beats[beat].index <= BEAT_HOURS ? beat : -1;
}

// ---------------- playback ----------------
//
// The story's position runs 0–2: 0–1 the timeline, 1–2 "who's exposed". Play moves
// it continuously and loops; it never stops on its own. Speed eases down through
// each beat's window so its text can be read, then back up, with no hard stops.

/** Story position of an hour on the timeline (floods: the clock fills the first 1 − SLR_SHARE). */
function hourToPos(story, hour) {
  if (story.hazard === 'floods') return (hour / story.peak.index) * (1 - SLR_SHARE);
  return hour / (story.time.length - 1);
}

/** Where each step settles: one per beat of the timeline, then one per neighborhood stop. */
export function storySteps(story) {
  const beats = story.beats.map((b) => (b.slr ? 1 : Math.min(1, hourToPos(story, b.index) + 0.002)));
  const stops = story.stops.map((_, i) => 1 + (i + 0.8) / story.stops.length);
  return [...beats, ...stops];
}

export const PLAY = {
  timelineSeconds: 9, // the whole timeline at full speed, between beats
  beatSeconds: 3, // time to cross the two clock hours a beat is on screen
  seaLevelSeconds: 4, // the flood story's closing sea level rise
  stopSeconds: 4.5, // each neighborhood in "who's exposed"
};

/** The stretches of the timeline where a beat is on screen, in story positions. */
function beatWindows(story) {
  const hour = hourToPos(story, 1) - hourToPos(story, 0);
  return story.beats.map((b) => {
    if (b.slr) return { from: 1 - SLR_SHARE, to: 1, seconds: PLAY.seaLevelSeconds, ramp: 0.02 };
    const at = hourToPos(story, b.index);
    // the clock shows a beat's hour from half an hour before it until 1.5 hours after (beatAt)
    return { from: at - 0.5 * hour, to: at + 1.5 * hour, seconds: PLAY.beatSeconds, ramp: hour };
  });
}

/** Play speed at a position, in story positions per second. Always > 0 and smooth. */
export function playRate(story, pos) {
  if (pos >= 1) return 1 / (PLAY.stopSeconds * Math.max(1, story.stops.length));
  const fast = 1 / PLAY.timelineSeconds;
  let rate = fast;
  for (const w of beatWindows(story)) {
    const slow = Math.min(fast, (w.to - w.from) / w.seconds);
    // 1 inside the window, easing to 0 over `ramp` on each side (cosine, so speed has no corners)
    const gap = pos < w.from ? w.from - pos : pos > w.to ? pos - w.to : 0;
    const inside = gap >= w.ramp ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * gap) / w.ramp);
    rate = Math.min(rate, fast + (slow - fast) * inside);
  }
  return rate;
}

/** Advance Play by dtMs. Past the end it wraps back to the start: { pos, looped }. */
export function playStep(story, pos, dtMs) {
  let p = pos;
  // a few sub-steps so a long frame can't skip a beat's slow stretch
  const parts = Math.max(1, Math.ceil(dtMs / 20));
  for (let i = 0; i < parts; i++) p += (playRate(story, p) * dtMs) / parts / 1000;
  return p >= 2 ? { pos: 0, looped: true } : { pos: p, looped: false };
}

/**
 * Spread the 39 modeled neighborhoods across every NTA with inverse-distance
 * weights, computed once. Returns a function (hourIndex) => Float32Array of NTA
 * values; by default the 3D city's 0–1 values (cityValues).
 */
export function ntaBlender(ntas, story, { nearest = 5, power = 2, values = story.city.values } = {}) {
  const weights = ntas.map((f) => {
    const ranked = AREAS.map((a, i) => ({ i, d: kmBetween(f.properties.cx, f.properties.cy, a.lon, a.lat) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, nearest);
    if (ranked[0].d < 0.3) return [{ i: ranked[0].i, w: 1 }];
    const raw = ranked.map(({ i, d }) => ({ i, w: 1 / d ** power }));
    const sum = raw.reduce((s, x) => s + x.w, 0);
    return raw.map(({ i, w }) => ({ i, w: w / sum }));
  });
  return (k) => {
    const out = new Float32Array(ntas.length);
    weights.forEach((ws, n) => {
      let v = 0;
      for (const { i, w } of ws) v += values[i][k] * w;
      out[n] = v;
    });
    return out;
  };
}

/** Water level at the Battery (ft above MHHW) → metres NAVD88, the elevation data's datum. */
export function waterNavdMeters(ftAboveMhhw) {
  return MHHW_NAVD_M + ftAboveMhhw * FT;
}
