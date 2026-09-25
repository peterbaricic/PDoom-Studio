import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../studio/db.js';
import { serve } from '../studio/serve.js';
import { createEvents } from '../studio/events.js';
import puppeteer from 'puppeteer-core';
import { launchBrowser, findBrowser, browserArgs, gpuArgs, HOST_RESOLVER_RULES } from '../studio/browser.js';
import { tempDir, tempDefaultDb, captureHosts } from './helpers.js';

const root = process.cwd(), data = tempDir(), T = { timeout: 120000 };
let db, srv, browser;
beforeAll(async () => {
  db = openDb(':memory:', { defaultPath: tempDefaultDb() });
  srv = serve({ db, root, data, token: 't', events: createEvents(), port: 0 });
  browser = await launchBrowser({ port: srv.port });
});
// Closing the browser can take a while on a busy machine; never long enough to fail the file over it.
afterAll(async () => {
  await Promise.race([browser?.close(), Bun.sleep(20000)]).catch(() => {});
  browser?.process()?.kill('SIGKILL');
  srv?.stop();
}, 30000);

// Opened on the studio's own origin, as a user would; the server sends studio.html to w0.localhost.
async function open(query, b = browser) {
  const page = await b.newPage(), errors = [], messages = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => messages.push(m.text()));
  await page.goto(`${srv.url}/studio.html?render&${query}`);
  await page.waitForFunction('window.ready === true', { timeout: 60000 });
  return { page, errors, messages };
}

test('loads the original by default on w0.localhost and renders a frame, within its content security policy', async () => {
  const { page, errors, messages } = await open('');
  expect(page.url()).toStartWith(`http://w0.localhost:${srv.port}/studio.html?render`);
  expect(await page.evaluate(() => [CH.length, VERSION.id, ENGINE.wipes])).toEqual([9, 'original', true]);
  expect(await page.evaluate(() => window.renderAt(40, 'image/jpeg', .5).then(u => u.length))).toBeGreaterThan(10000);
  expect(errors).toEqual([]);
  expect(messages.filter(m => /Content.Security.Policy/i.test(m))).toEqual([]);
  // The policy holds: version code can't reach any other server.
  expect(await page.evaluate(() => fetch('https://example.com/').then(() => 'fetched', () => 'blocked'))).toBe('blocked');
  await page.close();
}, T);

