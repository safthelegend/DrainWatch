// The time machine's flood map, the higher-ground finder and the comparison.
// Run with:  node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { AREAS } from '../js/config.js';
import { assessPlace, HAZARD_ORDER } from '../js/hazards.js';
import { buildScenario, replayWaterSeries, SEA_LEVEL_STOPS } from '../js/scenarios.js';
import { waterNavdMeters } from '../js/story/stories.js';
import { parseEvacuationCenters, parseEvacuationZone } from '../js/data.js';
import { compareHtml } from '../js/compare.js';
import { refugeHtml } from '../js/panels.js';
import {
  cellAreaKm2,
  compassWord,
  elevationAt,
  floodCounts,
  floodImage,
  floodMask,
  gridFromPixels,
  nearestHigherGround,
  walkMinutes,
} from '../js/flood-extent.js';

// A 6×6 test island, west coast on open water (column 0). Elevations in metres:
//   col:   0    1    2    3    4    5
const E = [
  [-5, 1, 2, 9, 9, 9],
  [-5, 1, 2, 9, 0.5, 9], // (1,4) is a low basin walled in by 9 m ground
  [-5, 1, 2, 9, 9, 9],
  [-5, 1, 3, 4, 5, 6],
  [-5, -5, -5, -5, -5, -5], // a channel of open water
  [-5, 1, 1, 9, 9, 9], // a second island south of the channel, with its own hill
];
const SIZE = 6;
const BBOX = { west: -74.06, east: -74.0, south: 40.7, north: 40.76 };
function testGrid() {
  const elev = new Float32Array(SIZE * SIZE);
  const nta = new Uint8Array(SIZE * SIZE);
  E.flat().forEach((e, k) => {
    elev[k] = e;
    nta[k] = e < 0 ? 0 : 1;
  });
  return { size: SIZE, bbox: BBOX, elev, nta };
}
const at = (row, col) => row * SIZE + col;
const center = (row, col) => ({ lat: BBOX.north - ((row + 0.5) / SIZE) * (BBOX.north - BBOX.south), lon: BBOX.west + ((col + 0.5) / SIZE) * (BBOX.east - BBOX.west) });

test('water spreads only to low land that touches the sea; walled-in basins stay dry', () => {
  const g = testGrid();
  const m = floodMask(g, 1.5);
  assert.equal(m[at(0, 1)], 1, 'low coast floods');
  assert.equal(m[at(0, 2)], 0, '2 m ground stays dry at 1.5 m');
  assert.equal(m[at(1, 4)], 0, 'the 0.5 m basin behind the ridge stays dry');
  assert.equal(floodMask(g, 2.5)[at(0, 2)], 1, 'raising the water reaches higher ground');
  const { land, wet } = floodCounts(g, [floodMask(g, 1.5), floodMask(g, 2.5)]);
  assert.equal(land[1], 6 * 6 - 6 - 5);
  assert.ok(wet[1][1] > wet[0][1], 'more water floods more land');
});

test('higher ground is found on foot, never across open water', () => {
  const g = testGrid();
  const from = center(3, 1); // 1 m ground on the north island
  const h = nearestHigherGround(g, from.lat, from.lon, 4, 10);
  assert.ok(h, 'there is a 4 m+ hill on this island');
  assert.ok(h.elevM >= 4);
  assert.ok(h.lat > center(4, 0).lat, 'the answer is on the north island, not across the channel');
  const south = center(5, 1);
  assert.equal(nearestHigherGround(g, south.lat, south.lon, 20, 10), null, 'nothing qualifies, so nothing is offered');
});

test('helpers: elevation lookup, cell size, direction words and walking time', () => {
  const g = testGrid();
  const p = center(1, 4);
  assert.equal(elevationAt(g, p.lat, p.lon), 0.5);
  assert.equal(elevationAt(g, 41.5, -74), null, 'outside the grid');
  assert.ok(cellAreaKm2(g) > 0.5 && cellAreaKm2(g) < 1.5);
  assert.equal(compassWord(40.7, -74, 40.8, -74), 'north');
  assert.equal(compassWord(40.7, -74, 40.7, -73.9), 'east');
  assert.equal(compassWord(40.7, -74, 40.6, -74.1), 'southwest');
  assert.equal(walkMinutes(0.1), 5);
  assert.equal(walkMinutes(1.5), 20);
});

test('the overlay paints flooded land, and land only sea level rise reaches in a second color', () => {
  const g = testGrid();
  const base = floodMask(g, 1.5);
  const plus = floodMask(g, 2.5);
  const px = floodImage(g, { base, plus, baseLevelM: 1.5, baseRgb: [0, 0, 255], plusRgb: [255, 128, 0] });
  const colors = new Set();
  for (let k = 0; k < SIZE * SIZE; k++) if (px[k * 4 + 3]) colors.add(`${px[k * 4]},${px[k * 4 + 2]}`);
  assert.deepEqual([...colors].sort(), ['0,255', '255,0']);
  assert.equal(px[at(0, 0) * 4 + 3], 0, 'open water itself is left clear');
});

// ---------------- the real city ----------------

function decodePng(buf) {
  let pos = 8;
  let width;
  let colorType;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * stride);
  for (let y = 0; y < width; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = raw[y * (stride + 1) + 1 + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, bpp, pixels: out };
}

