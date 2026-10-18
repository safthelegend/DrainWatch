# DrainWatch

**How climate risk hits New York City, block by block, and what it looks like at your address right now.**

DrainWatch is a one-screen dashboard: a live risk map of the city beside a column of cards. Type any address and get
its flood, heat, air quality and wind risk for the next 48 hours, its hurricane evacuation zone and the nearest higher
ground. Compare any two neighborhoods side by side, replay Hurricane Sandy on top of 2080s sea levels, or open the 3D
story of four real New York disasters: the July 2019 heat wave, Hurricane Sandy, the 2023 wildfire smoke and Tropical
Storm Isaias. All from free public data, with no API keys.

![The heat wave story: 106°F, with the 3D city on the right](docs/screenshots/heat-hero.jpg)

## Why it exists

Climate change is already here, but it does not hit every block the same way. Ida's record rain drowned people in
basement apartments in inland Queens. Sandy's surge flooded the Rockaways and Lower Manhattan. Heat kills more New
Yorkers than any other weather, mostly in neighborhoods with fewer trees and less air conditioning. The data to see
this is public, but it is scattered across a dozen agencies and written for experts. DrainWatch puts it in one place,
in plain English, for the block you live on.

## What's on the page

The map stays in view (sticky) on the left; everything else is a card on the right, so nothing is more than a short
scroll or one tab away. On phones the map sits on top and the cards follow.

1. **Right now.** The one number that matters for the chosen hazard (or replay), the risk level in plain words, and
   anything else that is High or Severe today. A teaser opens the 3D story.
2. **Check an address.** A report card for all four hazards, plus a **safety quick-finder**: the official hurricane
   evacuation zone, how high the ground is compared with Sandy's storm tide, the nearest higher ground (with a route
   drawn on the map and a walking link), and the city resources that fit the hazard.
3. **Climate Time Machine.** Pick live data or a replay, then drag sea level rise from today to the NPCC high-end
   estimate for 2100. The map redraws as you drag: land under water at the storm's peak in slate, land that only the
   extra rise floods in orange, and neighborhoods hit harder outlined in orange. A card lists what changed. One button
   loads **Sandy + 2080s seas** (+29 in).
4. **Tabs:** the ranked **Neighborhoods** table, **Forecast & alerts** (NWS alerts and 48-hour charts), and the
   **Be ready** checklist (also one click from the masthead).
5. **Compare** (masthead): any two of the 39 rated neighborhoods side by side: risk for every hazard, heat
   vulnerability, asthma burden, exposure, typical elevation and how much of each sits below Sandy's storm tide.
6. **3D story** (masthead or the teaser): a full-screen player, not scroll-jacking. Play it, drag the scrubber, or step
   with the arrow keys. The timeline moves hour by hour through the event (in the flood story the harbor rises over
   USGS elevation to the level NOAA measured, then by the 2080s rise); "Who's exposed" visits the hardest-hit
   neighborhoods.

| Hazard | Story | 3D shows |
| --- | --- | --- |
| Heat | July 2019 heat wave, 72 hours | Heat index per neighborhood, sun and sky for each hour |
| Floods | Hurricane Sandy, October 29, 2012 | The harbor rising over real terrain; flooded land shaded by depth |
| Air quality | Canadian wildfire smoke, June 7, 2023 | AQI per neighborhood; haze thickens with the smoke |
| Wind & storms | Tropical Storm Isaias, August 4, 2020 | Peak gusts per neighborhood |

<p>
  <img src="docs/screenshots/heat-night.jpg" alt="At 5 a.m. the sky is dark but the city still glows red" width="49%" />
  <img src="docs/screenshots/sandy-dark.jpg" alt="Sandy's storm tide over real elevation, dark mode" width="49%" />
</p>
<p>
  <img src="docs/screenshots/exposed.jpg" alt="Who's exposed: East Harlem, anchored annotation" width="49%" />
  <img src="docs/screenshots/app.jpg" alt="The app: risk by neighborhood, address check and map" width="49%" />
</p>

## Run it

Plain **HTML, CSS and JavaScript**: no build step, no framework, no API keys. You need Python 3.

```bash
cd DrainWatch
python3 -m http.server 8000
```

Open <http://localhost:8000>. Useful links: `#floods`, `#air/smoke-2023`, `#floods/sandy/2080s`, `#floods/live/40in`.
Add `?stills` to see the story's no-WebGL fallback.

> Why a server? The JavaScript uses ES modules, which browsers block for files opened straight from disk.

## Tests

```bash
node --test
```

85 tests cover the four risk models (against the NWS heat index chart, the EPA AQI breakpoints, and NWS wind and
flood criteria), every replay, sea level rise, the elevation helpers (higher ground, flooded land), the buildings file format and mesh, the story's camera
paths, beats and 3D values, the sun's position, the data layer (with a fake `fetch`), that the 3D colors match the CSS
and the risk ramps stay quiet at Low, and that the address search is under 20 Tab presses from the top. GitHub Actions
runs them on every push.

Two browser checks (optional, they need Playwright like `scripts/render-stills.mjs`):