test('the bundled fonts load, and studio.html makes no request to any non-loopback host', async () => {
  const page = await browser.newPage(), requests = [];
  page.on('request', r => requests.push(r.url()));
  await page.goto(`${srv.url}/studio.html?render`);
  await page.waitForFunction('window.ready === true', { timeout: 60000 });
  expect(await page.evaluate(() => window.loadError || null)).toBeNull();
  expect(await page.evaluate(() => [document.fonts.check('100px "Permanent Marker"'), document.fonts.check('800 50px "Shantell Sans"')])).toEqual([true, true]);
  const hosts = requests.map(u => new URL(u).hostname);
  expect(hosts.every(h => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost'))).toBe(true);
  await page.close();
}, T);

test('the launched browser goes direct only to the studio port; everything else hits a dead proxy', async () => {
  const cap = await captureHosts(['other-port']), otherPort = cap.port('other-port');
  const probe = await browser.newPage();
  await probe.goto(`${srv.url}/api/health`);   // any page on the studio's own origin
  const failures = [];
  probe.on('requestfailed', r => failures.push(`${new URL(r.url()).host} ${r.failure()?.errorText}`));
  const tryFetch = url => probe.evaluate(u => fetch(u, { mode: 'no-cors' }).then(() => 'ok', () => 'failed'), url);
  const host = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.example`;
  // Loopback on any port but the studio's is as out of reach as the rest of the world: Chrome would otherwise send
  // all of loopback direct, whatever the port.
  for (const url of [`https://${host}/`, `http://127.0.0.1:${otherPort}/`, `http://localhost:${otherPort}/`, `http://w1.localhost:${otherPort}/`, `http://[::1]:${otherPort}/`]) {
    expect(await tryFetch(url)).toBe('failed');
  }
  expect(failures.sort()).toEqual([`${host} net::ERR_PROXY_CONNECTION_FAILED`, `127.0.0.1:${otherPort} net::ERR_PROXY_CONNECTION_FAILED`,
    `[::1]:${otherPort} net::ERR_PROXY_CONNECTION_FAILED`, `localhost:${otherPort} net::ERR_PROXY_CONNECTION_FAILED`,
    `w1.localhost:${otherPort} net::ERR_PROXY_CONNECTION_FAILED`].sort());
  for (const h of ['localhost', 'w0.localhost', 'w7.localhost', '127.0.0.1', '[::1]']) expect(await tryFetch(`http://${h}:${srv.port}/src/core.js`)).toBe('ok');
  expect(await tryFetch('https://fonts.googleapis.com/')).toBe('failed');
  expect(await tryFetch('https://fonts.gstatic.com/')).toBe('failed');
  await probe.close();
  cap.stop();
  expect(cap.hits).toEqual({});
}, T);

test('behind the proxy, --host-resolver-rules still refuses to resolve any host outside the allow-list', async () => {
  // The proxy means Chrome never resolves a proxied host itself, so the rules can't be seen at work through the
  // launched browser; they're checked on their own here (and that launchBrowser passes them, below).
  const bare = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ['--host-resolver-rules=' + HOST_RESOLVER_RULES] });
  try {
    const probe = await bare.newPage();
    await probe.goto('about:blank');
    const failures = [];
    probe.on('requestfailed', r => failures.push(r.failure()?.errorText));
    for (const host of [`probe-${Date.now()}-${Math.random().toString(36).slice(2)}.example`, 'fonts.googleapis.com', 'fonts.gstatic.com']) {
      await probe.evaluate(h => fetch(`https://${h}/`, { mode: 'no-cors' }).catch(() => {}), host);
    }
    expect(failures).toEqual(['net::ERR_NAME_NOT_RESOLVED', 'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_NAME_NOT_RESOLVED']);
  } finally {
    await bare.close();
  }
  expect(browser.process().spawnargs).toContain('--host-resolver-rules=' + HOST_RESOLVER_RULES);
}, T);

test('a chapter cannot leak data through dns-prefetch/preconnect, under the same network lockdown that loads the bundled fonts', async () => {
  // Chrome's net-log records every lookup its host resolver makes: the chapter's injected hostname must never reach
  // it (the proxy means none is needed, and the resolver rules would answer NOTFOUND without a real query), while a
  // lookup for the studio's own loopback host does — which shows the log really does record lookups. The same flags
  // as launchBrowser, plus the log.
  const host = `leak-${Date.now()}-${Math.random().toString(36).slice(2)}.example`, netlog = join(tempDir('netlog-'), 'net.json');
  db.createVersion({ id: 'dns-probe' });
  db.writeFiles('dns-probe', [{ path: 'ch/c01.js', content: [
    `const p = document.createElement('link'); p.rel = 'dns-prefetch'; p.href = '//${host}'; document.head.append(p);`,
    `const c = document.createElement('link'); c.rel = 'preconnect'; c.href = 'https://pc-${host}'; document.head.append(c);`,
  ].join('\n') }], { source: 'manual' });
  const logged = await puppeteer.launch({ executablePath: findBrowser(), headless: true,
    args: [...browserArgs({ port: srv.port }), `--log-net-log=${netlog}`, '--net-log-capture-mode=Everything'] });
  try {
    const { page, errors } = await open('v=dns-probe', logged);
    expect(errors).toEqual([]);
    // core.js's setup() checks document.fonts.check() for both families and sets window.loadError on failure, so
    // this proves the bundled fonts loaded through the lockdown and the faces are usable.
    expect(await page.evaluate(() => window.loadError || null)).toBeNull();
    expect(await page.evaluate(() => [document.fonts.check('100px "Permanent Marker"'), document.fonts.check('800 50px "Shantell Sans"')])).toEqual([true, true]);
    await Bun.sleep(500);
  } finally {
    await logged.close();
  }
  const log = JSON.parse(readFileSync(netlog, 'utf8'));
  const types = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]));
  const looked = log.events.filter(e => types[e.type]?.startsWith('HOST_RESOLVER') && e.params).map(e => JSON.stringify(e.params));
  expect(looked.filter(p => p.includes(host))).toEqual([]);
  expect(looked.some(p => p.includes('localhost'))).toBe(true);
}, T);

