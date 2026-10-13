// Counts the Tab presses from the top of the page to the address search in a real
// browser, at desktop and phone widths, and fails if it takes 20 or more.
// External requests are blocked, so the page runs in its offline state.
//
//   python3 -m http.server 8000            (in another terminal)
//   npm install --no-save playwright
//   node scripts/check-tab-order.mjs http://localhost:8000
//
// Env: PLAYWRIGHT_MODULE (path to playwright's index.mjs), CHROMIUM_PATH.

const base = process.argv[2] || 'http://localhost:8000';
const LIMIT = 20;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let failed = false;
for (const width of [1440, 800, 375]) {
  const page = await (await browser.newContext({ viewport: { width, height: 900 } })).newPage();
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
  await page.goto(base);
  await page.waitForTimeout(2000); // the map draws its neighborhoods
  let presses = 0;
  let id = '';
  while (presses < 300 && id !== 'address-input') {
    await page.keyboard.press('Tab');
    presses++;
    id = await page.evaluate(() => document.activeElement.id);
  }
  const ok = id === 'address-input' && presses < LIMIT;
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${width}px: ${id === 'address-input' ? `${presses} Tab presses` : 'never reached'} to the address search`);
}
await browser.close();
process.exit(failed ? 1 : 0);
