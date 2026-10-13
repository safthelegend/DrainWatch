// The map's pure helpers. Run with:  node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoomClasses } from '../js/map.js';
import { tideLevelText } from '../js/ui.js';

test('neighborhood fills go pale from zoom 14, flooded-land cells hide past 15', () => {
  assert.deepEqual(zoomClasses(11), { 'zoom-close': false, 'street-zoom': false });
  assert.deepEqual(zoomClasses(13.75), { 'zoom-close': false, 'street-zoom': false });
  assert.deepEqual(zoomClasses(14), { 'zoom-close': true, 'street-zoom': false });
  assert.deepEqual(zoomClasses(16), { 'zoom-close': true, 'street-zoom': true });
});

test('tide gauge readings say what they are measured against', () => {
  assert.equal(tideLevelText(-3.34), '−3.3 ft vs. normal high tide');
  assert.equal(tideLevelText(0.9), '+0.9 ft vs. normal high tide');
  assert.equal(tideLevelText(-0.02), '0.0 ft vs. normal high tide', 'no "−0.0"');
  assert.equal(tideLevelText(1.256, 2), '+1.26 ft vs. normal high tide');
});
