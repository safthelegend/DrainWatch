// Everything Leaflet: basemap, borough outlines, neighborhood pins, 311 reports,
// tide gauges, FEMA flood zones and the "you are here" pin. app.js decides what
// to show; this module only knows how to draw it.

import { AREAS, NYC_CENTER, TIDE_STATIONS } from './config.js';
import { FEMA_FLOOD_ZONE_LAYER, FEMA_NFHL } from './data.js';

const TILE_URL = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};

const BOROUGH_LABELS = [
  ['Manhattan', 40.792, -73.968],
  ['Brooklyn', 40.648, -73.948],
  ['Queens', 40.708, -73.805],
  ['Bronx', 40.852, -73.872],
  ['Staten Island', 40.585, -74.148],
];

let map;
let basemap;
let femaLayer;
const layers = {};

export function createMap(el, { onClick, theme }) {
  map = L.map(el, { zoomControl: false, scrollWheelZoom: false, minZoom: 9, maxZoom: 18 }).setView(NYC_CENTER, 11);
  fitCity();
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  basemap = L.tileLayer(TILE_URL[theme], {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  // If tiles can't load (offline, blocked network), the borough shapes stay
  // filled in so the map still reads as New York City.
  basemap.once('tileload', () => el.classList.add('tiles-ok'));
  basemap.on('tileerror', () => {});

  map.createPane('boroughs');
  map.getPane('boroughs').style.zIndex = 250;
  layers.boroughs = L.layerGroup().addTo(map);
  loadBoroughs();

  femaLayer = makeFemaLayer();
  layers.areas = L.layerGroup().addTo(map);
  layers.reports = L.layerGroup().addTo(map);
  layers.stations = L.layerGroup().addTo(map);
  layers.point = L.layerGroup().addTo(map);

  L.control
    .layers(
      null,
      {
        'Neighborhood risk': layers.areas,
        '311 flooding reports (7 days)': layers.reports,
        'Tide gauges': layers.stations,
        'FEMA flood zones (zoom in)': femaLayer,
      },
      { position: 'topright' },
    )
    .addTo(map);

  // Scroll-wheel zoom only after the reader engages with the map, so scrolling
  // the page past it never hijacks the wheel.
  const hint = document.getElementById('map-hint');
  const engage = () => {
    map.scrollWheelZoom.enable();
    hint?.classList.add('gone');
  };
  map.on('click focus', engage);
  map.on('mouseout', () => map.scrollWheelZoom.disable());
  map.on('click', (e) => onClick(e.latlng.lat, e.latlng.lng));
  return map;
}

/** Frame all tracked neighborhoods, leaving room for the search box. */
export function fitCity() {
  const bounds = L.latLngBounds(AREAS.map((a) => [a.lat, a.lon]));
  map.fitBounds(bounds, { paddingTopLeft: [24, 76], paddingBottomRight: [24, 24], maxZoom: 12 });
}

export function setMapTheme(theme) {
  if (basemap) basemap.setUrl(TILE_URL[theme]);
}

export function invalidate() {
  if (map) map.invalidateSize();
}

async function loadBoroughs() {
  try {
    const res = await fetch('data/nyc-boroughs.geojson');
    if (!res.ok) return;
    const geo = await res.json();
    L.geoJSON(geo, { pane: 'boroughs', interactive: false, className: 'borough', style: () => ({ className: 'borough' }) }).addTo(layers.boroughs);
    for (const [name, lat, lon] of BOROUGH_LABELS) {
      L.marker([lat, lon], {
        pane: 'boroughs',
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: 'borough-label', html: name, iconSize: [140, 16], iconAnchor: [70, 8] }),
      }).addTo(layers.boroughs);
    }
  } catch {
    // Outlines are decoration; the map works without them.
  }
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
  return new FemaLayer('', { opacity: 0.55, minZoom: 12, attribution: 'Flood zones: <a href="https://msc.fema.gov/">FEMA NFHL</a>' });
}

/**
 * Neighborhood pins. Size grows with the score; the few worst pins ripple.
 * items: [{ id, lat, lon, level, score, pulse, tooltip, tooltipHtml, popup }]
 */
export function drawAreas(items) {
  layers.areas.clearLayers();
  const markers = {};
  for (const it of items) {
    const size = Math.round(16 + (it.score ?? 0) * 4);
    const marker = L.marker([it.lat, it.lon], {
      icon: L.divIcon({
        className: 'pin-wrap',
        html: `<span class="pin lvl-${it.level}${it.pulse ? ' pulse' : ''}" style="--size:${size}px"></span>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      }),
      keyboard: true,
      title: it.tooltip,
      alt: it.tooltip,
      riseOnHover: true,
      zIndexOffset: Math.round((it.score ?? 0) * 100),
    })
      .bindTooltip(it.tooltipHtml, { direction: 'top', offset: [0, -size / 2] })
      .bindPopup(it.popup, { maxWidth: 320 });
    markers[it.id] = marker;
    layers.areas.addLayer(marker);
  }
  return markers;
}

export function drawReports(reports, popupFor) {
  layers.reports.clearLayers();
  for (const rep of reports || []) {
    L.circleMarker([rep.lat, rep.lon], { radius: 3.5, className: 'report-marker', weight: 1, fillOpacity: 0.85, bubblingMouseEvents: false })
      .bindPopup(popupFor(rep))
      .addTo(layers.reports);
  }
}

export function drawStations(tides, popupFor) {
  layers.stations.clearLayers();
  for (const [key, s] of Object.entries(TIDE_STATIONS)) {
    L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: 'station-icon', html: '<span><svg class="icon" aria-hidden="true"><use href="#i-wave" /></svg></span>', iconSize: [26, 26] }),
      title: `${s.name} tide gauge`,
      alt: `${s.name} tide gauge`,
    })
      .bindPopup(popupFor(key, s, tides ? tides[key] : null))
      .addTo(layers.stations);
  }
}

/** Show or hide the map layers that only make sense for floods. */
export function setFloodLayers(on) {
  for (const layer of [layers.reports, layers.stations]) {
    if (on && !map.hasLayer(layer)) map.addLayer(layer);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  }
  if (!on && map.hasLayer(femaLayer)) map.removeLayer(femaLayer);
}

let pointMarker = null;

export function showPoint(lat, lon, popupHtml) {
  layers.point.clearLayers();
  const m = L.marker([lat, lon], {
    icon: L.divIcon({ className: 'here-icon', html: '<span><svg class="icon" aria-hidden="true"><use href="#i-pin" /></svg></span>', iconSize: [34, 34], iconAnchor: [17, 40] }),
    zIndexOffset: 2000,
    title: 'Checked location',
    alt: 'Checked location',
  }).addTo(layers.point);
  if (popupHtml) m.bindPopup(popupHtml, { maxWidth: 320, offset: [0, -30] });
  map.flyTo([lat, lon], Math.max(map.getZoom(), 14), { duration: 0.8 });
  pointMarker = m;
  return m;
}

export function showPointPopup(html) {
  if (pointMarker) pointMarker.bindPopup(html, { maxWidth: 320, offset: [0, -30] });
}

export function clearPoint() {
  layers.point.clearLayers();
  pointMarker = null;
}

export function flyTo(lat, lon, zoom = 14) {
  map.flyTo([lat, lon], zoom, { duration: 0.8 });
}
