import { build, context } from 'esbuild';
import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// harper.js exports only the `import` condition, so CJS `require.resolve`
// cannot see it. Resolve through the ESM resolver instead.
const harperDist = path.dirname(fileURLToPath(import.meta.resolve('harper.js/binary')));
const out = 'dist';
const watch = process.argv.includes('--watch');

/**
 * harper.js carries a Node branch that imports `fs` for loading the WASM from
 * disk. In a browser that path is never taken, so the imports are stubbed out
 * rather than bundled.
 */
const stubNodeBuiltins = {
  name: 'stub-node-builtins',
  setup(build) {
    const builtins = /^(fs|path|url|module|crypto|os|node:.*)$/;
    build.onResolve({ filter: builtins }, (args) => ({ path: args.path, namespace: 'node-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({ contents: 'export default {};', loader: 'js' }));
  },
};

const common = {
  bundle: true, target: 'es2022', logLevel: 'info',
  sourcemap: watch ? 'inline' : false, minify: !watch,
  plugins: [stubNodeBuiltins],
};

const builds = [
  // Content scripts cannot be ES modules, so this one is an IIFE.
  { ...common, entryPoints: ['src/content.ts'], outfile: `${out}/content.js`, format: 'iife' },
  { ...common, entryPoints: ['src/background.ts'], outfile: `${out}/background.js`, format: 'esm' },
  { ...common, entryPoints: ['src/offscreen.ts'], outfile: `${out}/offscreen.js`, format: 'esm' },
  // `import.meta.url` must survive so the worker resolves the .wasm beside itself
  // at chrome-extension://<id>/harper_wasm_bg.wasm.
  {
    ...common,
    entryPoints: [path.resolve('../../packages/engine/src/worker/harper.worker.ts')],
    outfile: `${out}/harper.worker.js`,
    format: 'esm',
  },
];

await mkdir(out, { recursive: true });

if (watch) {
  for (const options of builds) (await context(options)).watch();
} else {
  for (const options of builds) await build(options);
}

await cp('manifest.json', `${out}/manifest.json`);
await cp('src/content.css', `${out}/content.css`);
await cp('src/offscreen.html', `${out}/offscreen.html`);
// Harper's WASM, copied once. The browser caches it after the first load, and
// a single offscreen document is the only thing that instantiates it.
for (const file of await readdir(harperDist)) {
  if (file === 'harper_wasm_bg.wasm') await cp(`${harperDist}/${file}`, `${out}/${file}`);
}
console.log(`\nbuilt -> ${path.resolve(out)}`);
