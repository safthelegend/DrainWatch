// Renders the fallback images (assets/stills/*.jpg) shown instead of the live 3D
// scene on devices without WebGL or with data saver on. It drives the real
// page in headless Chromium, one image per story step, light and dark.
//
//   python3 -m http.server 8000            (in another terminal)
//   npm install --no-save playwright
//   node scripts/render-stills.mjs http://localhost:8000 [hazard ...]
//
// Env: PLAYWRIGHT_MODULE (path to playwright's index.mjs), CHROMIUM_PATH.

import { mkdir } from 'node:fs/promises';
import { STORIES, buildStory } from '../js/story/stories.js';

const base = process.argv[2] || 'http://localhost:8000';
const only = process.argv.slice(3);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = new URL('../assets/stills/', import.meta.url);
await mkdir(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

/** Scroll targets for each shot, as [section id, progress through it]. */
function shots(story) {
  const list = [['hero', 'top', 0]];
  const last = story.time.length - 1;
  story.beats.forEach((b, i) => {
    let p;
    if (story.hazard === 'floods') p = b.slr ? 1 : (b.index / story.peak.index) * 0.78;
    else p = (b.index + 0.4) / last;
    list.push([`beat-${i}`, 'timeline', Math.min(1, p)]);
  });
  story.stops.forEach((_, i) => list.push([`stop-${i}`, 'exposed', (i + 0.85) / story.stops.length]));
  return list;
}

for (const theme of ['light', 'dark']) {
  for (const hazard of Object.keys(STORIES)) {
    if (only.length && !only.includes(hazard)) continue;
    const story = buildStory(hazard);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(`${base}/?3d#${hazard}`);
    await page.waitForFunction(() => document.body.classList.contains('has-stage'), null, { timeout: 30000 });
    await page.addStyleTag({ content: 'main, .masthead, .leader, .footer { visibility: hidden !important; }' });
    for (const [name, section, p] of shots(story)) {
      await page.evaluate(
        ([section, p]) => {
          const el = document.getElementById(section);
          const top = el.getBoundingClientRect().top + window.scrollY;
          window.scrollTo(0, top + Math.max(0, el.offsetHeight - window.innerHeight) * p);
        },
        [section, p],
      );
      await page.waitForTimeout(1500);
      const file = new URL(`${hazard}-${theme}-${name}.jpg`, out);
      await page.locator('#stage').screenshot({ path: file.pathname, type: 'jpeg', quality: 68 });
      console.log('wrote', file.pathname.split('/').slice(-2).join('/'));
    }
    await ctx.close();
  }
}
await browser.close();
