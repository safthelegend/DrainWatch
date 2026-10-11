// The app section's map: NYC's neighborhoods (NTAs), with the 39 that
// DrainWatch rates filled in the hazard's ramp and the rest drawn as outlines,
// plus the flood-only layers. No floating chrome: layer switches live in the
// page above the map.

import { TIDE_STATIONS } from './config.js';
import { FEMA_FLOOD_ZONE_LAYER, FEMA_NFHL } from './data.js';

const TILE_URL = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const RANK = { low: 1, elevated: 2, high: 3, severe: 4 };

let map;
let basemap;
let femaLayer;
const layers = {};
const ntaByCode = new Map();
let onPick = () => {};

export function createMap(el, { theme, onClick }) {
  onPick = onClick;
  map = L.map(el, { zoomControl: false, scrollWheelZoom: false, minZoom: 9, maxZoom: 17, zoomSnap: 0.25 }).setView([40.7, -73.94], 11);
  L.control.zoom({ position: 'topright' }).addTo(map);
  basemap = L.tileLayer(TILE_URL[theme], {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  basemap.once('tileload', () => el.classList.add('tiles-ok'));
  basemap.on('tileerror', () => {});

  layers.ntas = L.geoJSON(null, {
    style: () => ({ className: 'nta' }),
    onEachFeature: (feature, layer) => {
      ntaByCode.set(feature.properties.code, layer);
    },
  }).addTo(map);
  femaLayer = makeFemaLayer();
  layers.reports = L.layerGroup();
  layers.stations = L.layerGroup();
  layers.point = L.layerGroup().addTo(map);

  // The wheel zooms the map only after the reader clicks into it, so scrolling the page never gets stuck.
  map.on('click focus', () => map.scrollWheelZoom.enable());
  map.on('mouseout', () => map.scrollWheelZoom.disable());
  map.on('click', (e) => onPick(e.latlng.lat, e.latlng.lng));
  return map;
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
 * tooltip(feature, level) returns the hover text.
 */
export function paintNtas(levels, tooltip) {
  for (const layer of ntaByCode.values()) {
    const f = layer.feature;
    let lvl = null;
    for (const id of f.properties.areas) if (levels[id] && (!lvl || RANK[levels[id]] > RANK[lvl])) lvl = levels[id];
    const cls = ['leaflet-interactive', 'nta', f.properties.park ? 'park' : '', lvl ? `rated lvl-${lvl}` : ''].filter(Boolean).join(' ');
    layer.getElement()?.setAttribute('class', cls);
    layer.unbindTooltip();
    const text = tooltip(f, lvl);
    if (text) layer.bindTooltip(text, { sticky: true, direction: 'top', offset: [0, -6] });
  }
}

export function setTheme(theme) {
  basemap?.setUrl(TILE_URL[theme]);
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
}

export function openPopupAt(lat, lon, html) {
  L.popup({ maxWidth: 320 }).setLatLng([lat, lon]).setContent(html).openOn(map);
}

export function flyTo(lat, lon, zoom = 13) {
  map.flyTo([lat, lon], zoom, { duration: 0.6 });
}
