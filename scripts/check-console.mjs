// Loads the page in headless Chromium with every outside service answering like the
// real one (tides, forecasts, air quality, alerts, 311, map tiles, fonts), then
// fails on any console error or warning, page error or failed request. Covers a
// normal page load, one address check and opening the 3D story.
//
//   python3 -m http.server 8000            (in another terminal)
//   npm install --no-save playwright
//   node scripts/check-console.mjs http://localhost:8000
//
// Env: PLAYWRIGHT_MODULE (path to playwright's index.mjs), CHROMIUM_PATH.

const base = process.argv[2] || 'http://localhost:8000';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

// ---------------- fake but well-formed answers ----------------

/** Hours in New York local time, as the APIs return them. */
function nyHours(fromHoursAgo, count, sep = 'T') {
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.now() + (i - fromHoursAgo) * 3600e3);
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
        .formatToParts(d)
        .map((x) => [x.type, x.value]),
    );
    out.push(`${p.year}-${p.month}-${p.day}${sep}${p.hour}:00`);
  }
  return out;
}
const count = (url, key) => new URL(url).searchParams.get(key).split(',').length;
const repeat = (n, make) => (n === 1 ? make() : Array.from({ length: n }, make));

function weather(url) {
  const time = nyHours(24, 96);
  return repeat(count(url, 'latitude'), () => ({
    hourly: {
      time,
      precipitation: time.map((_, i) => (i % 17 === 0 ? 0.12 : 0)),
      temperature_2m: time.map((_, i) => 62 + 8 * Math.sin(i / 4)),
      relative_humidity_2m: time.map(() => 60),
      wind_speed_10m: time.map(() => 9),
      wind_gusts_10m: time.map((_, i) => 18 + (i % 5)),
      weather_code: time.map(() => 3),
    },
  }));
}
function air(url) {
  const time = nyHours(0, 72);
  return repeat(count(url, 'latitude'), () => ({
    hourly: { time, pm2_5: time.map(() => 8), ozone: time.map(() => 40), us_aqi: time.map(() => 35), us_aqi_pm2_5: time.map(() => 33), us_aqi_ozone: time.map(() => 35) },
  }));
}
function tides(url) {
  if (url.includes('product=water_level')) return { data: [{ t: nyHours(0, 1, ' ')[0], v: '0.80' }] };
  return { predictions: nyHours(1, 50, ' ').map((t, i) => ({ t, v: (2.4 * Math.cos(i / 2)).toFixed(3) })) };
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==', 'base64');

async function answer(route) {
  const url = route.request().url();
  const json = (body) => route.fulfill({ json: body });
  if (/tile\.openstreetmap|tile\.openstreetmap\.fr|hazards\.fema\.gov\/.*export/.test(url)) return route.fulfill({ body: PNG, contentType: 'image/png' });
  if (/fonts\.googleapis\.com/.test(url)) return route.fulfill({ body: '', contentType: 'text/css' });
  if (/api\.tidesandcurrents\.noaa\.gov/.test(url)) return json(tides(url));
  if (/api\.open-meteo\.com/.test(url)) return json(weather(url));
  if (/air-quality-api\.open-meteo\.com/.test(url)) return json(air(url));
  if (/api\.weather\.gov\/alerts/.test(url)) return json({ features: [] });
  if (/erm2-nwe9\.json/.test(url)) return json(url.includes('count') ? [{ n: '11' }] : []);
  if (/epne-qv9x\.json/.test(url)) return json([{ hurricane_: '1' }]);
  if (/hazards\.fema\.gov\/.*query/.test(url)) return json({ features: [{ attributes: { FLD_ZONE: 'AE', ZONE_SUBTY: null, STATIC_BFE: 11 } }] });
  if (/geosearch\.planninglabs\.nyc\/v2\/search/.test(url))
    return json({ features: [{ properties: { label: '160 Van Brunt Street, Brooklyn, NY, USA', borough: 'Brooklyn' }, geometry: { coordinates: [-74.0122, 40.6802] } }] });
  console.log('unmocked request:', url);
  return route.abort();
}

// ---------------- run ----------------

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let problems = 0;
for (const theme of ['light', 'dark']) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme })).newPage();
  const seen = [];
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && seen.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => seen.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => seen.push(`request failed: ${r.url()}`));
  page.on('response', (r) => r.status() >= 400 && seen.push(`${r.status()}: ${r.url()}`));
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, answer);
  await page.goto(base);
  await page.waitForTimeout(3000);
  await page.fill('#address-input', '160 Van Brunt St');
  await page.press('#address-input', 'Enter');
  await page.waitForTimeout(2500);
  await page.click('#story-open');
  await page.waitForTimeout(4000);
  await page.keyboard.press('Escape');
  problems += seen.length;
  console.log(`${seen.length ? 'FAIL' : 'ok  '} ${theme}: ${seen.length} console errors, warnings or failed requests`);
  for (const s of seen) console.log('     ', s.slice(0, 200));
}
await browser.close();
process.exit(problems ? 1 : 0);
