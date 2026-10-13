// Static checks on index.html and the map code: things a reader meets before any
// script runs. Run with:  node --test
// For the same Tab-order check in a real browser: scripts/check-tab-order.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Focusable elements in page order up to the element with `stopId`, skipping hidden subtrees. */
function tabStopsBefore(stopId) {
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const stack = []; // one entry per open element: is it hidden?
  const stops = [];
  for (const m of markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, rawTag, attrs] = m;
    const tag = rawTag.toLowerCase();
    if (closing) {
      stack.pop();
      continue;
    }
    const hidden = /(^|\s)hidden(\s|=|$)/.test(attrs) || stack.at(-1) === true;
    if (new RegExp(`\\bid="${stopId}"`).test(attrs)) return stops;
    const tabindex = attrs.match(/tabindex="(-?\d+)"/);
    const focusable =
      (tag === 'a' && /\bhref=/.test(attrs)) ||
      ['button', 'select', 'textarea', 'summary'].includes(tag) ||
      (tag === 'input' && !/type="hidden"/.test(attrs)) ||
      (tabindex && +tabindex[1] >= 0);
    if (focusable && !hidden && !(tabindex && +tabindex[1] < 0)) stops.push(`${tag}${(attrs.match(/\bid="([^"]+)"/) || [])[1] ? '#' + attrs.match(/\bid="([^"]+)"/)[1] : ''}`);
    if (!VOID.has(tag)) stack.push(hidden);
  }
  throw new Error(`#${stopId} not found`);
}

test('the address search is reachable in under 20 Tab presses', () => {
  const stops = tabStopsBefore('address-input');
  // +3 for links the page adds before it at run time ("Also right now: …" names up to three other hazards)
  assert.ok(stops.length + 3 + 1 < 20, `${stops.length} tab stops before the address input: ${stops.join(', ')}`);
  assert.equal(stops[0], 'a', 'the skip link comes first');
  assert.match(html, /<a class="skip" href="#check">/);
});

test('map shapes are not Tab stops', async () => {
  const map = await readFile(new URL('../js/map.js', import.meta.url), 'utf8');
  // Leaflet makes a shape with a tooltip focusable, so the tabindex reset must come after bindTooltip
  const bind = map.indexOf('layer.bindTooltip(');
  const reset = map.indexOf(`layer.getElement()?.setAttribute('tabindex', '-1')`);
  assert.ok(bind > 0 && reset > bind);
});

test('Floods is the default view', async () => {
  assert.match(html, /<body data-hazard="floods">/);
  assert.match(html, /<a href="#floods" data-hazard="floods" aria-current="page">Floods<\/a>/);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /const state = \{\n  hazard: 'floods',/);
});

test('the footer links to this repository', () => {
  assert.match(html, /href="https:\/\/github\.com\/safthelegend\/DrainWatch"/);
  assert.doesNotMatch(html, /sonamt17/);
});

test('the page asks for data/heat-drivers.json only when the file ships', async () => {
  const { HEAT_DRIVERS_URL } = await import('../js/config.js');
  const { access } = await import('node:fs/promises');
  const exists = await access(new URL('../data/heat-drivers.json', import.meta.url)).then(
    () => true,
    () => false,
  );
  if (HEAT_DRIVERS_URL) assert.ok(exists, `HEAT_DRIVERS_URL is set but ${HEAT_DRIVERS_URL} is missing: every page load would 404`);
  else assert.ok(!exists, 'data/heat-drivers.json ships but HEAT_DRIVERS_URL is null, so the page ignores it');
});
