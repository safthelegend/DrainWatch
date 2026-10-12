// The app section's map: NYC's neighborhoods (NTAs), with the 39 that
// DrainWatch rates filled in the hazard's ramp and the rest drawn as outlines,
// plus the flood-only layers. No floating chrome: layer switches live in the
// page above the map.
//
// Basemap: standard OpenStreetMap tiles. Free, keyless, no watermark. Dark mode
// is NOT a second tile set: CSS inverts the tile pane only (see style.css,
// ".leaflet-tile-pane"), so switching themes never refetches tiles and can never
// hit a provider's key wall. Our own layers live in other panes and keep their colors.

import { TIDE_STATIONS } from './config.js';
import { FEMA_FLOOD_ZONE_LAYER, FEMA_NFHL } from './data.js';
import { esc } from './ui.js';

// OSM asks apps to use the single tile host, not the old a/b/c subdomains.
const TILES = [
  { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
  // keyless fallback if the main host is blocked or down: OSM France's Humanitarian style, same data
  {
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, tiles <a href="https://www.openstreetmap.fr/">OSM France</a>',
  },
];
const FALLBACK_AFTER_ERRORS = 6;
const RANK = { low: 1, elevated: 2, high: 3, severe: 4 };

let map;
let basemap;
let femaLayer;
let floodLayer;
let floodCanvas;
const layers = {};
const ntaByCode = new Map();
let onPick = () => {};

/** A canvas stretched over a lat/lon box, redrawn in place (no image reloads, so the time machine can scrub smoothly). */
const CanvasOverlay = L.ImageOverlay.extend({
  _initImage() {
    const el = (this._image = this._url);
    L.DomUtil.addClass(el, 'leaflet-image-layer');
    if (this._zoomAnimated) L.DomUtil.addClass(el, 'leaflet-zoom-animated');
    if (this.options.className) L.DomUtil.addClass(el, this.options.className);
    el.onselectstart = L.Util.falseFn;
    el.onmousemove = L.Util.falseFn;
  },
});

export function createMap(el, { onClick }) {
  onPick = onClick;
  map = L.map(el, { zoomControl: false, scrollWheelZoom: false, minZoom: 9, maxZoom: 17, zoomSnap: 0.25 }).setView([40.7, -73.94], 11);
  L.control.zoom({ position: 'topright' }).addTo(map);
  // panes between the basemap (200) and the neighborhoods (400): FEMA zones keep their own colors in dark mode
  map.createPane('fema').style.zIndex = 250;
  map.createPane('flood').style.zIndex = 420;
  map.getPane('flood').style.pointerEvents = 'none';
  addBasemap(el, 0);

  layers.ntas = L.geoJSON(null, {
    style: () => ({ className: 'nta' }),
    onEachFeature: (feature, layer) => {
      ntaByCode.set(feature.properties.code, layer);
    },
  }).addTo(map);
  femaLayer = makeFemaLayer();
  layers.reports = L.layerGroup();
  layers.stations = L.layerGroup();
  layers.refuge = L.layerGroup().addTo(map);
  layers.point = L.layerGroup().addTo(map);

  // The wheel zooms the map only after the reader clicks into it, so scrolling the page never gets stuck.
  map.on('click focus', () => map.scrollWheelZoom.enable());
  map.on('mouseout', () => map.scrollWheelZoom.disable());
  map.on('click', (e) => onPick(e.latlng.lat, e.latlng.lng));
  return map;
}

/** Add tile source `i`; if it fails repeatedly before showing anything, swap to the next keyless source. */
function addBasemap(el, i) {
  const src = TILES[i];
  let errors = 0;
  let loaded = false;
  basemap = L.tileLayer(src.url, { maxZoom: 19, attribution: src.attribution }).addTo(map);
  basemap.once('tileload', () => {
    loaded = true;
    el.classList.add('tiles-ok');
  });
  basemap.on('tileerror', () => {
    errors++;
    if (loaded || errors < FALLBACK_AFTER_ERRORS || i + 1 >= TILES.length) return;
    map.removeLayer(basemap);
    addBasemap(el, i + 1);
  });
}

export async function loadNtas() {
  const geo = await (await fetch('data/nyc-ntas.geojson')).json();
  layers.ntas.addData(geo);
  fitCity();
  return geo.features;
}

/** Frame all five boroughs (call again if the map's box changes size). */
export function fitCity() {
  map.invalidateSize();
  const bounds = layers.ntas.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [16, 16] });
}

/**
 * Paint each neighborhood. levels: { [areaId]: 'low'|'elevated'|'high'|'severe' } for the rated places.
 * tooltip(feature, level) returns the hover text. `worse` (a Set of area ids) gets
 * the time machine's highlight: places whose level rises with sea level rise.
 */
export function paintNtas(levels, tooltip, worse = null) {
  for (const layer of ntaByCode.values()) {
    const f = layer.feature;
    let lvl = null;
    for (const id of f.properties.areas) if (levels[id] && (!lvl || RANK[levels[id]] > RANK[lvl])) lvl = levels[id];
    const up = worse && f.properties.areas.some((id) => worse.has(id));
    const cls = ['leaflet-interactive', 'nta', f.properties.park ? 'park' : '', lvl ? `rated lvl-${lvl}` : '', up ? 'worse' : ''].filter(Boolean).join(' ');
    layer.getElement()?.setAttribute('class', cls);
    if (up) layer.bringToFront();
    layer.unbindTooltip();
    const text = tooltip(f, lvl);
    if (text) layer.bindTooltip(text, { sticky: true, direction: 'top', offset: [0, -6] });
  }
}

export function invalidate() {
  map?.invalidateSize();
}