test('loads a database version with its engine options', async () => {
  db.createVersion({ id: 'mini', options: { wipes: false, cornerMeter: false } });
  db.writeFiles('mini', [
    { path: 'shared.js', content: 'const MINI = { col: PAL.rose };' },
    { path: 'ch/c01.js', content: "chapter('one', 0, 23, [[0, t => paint(rectPts(0, 0, W, H), { wash: MINI.col, ink: null })]]);" },
  ], { source: 'manual' });
  const { page, errors } = await open('v=mini');
  expect(await page.evaluate(() => [CH.length, CH[0].name, ENGINE.wipes, ENGINE.cornerMeter])).toEqual([1, 'one', false, false]);
  await page.evaluate(() => window.renderAt(5));
  expect(errors).toEqual([]);
  await page.close();
}, T);

test('loads a work folder, and reports broken code', async () => {
  db.createVersion({ id: 'broken' });
  const jid = db.addJob({ kind: 'chapter', versionId: 'broken', params: { chapter: 1 } });
  const dir = join(data, '.studio/work', String(jid));
  mkdirSync(join(dir, 'ch'), { recursive: true });
  writeFileSync(join(dir, 'ch/c01.js'), "throw new Error('boom');");
  const { page, errors } = await open(`work=${jid}`);
  expect(errors.join()).toContain('boom');
  await page.close();
}, T);

test('an unknown version sets loadError', async () => {
  const { page } = await open('v=nope');
  expect(await page.evaluate(() => window.loadError)).toContain('no such version');
  await page.close();
}, T);

test('the player renders the requested version in its workers', async () => {
  const page = await browser.newPage();
  await page.goto(`${srv.url}/watch.html?v=mini&workers=1`);
  await page.waitForFunction('workers.length === 1 && workers[0].ready', { timeout: 60000 });
  expect(await page.evaluate(() => workers[0].el.src)).toContain('v=mini');
  await page.close();
}, T);

