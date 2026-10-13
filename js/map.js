// The dashboard's map: NYC's neighborhoods (NTAs), with the 39 that DrainWatch
// rates filled in the hazard's ramp and the rest drawn as outlines, plus the
// flood-only layers (flooded land from the elevation model, FEMA zones, 311
// reports, tide gauges), the checked address with its route to higher ground,
// and the two neighborhoods being compared.

import { TIDE_STATIONS } from './config.js';
import { FEMA_FLOOD_ZONE_LAYER, FEMA_NFHL } from './data.js';
import { esc, tideLevelText } from './ui.js';

// Free, keyless basemaps. Both themes use the same tiles: dark mode is a CSS
// filter on the tile pane (css/style.css), so switching themes never refetches
// tiles and the risk colors drawn on top are never inverted. If the main
// OpenStreetMap server refuses us before a single tile loads, the map switches
// once to the Humanitarian OSM style, which is also keyless.
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const BASEMAPS = [
  { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', options: { maxZoom: 19, attribution: OSM_ATTRIBUTION } },
  {
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    options: { maxZoom: 19, subdomains: 'abc', attribution: `${OSM_ATTRIBUTION}, style <a href="https://www.hotosm.org/">HOT</a> via <a href="https://openstreetmap.fr/">OSM France</a>` },
  },
];
const FALLBACK_AFTER_ERRORS = 4;
const RANK = { low: 1, elevated: 2, high: 3, severe: 4 };

let map;
let basemap;
let femaLayer;
let floodImage = null;
let floodKey = '';
const layers = {};
const ntaByCode = new Map();
let onPick = () => {};

function addBasemap(el, i) {
  const { url, options } = BASEMAPS[i];
  let loaded = false;
  let errors = 0;
  basemap = L.tileLayer(url, { ...options, className: 'basemap' }).addTo(map);
  basemap.on('tileload', () => {
    loaded = true;
    el.classList.add('tiles-ok');
  });
  basemap.on('tileerror', () => {
    if (loaded || ++errors < FALLBACK_AFTER_ERRORS || i + 1 >= BASEMAPS.length) return;
    map.removeLayer(basemap);
    addBasemap(el, i + 1);
  });
}

export function createMap(el, { onClick }) {
  onPick = onClick;
  map = L.map(el, { zoomControl: false, scrollWheelZoom: false, minZoom: 9, maxZoom: 18, zoomSnap: 0.25 }).setView([40.7, -73.94], 11);
  L.control.zoom({ position: 'topright' }).addTo(map);
  addBasemap(el, 0);

  layers.ntas = L.geoJSON(null, {
    style: () => ({ className: 'nta' }),
    onEachFeature: (feature, layer) => {
      ntaByCode.set(feature.properties.code, layer);
    },
  }).addTo(map);
  femaLayer = makeFemaLayer();
  layers.flood = L.layerGroup();
  layers.reports = L.layerGroup();
  layers.stations = L.layerGroup();
  layers.pair = L.layerGroup().addTo(map);
  layers.point = L.layerGroup().addTo(map);

  // The wheel zooms the map only after the reader clicks into it, so scrolling the page never gets stuck.
  map.on('click focus', () => map.scrollWheelZoom.enable());
  map.on('mouseout', () => map.scrollWheelZoom.disable());
  map.on('click', (e) => onPick(e.latlng.lat, e.latlng.lng));
  const zoomed = () => {
    for (const [cls, on] of Object.entries(zoomClasses(map.getZoom()))) el.classList.toggle(cls, on);
  };
  map.on('zoomend', zoomed);
  zoomed();
  return map;
}

/**
 * Classes for the map box by zoom level:
 *   zoom-close   (14+)  neighborhood fills go pale so street names and the route stay readable
 *   street-zoom  (16+)  the ~110 m flooded-land cells are too coarse to draw
 */
export function zoomClasses(zoom) {
  return { 'zoom-close': zoom >= 14, 'street-zoom': zoom > 15 };
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
 * tooltip(feature, level) returns the hover text. `raised` holds the area ids whose
 * level the Time Machine's sea level rise pushed up; they get a highlighted outline.
 */
export function paintNtas(levels, tooltip, raised = new Set()) {
  for (const layer of ntaByCode.values()) {
    const f = layer.feature;
    let lvl = null;
    for (const id of f.properties.areas) if (levels[id] && (!lvl || RANK[levels[id]] > RANK[lvl])) lvl = levels[id];
    const up = f.properties.areas.some((id) => raised.has(id));
    const cls = ['leaflet-interactive', 'nta', f.properties.park ? 'park' : '', lvl ? `rated lvl-${lvl}` : '', up ? 'delta-up' : ''].filter(Boolean).join(' ');
    layer.getElement()?.setAttribute('class', cls);
    if (up) layer.bringToFront();
    layer.unbindTooltip();
    const text = tooltip(f, lvl);
    if (text) layer.bindTooltip(text, { sticky: true, direction: 'top', offset: [0, -6] });
    // Leaflet makes a shape with a tooltip a Tab stop; ~190 unnamed stops would bury the
    // address search, and the Neighborhoods table already lists every rated place
    layer.getElement()?.setAttribute('tabindex', '-1');
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
  return new FemaLayer('', { opacity: 0.6, minZoom: 12, attribution: 'Flood zones: <a href="https://msc.fema.gov/">FEMA</a>' });
}

/**
 * Land under water. `key` names the water levels and colors; makeRaster() returns
 * terrain.floodRaster()'s { width, height, data, bounds } and only runs when the key changes.
 */
export function drawFlood(key, makeRaster) {
  if (key === floodKey) return;
  floodKey = key;
  if (floodImage) layers.flood.removeLayer(floodImage);
  floodImage = null;
  const raster = makeRaster();
  if (!raster) return;
  const c = document.createElement('canvas');
  c.width = raster.width;
  c.height = raster.height;
  c.getContext('2d').putImageData(new ImageData(raster.data, raster.width, raster.height), 0, 0);
  floodImage = L.imageOverlay(c.toDataURL(), raster.bounds, { className: 'flood-image', interactive: false, attribution: 'Elevation: <a href="https://www.usgs.gov/3d-elevation-program">USGS 3DEP</a>' });
  layers.flood.addLayer(floodImage);
}

/** The flood-only overlays, switched by the checkboxes on the map. */
export const OVERLAYS = {
  flood: { label: 'Land under water (elevation estimate)', layer: () => layers.flood },
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
    const reading = tide && tide.latest ? `<small>${tideLevelText(tide.latest.v)}</small>` : '';
    L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: '', html: `<span class="gauge-mark"><b>${esc(s.name)}</b>${reading}</span>`, iconSize: null }),
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
}

/** A dashed route from the checked address to the nearest higher ground, framed on the map. */
export function showRefuge(from, to) {
  layers.point.eachLayer((l) => l.options.refuge && layers.point.removeLayer(l));
  const line = L.polyline(
    [
      [from.lat, from.lon],
      [to.lat, to.lon],
    ],
    { className: 'refuge-line', interactive: false, refuge: true },
  );
  const mark = L.marker([to.lat, to.lon], {
    icon: L.divIcon({ className: '', html: '<span class="refuge-mark">▲ Higher ground</span>', iconSize: null }),
    title: 'Nearest higher ground',
    refuge: true,
    zIndexOffset: 900,
  });
  layers.point.addLayer(line).addLayer(mark);
  map.flyToBounds(line.getBounds(), { padding: [70, 70], maxZoom: 16, duration: 0.6 });
}

/** Pins A and B on the two neighborhoods being compared, framed together. */
export function showPair(a, b) {
  layers.pair.clearLayers();
  for (const [tag, p] of [
    ['A', a],
    ['B', b],
  ]) {
    L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: `<span class="pair-mark">${tag} · ${esc(p.name)}</span>`, iconSize: null }), title: p.name }).addTo(layers.pair);
  }
  map.flyToBounds(
    L.latLngBounds([
      [a.lat, a.lon],
      [b.lat, b.lon],
    ]),
    { padding: [90, 90], maxZoom: 14, duration: 0.6 },
  );
}

export function clearPair() {
  layers.pair.clearLayers();
}

export function openPopupAt(lat, lon, html) {
  L.popup({ maxWidth: 320 }).setLatLng([lat, lon]).setContent(html).openOn(map);
}

export function flyTo(lat, lon, zoom = 13) {
  map.flyTo([lat, lon], zoom, { duration: 0.6 });
}