// FEMA flood zones, drawn by FEMA's own map server as transparent image tiles.
function makeFemaLayer() {
  const FemaLayer = L.TileLayer.extend({
    getTileUrl(coords) {
      const size = this.getTileSize();
      const nw = coords.scaleBy(size);
      const se = nw.add(size);
      const crs = this._map.options.crs;
      const a = crs.project(this._map.unproject(nw, coords.z));
      const b = crs.project(this._map.unproject(se, coords.z));
      const q = new URLSearchParams({
        bbox: [a.x, b.y, b.x, a.y].join(','),
        bboxSR: '3857',
        imageSR: '3857',
        size: `${size.x},${size.y}`,
        layers: `show:${FEMA_FLOOD_ZONE_LAYER}`,
        format: 'png32',
        transparent: 'true',
        f: 'image',
      });
      return `${FEMA_NFHL}/export?${q}`;
    },
  });
  return new FemaLayer('', { pane: 'fema', opacity: 0.6, minZoom: 12, attribution: 'Flood zones: <a href="https://msc.fema.gov/">FEMA</a>' });
}

// ---------------- the time machine's flood extent ----------------

/**
 * Show (or with rgba = null, hide) the flood overlay: RGBA pixels, `size` square,
 * stretched over bbox { west, east, south, north }.
 */
export function setFloodExtent(rgba, size, bbox) {
  if (!rgba) {
    if (floodLayer && map.hasLayer(floodLayer)) map.removeLayer(floodLayer);
    map.getContainer().classList.remove('show-flood');
    return;
  }
  if (!floodCanvas) {
    floodCanvas = document.createElement('canvas');
    floodCanvas.width = floodCanvas.height = size;
    floodCanvas.setAttribute('aria-hidden', 'true');
    floodLayer = new CanvasOverlay(floodCanvas, [[bbox.south, bbox.west], [bbox.north, bbox.east]], { pane: 'flood', interactive: false, className: 'flood-extent' });
  }
  floodCanvas.getContext('2d').putImageData(new ImageData(rgba, size, size), 0, 0);
  if (!map.hasLayer(floodLayer)) map.addLayer(floodLayer);
  map.getContainer().classList.add('show-flood');
}

// ---------------- refuge: evacuation center and higher ground for a checked address ----------------

/** from: { lat, lon }; center / higher: { lat, lon, ... } or null. */
export function showRefuge(from, { center, higher }) {
  layers.refuge.clearLayers();
  const add = (to, cls, html, title) => {
    L.polyline([[from.lat, from.lon], [to.lat, to.lon]], { className: `refuge-line ${cls}`, interactive: false }).addTo(layers.refuge);
    L.marker([to.lat, to.lon], { icon: L.divIcon({ className: '', html, iconSize: null }), title, zIndexOffset: 900 }).addTo(layers.refuge);
  };
  if (higher && higher.km > 0.05) add(higher, 'to-high', '<span class="refuge-mark high">▲ Higher ground</span>', 'Nearest higher ground');
  if (center) add(center, 'to-center', `<span class="refuge-mark center">EC · ${esc(center.name)}</span>`, `Evacuation center: ${center.name}`);
}

export function clearRefuge() {
  layers.refuge.clearLayers();
}

/** Zoom so the address and its refuges are all in view. */
export function frame(points) {
  const valid = points.filter(Boolean).map((p) => [p.lat, p.lon]);
  if (valid.length > 1) map.flyToBounds(valid, { padding: [48, 48], maxZoom: 15, duration: 0.6 });
}

/** The flood-only overlays, switched by the checkboxes above the map. */
export const OVERLAYS = {
  fema: { label: 'FEMA flood zones (zoom in)', layer: () => femaLayer },
  reports: { label: '311 street flooding, 7 days', layer: () => layers.reports },
  stations: { label: 'Tide gauges', layer: () => layers.stations },
};

export function setOverlay(key, on) {
  const layer = OVERLAYS[key].layer();
  if (on && !map.hasLayer(layer)) map.addLayer(layer);
  if (!on && map.hasLayer(layer)) map.removeLayer(layer);
}

export function drawReports(reports, popupFor) {
  layers.reports.clearLayers();
  for (const rep of reports || []) {
    L.circleMarker([rep.lat, rep.lon], { radius: 3, className: 'report-dot', weight: 1, fillOpacity: 1, bubblingMouseEvents: false })
      .bindPopup(popupFor(rep))
      .addTo(layers.reports);
  }
}

export function drawStations(tides, popupFor) {
  layers.stations.clearLayers();
  for (const [key, s] of Object.entries(TIDE_STATIONS)) {
    const tide = tides ? tides[key] : null;
    const text = tide && tide.latest ? `${tide.latest.v.toFixed(1)} ft` : s.name;
    L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: '', html: `<span class="gauge-mark">${text}</span>`, iconSize: null }),
      title: `${s.name} tide gauge`,
    })
      .bindPopup(popupFor(key, s, tide))
      .addTo(layers.stations);
  }
}

export function showPoint(lat, lon) {
  layers.point.clearLayers();
  L.marker([lat, lon], {
    icon: L.divIcon({ className: '', html: '<span class="pin-here" style="display:block"></span>', iconSize: [16, 16], iconAnchor: [8, 8] }),
    title: 'Checked address',
    zIndexOffset: 1000,
  }).addTo(layers.point);
  map.flyTo([lat, lon], Math.max(map.getZoom(), 13), { duration: 0.6 });
}

export function clearPoint() {
  layers.point.clearLayers();
  layers.refuge.clearLayers();
}

export function openPopupAt(lat, lon, html) {
  L.popup({ maxWidth: 320 }).setLatLng([lat, lon]).setContent(html).openOn(map);
}

export function flyTo(lat, lon, zoom = 13) {
  map.flyTo([lat, lon], zoom, { duration: 0.6 });
}
