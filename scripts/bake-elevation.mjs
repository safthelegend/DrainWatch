// Bakes data/nyc-elevation.png: a small heightmap of New York City for the
// flood story's rising-water scene. Run once; the output is committed.
//
// Source: AWS Terrain Tiles ("terrarium" encoding, zoom 12, ~38 m pixels),
// which in the United States are built from the USGS 3D Elevation Program
// (3DEP / NED). https://registry.opendata.aws/terrain-tiles/
//
// Output encoding (8-bit RGB PNG, one pixel per grid cell, north at the top):
//   elevation_m = (R * 256 + G) / 100 - 100      (centimetre steps, NAVD88-ish)
//   B = 1 + index of the NYC neighborhood (NTA) the cell is in, or 0 for water / outside NYC
//
// Usage:  node scripts/bake-elevation.mjs [--tiles <dir with z/x/y.png already downloaded>]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';
import { inGeometry } from '../js/story/geo.js';
import { ELEVATION } from '../js/story/elevation.js';

const BBOX = ELEVATION.bbox;
const SIZE = ELEVATION.size;
const ZOOM = 12;
const args = process.argv.slice(2);
const tilesDir = args.includes('--tiles') ? args[args.indexOf('--tiles') + 1] : null;

// ---------------- PNG decode / encode (just enough for 8-bit RGB/RGBA) ----------------

function decodePng(buf) {
  let pos = 8;
  let width;
  let height;
  let colorType;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error('only 8-bit PNGs are supported');
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : null;
  if (!bpp) throw new Error(`unsupported PNG color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, bpp, pixels: out };
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePngRgb(width, height, rgb) {
  const stride = width * 3;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride + 1);
    row[0] = 1; // "Sub" filter compresses smooth terrain well
    for (let x = 0; x < stride; x++) row[x + 1] = (rgb[y * stride + x] - (x >= 3 ? rgb[y * stride + x - 3] : 0)) & 255;
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------- tiles ----------------

const worldPx = (lon, lat) => {
  const n = 256 * 2 ** ZOOM;
  const phi = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n];
};

const [x0, y0] = worldPx(BBOX.west, BBOX.north);
const [x1, y1] = worldPx(BBOX.east, BBOX.south);
const tx0 = Math.floor(x0 / 256);
const ty0 = Math.floor(y0 / 256);
const tx1 = Math.floor(x1 / 256);
const ty1 = Math.floor(y1 / 256);
const tiles = new Map();

for (let tx = tx0; tx <= tx1; tx++) {
  for (let ty = ty0; ty <= ty1; ty++) {
    let buf;
    if (tilesDir) buf = await readFile(`${tilesDir}/${ZOOM}/${tx}/${ty}.png`);
    else {
      const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${tx}/${ty}.png`);
      if (!res.ok) throw new Error(`tile ${tx}/${ty}: ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    }
    tiles.set(`${tx}/${ty}`, decodePng(buf));
  }
}
console.log(`decoded ${tiles.size} tiles`);

function elevAtPx(px, py) {
  const t = tiles.get(`${Math.floor(px / 256)}/${Math.floor(py / 256)}`);
  const x = Math.min(255, Math.max(0, Math.floor(px) % 256));
  const y = Math.min(255, Math.max(0, Math.floor(py) % 256));
  const i = (y * 256 + x) * t.bpp;
  return t.pixels[i] * 256 + t.pixels[i + 1] + t.pixels[i + 2] / 256 - 32768;
}

function elevation(lon, lat) {
  // bilinear between the four surrounding source pixels
  const [px, py] = worldPx(lon, lat);
  const fx = px - 0.5;
  const fy = py - 0.5;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const dx = fx - ix;
  const dy = fy - iy;
  const e00 = elevAtPx(ix, iy);
  const e10 = elevAtPx(ix + 1, iy);
  const e01 = elevAtPx(ix, iy + 1);
  const e11 = elevAtPx(ix + 1, iy + 1);
  return e00 * (1 - dx) * (1 - dy) + e10 * dx * (1 - dy) + e01 * (1 - dx) * dy + e11 * dx * dy;
}

// ---------------- grid ----------------

const ntas = JSON.parse(await readFile(new URL('../data/nyc-ntas.geojson', import.meta.url), 'utf8')).features;
const boxes = ntas.map((f) => {
  const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
  let w = Infinity;
  let e = -Infinity;
  let s = Infinity;
  let n = -Infinity;
  for (const rings of polys)
    for (const [x, y] of rings[0]) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
  return { w, e, s, n };
});

const rgb = Buffer.alloc(SIZE * SIZE * 3);
let land = 0;
let maxElev = -Infinity;
for (let row = 0; row < SIZE; row++) {
  const lat = BBOX.north - ((row + 0.5) / SIZE) * (BBOX.north - BBOX.south);
  for (let col = 0; col < SIZE; col++) {
    const lon = BBOX.west + ((col + 0.5) / SIZE) * (BBOX.east - BBOX.west);
    const elev = elevation(lon, lat);
    let nta = 0;
    for (let k = 0; k < ntas.length; k++) {
      const b = boxes[k];
      if (lon < b.w || lon > b.e || lat < b.s || lat > b.n) continue;
      if (inGeometry(lon, lat, ntas[k].geometry)) {
        nta = k + 1;
        break;
      }
    }
    if (nta) {
      land++;
      maxElev = Math.max(maxElev, elev);
    }
    const v = Math.max(0, Math.min(65535, Math.round((elev + 100) * 100)));
    const i = (row * SIZE + col) * 3;
    rgb[i] = v >> 8;
    rgb[i + 1] = v & 255;
    rgb[i + 2] = nta;
  }
}

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
const png = encodePngRgb(SIZE, SIZE, rgb);
await writeFile(new URL('../data/nyc-elevation.png', import.meta.url), png);
console.log(`wrote ${SIZE}×${SIZE} heightmap (${(png.length / 1024).toFixed(0)} KB), ${land} land cells, highest point ${maxElev.toFixed(1)} m`);
