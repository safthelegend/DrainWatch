// Builds data/nyc-ntas.geojson: NYC's 195 Neighborhood Tabulation Areas (2010)
// with a centroid, a "park" flag, and the DrainWatch neighborhoods each one
// contains (most contain none; a few contain two).
//
// Source: NYC Department of City Planning NTA boundaries, simplified and
// published by the NYC Health Department's Environment & Health team:
// https://github.com/nycehs/NYC_geography
//
// Usage:  node scripts/build-geodata.mjs [path-or-url-to-NTA.geo.json]

import { readFile, writeFile } from 'node:fs/promises';
import { AREAS } from '../js/config.js';
import { centroid, inGeometry, kmBetween } from '../js/story/geo.js';

const SOURCE = process.argv[2] || 'https://raw.githubusercontent.com/nycehs/NYC_geography/master/NTA.geo.json';

const raw = SOURCE.startsWith('http') ? await (await fetch(SOURCE)).json() : JSON.parse(await readFile(SOURCE, 'utf8'));

const round = (geometry) => {
  const r = (ring) => ring.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]);
  if (geometry.type === 'Polygon') return { type: 'Polygon', coordinates: geometry.coordinates.map(r) };
  return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((p) => p.map(r)) };
};

const features = raw.features
  .map((f) => {
    const p = f.properties;
    const [cx, cy] = centroid(f.geometry);
    // "park-cemetery-etc" areas and airports have (almost) no residents.
    const park = /park-cemetery|airport/i.test(p.NTAName) || /99$/.test(p.NTACode);
    return {
      type: 'Feature',
      properties: { code: p.NTACode, name: p.NTAName, boro: p.BoroName, park, cx: +cx.toFixed(5), cy: +cy.toFixed(5), areas: [] },
      geometry: round(f.geometry),
    };
  })
  .sort((a, b) => a.properties.code.localeCompare(b.properties.code));

// Each DrainWatch neighborhood claims the NTA its point falls in (or the nearest one).
for (const area of AREAS) {
  let hit = features.find((f) => !f.properties.park && inGeometry(area.lon, area.lat, f.geometry));
  if (!hit) {
    hit = features
      .filter((f) => !f.properties.park)
      .reduce((best, f) => {
        const d = kmBetween(area.lon, area.lat, f.properties.cx, f.properties.cy);
        return !best || d < best.d ? { f, d } : best;
      }, null).f;
  }
  hit.properties.areas.push(area.id);
  console.log(`${area.id.padEnd(20)} → ${hit.properties.code} ${hit.properties.name}`);
}

await writeFile(new URL('../data/nyc-ntas.geojson', import.meta.url), JSON.stringify({ type: 'FeatureCollection', features }));
console.log(`wrote ${features.length} neighborhoods`);