const png = decodePng(readFileSync(new URL('../data/nyc-elevation.png', import.meta.url)));
const city = gridFromPixels(png.pixels, png.width, undefined, png.bpp);
const sandyFt = buildScenario('sandy').tides.battery.peak;
const future = SEA_LEVEL_STOPS.find((s) => s.id === '2080s');

test("a Sandy-size surge floods about as much of the city as Sandy did (~51 sq mi)", () => {
  const cell = cellAreaKm2(city);
  const { land, wet } = floodCounts(city, [floodMask(city, waterNavdMeters(sandyFt)), floodMask(city, waterNavdMeters(sandyFt + future.inches / 12))]);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const landKm2 = sum(land) * cell;
  const sandyKm2 = sum(wet[0]) * cell;
  const futureKm2 = sum(wet[1]) * cell;
  assert.ok(landKm2 > 740 && landKm2 < 820, `NYC land area ~783 km², got ${landKm2.toFixed(0)}`);
  assert.ok(sandyKm2 > 115 && sandyKm2 < 165, `Sandy flooded ~132 km² (51 sq mi), model ${sandyKm2.toFixed(0)}`);
  assert.ok(futureKm2 > sandyKm2 * 1.1, '2080s seas spread the same storm noticeably further');
});

test('higher ground near Red Hook is a short walk inland, above the 2080s Sandy line', () => {
  const area = AREAS.find((a) => a.id === 'red-hook');
  const min = waterNavdMeters(sandyFt + future.inches / 12) + 0.9;
  assert.ok(elevationAt(city, area.lat, area.lon) < min, 'Red Hook itself is low');
  const h = nearestHigherGround(city, area.lat, area.lon, min, 5);
  assert.ok(h && h.km < 2, `found ${h && h.km.toFixed(2)} km away`);
  assert.ok(h.elevM >= min);
});

test('the storm-hour scrubber follows the replayed surge and peaks near 9 ft for Sandy', () => {
  const s = replayWaterSeries('sandy');
  assert.equal(s.time.length, s.level.length);
  assert.ok(Math.abs(s.level[s.peak] - 9) < 0.5, `peak ${s.level[s.peak]}`);
  assert.ok(s.level[0] < s.level[s.peak] - 3, 'it rises toward the peak');
});

// ---------------- evacuation data and the HTML ----------------

test('evacuation zones and centers parse from NYC Open Data rows', () => {
  assert.equal(parseEvacuationZone([{ hurricane_: '1' }]), '1');
  assert.equal(parseEvacuationZone([{ hurricane_: 'X' }]), null);
  assert.equal(parseEvacuationZone([]), null);
  const [c] = parseEvacuationCenters([
    { bldg_name: 'P.S. 1', bldg_add: '1 Main St', city: 'Brooklyn', accessible: 'Y', the_geom: { type: 'Point', coordinates: [-73.99, 40.69] } },
    { bldg_name: 'No location' },
  ]);
  assert.deepEqual(c, { name: 'P.S. 1', address: '1 Main St, Brooklyn', accessible: true, lon: -73.99, lat: 40.69 });
});

test('the safety plan says what it knows and admits what it is still checking', () => {
  const loading = refugeHtml({ zone: undefined, center: undefined, terrain: false }, 'floods');
  assert.match(loading, /Checking NYC Emergency Management/);
  assert.match(loading, /Reading the elevation map/);
  const done = refugeHtml(
    {
      zone: '1',
      center: { name: 'P.S. 15', address: '71 Sullivan St, Brooklyn', accessible: true, km: 0.8, compass: 'east' },
      terrain: { hereM: 2, sandyM: 3.4, futureM: 4.2, minM: 5.1, higher: { km: 0.9, routeKm: 1, compass: 'northeast', elevM: 6.5, minutes: 15 } },
    },
    'heat',
  );
  assert.match(done, /Zone 1/);
  assert.match(done, /P\.S\. 15/);
  assert.match(done, /0\.9 km northeast/);
  assert.match(done, /Cooling center finder/, 'the hazard on screen picks the first link');
  assert.match(refugeHtml({ zone: null, center: 'error', terrain: { hereM: 20, sandyM: 3.4, futureM: 4.2, minM: 5.1, higher: null } }, 'floods'), /already on higher ground/);
});

test('the comparison shades the riskier side and names the overall difference', () => {
  const inputs = buildScenario('sandy');
  const side = (id, terrain, zone) => {
    const i = AREAS.findIndex((a) => a.id === id);
    return { area: AREAS[i], results: Object.fromEntries(HAZARD_ORDER.map((h) => [h, assessPlace(h, AREAS[i], inputs, i)])), terrain, zone };
  };
  const html = compareHtml(side('red-hook', { medianM: 2, sandyPct: 80, futurePct: 95 }, '1'), side('park-slope', { medianM: 30, sandyPct: 0, futurePct: 0 }, null), {
    available: { floods: true, heat: true, air: true, wind: true },
    when: 'in the Sandy 2012 replay',
    slrLabel: '',
  });
  assert.match(html, /<b>Red Hook<\/b> rates riskier than Park Slope/);
  assert.match(html, /sits about 91 ft lower/); // 2 m ≈ 7 ft vs. 30 m ≈ 98 ft
  assert.ok((html.match(/worse-side/g) || []).length >= 5);
  assert.match(html, /\+15 pts/);
});