```bash
node scripts/check-tab-order.mjs http://localhost:8000   # Tab presses to the address search, desktop and phone
node scripts/check-console.mjs http://localhost:8000     # zero console errors, with every outside service mocked
```

## How it's built

- **No build step.** ES modules and an import map. Three.js (a tree-shaken 587 KB bundle) and Leaflet are vendored in
  `vendor/`.
- **A keyless basemap.** Standard OpenStreetMap tiles, with attribution. Dark mode is a CSS filter on the tile pane
  only, so the theme switch never refetches tiles or touches the risk colors, and no second tile provider (or key) is
  needed. If OpenStreetMap refuses the first tiles, the map falls back once to the Humanitarian OSM style, also keyless.
- **3D from real data, not decoration.** The city is NYC's 195 Neighborhood Tabulation Areas (NYC City Planning, via
  the NYC Health Department), projected with Mercator and extruded. The flood story uses a heightmap baked from
  USGS 3DEP elevation (`data/nyc-elevation.png`). Light follows the real sun position for each replayed hour.
- **Differences you can see.** DrainWatch models 39 neighborhoods, and raw values barely differ across the city, so the
  3D timeline shows differences instead: for heat, how hot it feels times each neighborhood's Heat Vulnerability Index
  factor; for air and wind, how much worse than the citywide average at that hour. Values are blended across all 195
  neighborhoods with inverse-distance weighting, and a legend beside the city says what height and color mean. Risk
  ratings appear only for the 39 rated places.
- **Quiet when it's calm.** Low risk is a near-neutral tint in both themes; color starts at Elevated, and the light and
  dark ramps run the same way (one hue per hazard, louder toward Severe), checked by a test.
- **No scroll-jacking.** The page scrolls normally. The 3D story lives in its own overlay with Play, a scrubber,
  step buttons and arrow keys; the camera eases toward each position.
- **Real buildings, where the water went.** The flood story draws actual buildings from NYC's Building Footprints
  dataset for Lower Manhattan, the Brooklyn waterfront, Long Island City, Coney Island, the Rockaways and Staten
  Island's South Shore. Each wall turns flood blue up to the water's depth at that building, so you can see how
  high Sandy reached. To keep it small, `scripts/bake-buildings.mjs` merges houses into one block per 40 m, drops
  sheds and skybridges, and simplifies the rest into a compact gzipped binary (`js/story/buildings.js` documents the
  format). It loads after the terrain, only in the 3D story, and never on phones; ground is exaggerated 8 times and
  buildings 3 times, so towers don't turn into needles. The repo ships an empty placeholder until the bake is run:
  `node scripts/bake-buildings.mjs` (needs internet access to NYC Open Data; aim for 1–2 MB).
- **One canvas, loaded on demand.** Three.js loads the first time the story opens, never on page load. Pixel ratio is
  capped at 2; bloom is off on phones.
- **Elevation in the browser.** `js/terrain.js` decodes the same USGS heightmap the 3D flood scene uses, for higher
  ground, Compare and the Time Machine's flooded-land layer. Flooding there is a "bathtub" estimate: land below the
  water level counts as flooded whether or not water can reach it.
- **Fallbacks.** Without WebGL, with data saver on, or on low-memory devices, the story shows pre-rendered stills
  (`assets/stills/`). With reduced motion there are no camera flights or drift; each step cross-fades instead.
- **Every fact is text.** The beats, the annotations, the readout and an hour-by-hour table are real HTML.

## The risk model

> **score (0–4) = how bad conditions will get (hazard 0–4) × how exposed the neighborhood is, plus NWS alerts**

| Score | 0–1 | 1–2 | 2–3 | 3–4 |
| --- | --- | --- | --- | --- |
| Level | Low | Elevated | High | Severe |

| Hazard | Hazard from live data | Exposure |
| --- | --- | --- |
| **Floods** ([`js/risk.js`](js/risk.js)) | Peak water level (NOAA tide + current surge) vs. NOAA flood thresholds; peak hourly rain vs. ~1.75 in/hr sewer capacity | Coastal and stormwater exposure from FEMA and NYC DEP maps; address checks use the real FEMA zone and 311 history |
| **Heat** ([`js/heat-risk.js`](js/heat-risk.js)) | Peak NWS heat index, plus warm nights | NYC Heat Vulnerability Index (1–5) |
| **Air** ([`js/air-risk.js`](js/air-risk.js)) | Peak US AQI (EPA categories) | Asthma burden |
| **Wind** ([`js/storm-risk.js`](js/storm-risk.js)) | Peak gust vs. NWS advisory (46 mph), warning (58) and hurricane force (74); thunderstorms | Shoreline and tree exposure |

