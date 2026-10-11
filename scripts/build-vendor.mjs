// Rebuilds vendor/three/three.min.js: a minified, tree-shaken Three.js with just
// the classes the 3D stage imports. The site itself has no build step; this
// only runs when upgrading Three.js or using a new class in js/story/stage.js.
//
//   npm install --no-save esbuild@0.25.10 three@0.186.1
//   node scripts/build-vendor.mjs

import { build } from 'esbuild';

await build({
  entryPoints: [new URL('./three-entry.js', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  minify: true,
  legalComments: 'inline',
  outfile: new URL('../vendor/three/three.min.js', import.meta.url).pathname,
});
console.log('wrote vendor/three/three.min.js');
