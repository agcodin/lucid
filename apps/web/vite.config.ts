import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  // Harper's WASM is ~20MB and is referenced with `new URL(..., import.meta.url)`.
  // Leaving it unoptimized keeps Vite from trying to pre-bundle it on every boot.
  optimizeDeps: { exclude: ['harper.js'] },
  build: { target: 'es2022' },
  server: { port: 5181 },
});