Neighborhood ratings are simplified summaries of public data, not official designations (see
[`js/config.js`](js/config.js)). The replays are approximate reconstructions from NOAA, NWS and EPA records, run
through today's model ([`js/scenarios.js`](js/scenarios.js)). **DrainWatch is an educational tool, not an official
warning system.** In an emergency follow [Notify NYC](https://www.nyc.gov/notifynyc) and the
[National Weather Service](https://www.weather.gov/okx/).

## Data sources

No API keys needed.

| Source | Used for |
| --- | --- |
| [NOAA Tides & Currents](https://api.tidesandcurrents.noaa.gov/api/prod/) | Water levels, tide predictions |
| [Open-Meteo](https://open-meteo.com/) and its [air quality API](https://open-meteo.com/en/docs/air-quality-api) | Rain, temperature, humidity, wind, AQI |
| [National Weather Service](https://www.weather.gov/documentation/services-web-api) | Active alerts |
| [NYC Open Data: 311](https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9) | Street flooding reports (optional free app token in `js/config.js`) |
| [NYC GeoSearch](https://geosearch.planninglabs.nyc/) | Address lookup |
| [NYC hurricane evacuation zones](https://data.cityofnewyork.us/d/epne-qv9x) (NYC Emergency Management, via NYC Open Data, dataset `epne-qv9x`) | Evacuation zone in the address check |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | Basemap tiles |
| [FEMA National Flood Hazard Layer](https://hazards.fema.gov/femaportal/wps/portal/NFHLWMS) | Flood zones |
| [NYC Health Department geography](https://github.com/nycehs/NYC_geography) (from NYC City Planning) | Neighborhood shapes |
| [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (USGS 3DEP in the US) | Elevation: the flood story, higher ground, Compare, flooded land |
| [NYC Building Footprints](https://data.cityofnewyork.us/d/5zhs-2jue) (NYC Office of Technology and Innovation, via NYC Open Data) | Real buildings and roof heights in the 3D flood story |

## Scripts

All optional; the site runs without them.

| Script | What it does |
| --- | --- |
| `scripts/build-geodata.mjs` | Rebuilds `data/nyc-ntas.geojson` and links each NTA to the rated neighborhoods |
| `scripts/bake-elevation.mjs` | Bakes `data/nyc-elevation.png` from elevation tiles |
| `scripts/bake-buildings.mjs` | Bakes `data/nyc-buildings.dwb`: real building footprints and roof heights for the places the flood story visits (see below) |
| `scripts/import-heat-drivers.mjs` | Adds tree canopy and air conditioning to the heat annotations, from CSVs you download from the [NYC Environment & Health Data Portal](https://a816-dohbesp.nyc.gov/IndicatorPublic/) |
| `scripts/render-stills.mjs` | Renders the story's fallback stills with headless Chromium |
| `scripts/check-tab-order.mjs` | Counts Tab presses from the top of the page to the address search (must be under 20) |
| `scripts/check-console.mjs` | Loads the page with every outside service mocked and fails on any console error |
| `scripts/build-vendor.mjs` | Rebuilds the tree-shaken Three.js bundle |

## Accessibility

- Every risk level is a word as well as a color, and the color ramps were checked for color-vision deficiency.
- The 3D canvas is decorative (`aria-hidden`); everything it shows is in the text, including an hour-by-hour table.
- Reduced motion: no camera flights, drift or autoplay; each story step cross-fades instead. Keyboard: hazard links,
  replay pickers, the sea level slider, the tabs, Compare and the story player (arrows, space, Esc) all work with the
  keyboard; a skip link jumps straight to the address check.
- Light and dark themes, and layouts down to 360 px wide, where the map sits above the cards and the story's text sits below the city.

## Project layout

```
index.html                 page: masthead, map + cards dashboard, how it works, story overlay, compare dialog
css/style.css              tokens (paper, ink, one data ramp per hazard), layout, both themes
js/app.js                  state, live data, routing, dashboard, address checks, Time Machine, Compare, story overlay
js/terrain.js              elevation: higher ground, neighborhood elevation, flooded land (pure + a loader)
js/story/controller.js     story position → camera pose, replay hour and story text; play and step
js/story/stage.js          the Three.js scene (lazy-loaded)
js/story/buildings.js      the buildings file format, footprint simplifying and roof triangulation (pure, tested)
js/story/stories.js        the four stories; every number in the copy comes from data
js/story/camera.js         camera poses and eased paths            ┐
js/story/sun.js            solar position                          │ pure,
js/story/geo.js            projection, point-in-polygon, IDW       │ tested
js/story/palette.js        ramps and sky colors for the 3D scene   ┘
js/risk.js, heat-risk.js, air-risk.js, storm-risk.js   the four risk models
js/hazards.js              runs a model across the city: results, headline, numbers
js/scenarios.js            replays and sea level rise
js/data.js                 public APIs and their pure summarizers
js/map.js, panels.js, charts.js, tide-chart.js, sections.js, content.js, ui.js
data/                      neighborhood shapes and the elevation heightmap
assets/stills/             fallback images for the story
vendor/                    Three.js, Leaflet
scripts/                   data and asset builders
tests/                     node --test suites
```

## Next steps

- Real tree canopy and air conditioning rates per neighborhood (run `scripts/import-heat-drivers.mjs`, then set `HEAT_DRIVERS_URL` in `js/config.js`).
- Building footprints for Manhattan context in 3D.
- NYC's official Stormwater Flood Map polygons, and a small backend that caches API responses and sends opt-in alerts.
- Translations into Spanish, Chinese, Russian, Bengali and other languages New Yorkers speak at home.
