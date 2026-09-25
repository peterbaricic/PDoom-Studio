// vite.config.ts: the studio SPA's build. `bun run build` (or a stale `bun run studio`) emits studio/web/dist, which
// studio/app.js serves on the UI hosts. `bun run dev` runs this dev server on 5173 alongside `bun studio/server.js
// --dev`, proxying everything the app talks to the studio server so the two ever look like one origin to fetch/EventSource.
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const data = process.env.STUDIO_DATA ? resolve(process.env.STUDIO_DATA) : root;
const backend = process.env.STUDIO_DEV_BACKEND || 'http://localhost:8080';

// Dev mode only: studio/server.js --dev writes the per-start token to <data>/.studio/dev-token (mode 600) so this
// separate process can learn it without an HTTP round trip. The production build leaves %%TOKEN%% untouched —
// studio/app.js does that substitution when it serves the built index.html.
function devTokenPlugin(): Plugin {
  return {
    name: 'studio-dev-token',
    apply: 'serve',
    transformIndexHtml(html) {
      let token = '';
      try { token = readFileSync(resolve(data, '.studio/dev-token'), 'utf8').trim(); }
      catch { /* server not started with --dev yet, or hasn't written the file: leave the placeholder */ }
      return token ? html.replace('%%TOKEN%%', token) : html;
    },
  };
}

// The SPA CSP's style-src 'self' blocks every <style> tag a script creates at runtime. Two dependencies make them:
//
// - sonner (the toasts) injects its whole stylesheet at import time. The same CSS ships as sonner/dist/styles.css,
//   which components/ui/sonner.tsx imports into the bundle; this plugin turns the injector into a no-op. It fails the
//   build if sonner's bundle ever stops defining the injector it expects, rather than silently shipping a violation.
// - react-remove-scroll (Radix's scroll lock for modal layers) injects one whenever a dialog or sheet opens; the
//   alias below swaps it for src/lib/remove-scroll.tsx, which locks scroll through the CSSOM instead.
//
// test/app.test.js proves the result in a real browser: the built app, with a toast and a sheet on screen, reports
// no CSP violations. (The dev server serves no CSP, and its pre-bundled dependencies skip both, harmlessly.)
function sonnerWithoutInjectedCss(): Plugin {
  const injector = 'function __insertCSS(code) {';
  return {
    name: 'studio-sonner-without-injected-css',
    transform(code, id) {
      if (!/[\\/]node_modules[\\/]sonner[\\/]dist[\\/]index\.m?js$/.test(id)) return null;
      if (!code.includes(injector)) this.error(`${id} no longer defines __insertCSS: check how this sonner injects its CSS`);
      return { code: code.replace(injector, `${injector} return;`), map: null };
    },
  };
}

const webRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));

export default defineConfig({
  root: webRoot,
  plugins: [react(), tailwindcss(), devTokenPlugin(), sonnerWithoutInjectedCss()],
  resolve: { alias: [{ find: /^react-remove-scroll$/, replacement: resolve(webRoot, 'src/lib/remove-scroll.tsx') }] },
  // assetsDir is 'app-assets', not the default 'assets': studio/app.js serves the repo's own /assets/ (the song,
  // the bundled fonts — PUBLIC) at that path already, and hashed build output needs a namespace that can't collide
  // with it.
  build: { outDir: 'dist', assetsDir: 'app-assets', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // changeOrigin rewrites the Host header to the backend's (so its host guard passes); it leaves Origin as the
      // browser's own (http://localhost:5173), which studio/http.js's guard accepts only in --dev mode.
      '/api': { target: backend, changeOrigin: true },
      '/library': { target: backend, changeOrigin: true },
      '/thumbs': { target: backend, changeOrigin: true },
      '/assets': { target: backend, changeOrigin: true },
    },
  },
});