test("in the user's own browser (no proxy, no request interception), a player worker's chapter still cannot open a popup, navigate, run inline script or use RTCPeerConnection", async () => {
  // watch.html's workers run chapter code in whatever browser the user previews with, where none of launchBrowser's
  // flags or render.mjs's interception apply: only what the server sends (the CSP and its sandbox) and what
  // src/loader.js does before the version's scripts run. So this runs the real player in a browser launched with the
  // GPU flags alone; puppeteer's own defaults even turn Chrome's popup blocker off, so only the sandbox stops popups.
  // Not tried here, because nothing there stops them: <link rel=prerender> (a full GET of any URL), preconnect and
  // dns-prefetch (a DNS lookup, and for preconnect a bare TCP connection), a frame's navigation that frame-src refuses
  // (a bare TCP connection all the same), and RTCPeerConnection taken from a fresh about:blank iframe.
  const names = ['open', 'docopen', 'blank', 'popup-fetch', 'nav', 'nav-realm', 'nav-meta', 'rtc', 'fetch', 'img', 'inline'];
  const cap = await captureHosts(names), E = Object.fromEntries(names.map(n => [n, cap.url(n)]));
  db.createVersion({ id: 'b-escapee' });
  db.writeFiles('b-escapee', [{ path: 'ch/c01.js', content: `
const E = ${JSON.stringify(E)}, attempt = f => { try { f(); } catch {} };
window.CHAPTER_RAN = true;
attempt(() => window.open(E.open + '/open'));
attempt(() => document.open(E.docopen + '/docopen', 'x', ''));
attempt(() => { const a = document.createElement('a'); a.href = E.blank + '/blank'; a.target = '_blank'; document.body.append(a); a.click(); });
attempt(() => { const w = document.open('/watch.html', 'same', ''); setTimeout(() => attempt(() => w.fetch(E['popup-fetch'] + '/w-fetch')), 300); });
attempt(() => fetch(E.fetch + '/fetch').catch(() => {}));
attempt(() => { new Image().src = E.img + '/img'; });
attempt(() => { const s = document.createElement('script'); s.textContent = 'window.INLINE_RAN = true; fetch(' + JSON.stringify(E.inline + '/inline') + ')'; document.head.append(s); });
attempt(() => { window.RTC_TYPE = typeof RTCPeerConnection + '/' + typeof webkitRTCPeerConnection;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'turn:127.0.0.1:${cap.port('rtc')}?transport=tcp', username: 'u', credential: 'p' }] });
  pc.createDataChannel('x'); pc.createOffer().then(o => pc.setLocalDescription(o)); });
// Navigation last, with the guard that stops it disarmed as far as this code can (put back afterwards, since the
// engine itself still needs addEventListener to take the player's frame requests).
const { preventDefault } = Event.prototype, { addEventListener } = EventTarget.prototype;
Event.prototype.preventDefault = () => {};
EventTarget.prototype.addEventListener = () => {};
attempt(() => { location.href = E.nav + '/nav'; });
attempt(() => { document.body.appendChild(document.createElement('iframe')).contentWindow.parent.location.href = E['nav-realm'] + '/nav-realm'; });
Object.assign(Event.prototype, { preventDefault });
Object.assign(EventTarget.prototype, { addEventListener });
attempt(() => { const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=' + E['nav-meta'] + '/nav-meta'; document.head.append(m); });
` }], { source: 'manual' });
  const plain = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: gpuArgs() });
  let rendering, state;
  const popups = [];
  try {
    const page = await plain.newPage();
    plain.on('targetcreated', t => { if (t.type() === 'page') popups.push(t.url()); });
    await page.goto(`${srv.url}/watch.html?v=b-escapee&workers=1`);
    // The worker comes up and goes on rendering frames, its chapter's attempts notwithstanding.
    rendering = await page.waitForFunction('workers.length === 1 && workers[0].ready && done >= 2', { timeout: 60000 }).then(() => true, () => false);
    await Bun.sleep(1500);
    const frame = page.frames().find(f => f.url().startsWith(`http://w0.localhost:${srv.port}/studio.html`));
    state = await frame?.evaluate(() => [window.CHAPTER_RAN === true, window.INLINE_RAN === true, window.RTC_TYPE, location.pathname]).catch(e => e.message);
  } finally {
    await plain.close();
    cap.stop();
  }
  expect(cap.hits).toEqual({});
  expect(rendering).toBe(true);
  expect(state).toEqual([true, false, 'undefined/undefined', '/studio.html']);
  expect(popups).toEqual([]);
}, T);

test('on a renderer host, every page but studio.html is inert: an opaque origin that runs no script and loads nothing', async () => {
  // What a popup or frame of watch.html, an engine script or a version file would be, were chapter code to get one
  // open on its own origin: nothing to reach into and no fetch, Image or Worker of its own to use.
  const cap = await captureHosts(['from-page']);
  const plain = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: gpuArgs() });
  try {
    const page = await plain.newPage();
    for (const path of ['/watch.html', '/src/lyrics.js', '/v/original/ch/c01_lab.js', '/api/versions/original', '/nope']) {
      await page.goto(`http://w0.localhost:${srv.port}${path}`);
      expect([path, await page.evaluate(() => [window.origin, document.querySelectorAll('iframe').length])]).toEqual([path, ['null', 0]]);
      expect([path, await page.evaluate(u => fetch(u).then(() => 'fetched', () => 'blocked'), cap.url('from-page'))]).toEqual([path, 'blocked']);
      await page.evaluate(u => { new Image().src = u; try { new Worker('/src/lyrics.js'); } catch {} }, cap.url('from-page'));
    }
    await Bun.sleep(500);
  } finally {
    await plain.close();
    cap.stop();
  }
  expect(cap.hits).toEqual({});
}, T);
