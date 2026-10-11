// Adds tree canopy and air conditioning numbers to the heat story's annotations.
//
// The NYC Environment & Health Data Portal publishes both by neighborhood, but
// its site can't be reached from every network, so this runs on your machine:
//
//   1. Open https://a816-dohbesp.nyc.gov/IndicatorPublic/ and find
//        • "Tree canopy cover"            (percent of land, by neighborhood / NTA)
//        • "Household air conditioning"   (percent of homes with AC, by neighborhood)
//      For each, choose the neighborhood geography, the latest year, and download the CSV.
//   2. node scripts/import-heat-drivers.mjs --tree tree-canopy.csv --ac air-conditioning.csv
//
// Writes data/heat-drivers.json. The page loads it if it exists; without it the
// annotations show the Heat Vulnerability Index, peak feels-like and overnight low.
//
// The CSV reader is deliberately forgiving: it finds the geography column (NTA
// codes like "MN34" or neighborhood names) and the value column on its own. Use
// --value "Column name" if it picks the wrong one.

import { readFile, writeFile } from 'node:fs/promises';
import { AREAS } from '../js/config.js';

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** NTA codes each DrainWatch neighborhood sits in (from data/nyc-ntas.geojson). */
async function areaNtas() {
  const geo = JSON.parse(await readFile(new URL('../data/nyc-ntas.geojson', import.meta.url), 'utf8'));
  const map = {};
  for (const f of geo.features) for (const id of f.properties.areas) map[id] = { code: f.properties.code, name: f.properties.name };
  return map;
}

export function extract(rows, ntas, valueColumn = null) {
  const cols = Object.keys(rows[0] || {});
  const geoCol =
    cols.find((c) => rows.some((r) => /^[A-Z]{2}\d{2}$/.test(r[c]))) ||
    cols.find((c) => /geography|neighborhood|nta|name/i.test(c) && !/id$/i.test(c)) ||
    cols[0];
  const numeric = (c) => rows.filter((r) => r[c] !== '' && !Number.isNaN(parseFloat(r[c].replace(/[%,]/g, '')))).length > rows.length / 2;
  const valCol =
    valueColumn ||
    cols.find((c) => /percent|rate|value|%/i.test(c) && numeric(c)) ||
    [...cols].reverse().find((c) => c !== geoCol && numeric(c) && !/year|id/i.test(c));
  const out = {};
  for (const area of AREAS) {
    const nta = ntas[area.id];
    if (!nta) continue;
    const row =
      rows.find((r) => r[geoCol] === nta.code) ||
      rows.find((r) => norm(r[geoCol]) === norm(nta.name)) ||
      rows.find((r) => norm(r[geoCol]).includes(norm(area.name.split('/')[0])) || norm(nta.name).includes(norm(r[geoCol]) || '\u0000'));
    if (row) out[area.id] = parseFloat(row[valCol].replace(/[%,]/g, ''));
  }
  return { geoCol, valCol, values: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tree = opt('--tree');
  const ac = opt('--ac');
  if (!tree && !ac) {
    console.log('Usage: node scripts/import-heat-drivers.mjs --tree tree-canopy.csv --ac air-conditioning.csv [--value "Column"]');
    process.exit(1);
  }
  const ntas = await areaNtas();
  const byArea = {};
  const sources = [];
  for (const [flag, key] of [
    [tree, 'treeCanopy'],
    [ac, 'airConditioning'],
  ]) {
    if (!flag) continue;
    const { geoCol, valCol, values } = extract(parseCsv(await readFile(flag, 'utf8')), ntas, opt('--value'));
    console.log(`${flag}: geography "${geoCol}", value "${valCol}", matched ${Object.keys(values).length} of ${AREAS.length} neighborhoods`);
    for (const [id, v] of Object.entries(values)) (byArea[id] ||= {})[key] = v;
    sources.push(flag.split('/').pop());
  }
  await writeFile(
    new URL('../data/heat-drivers.json', import.meta.url),
    JSON.stringify({ source: 'NYC Environment & Health Data Portal', files: sources, generated: new Date().toISOString().slice(0, 10), byArea }, null, 1),
  );
  console.log('wrote data/heat-drivers.json');
}
