import { expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../studio/db.js';
import { serve } from '../studio/serve.js';
import { createEvents } from '../studio/events.js';
import puppeteer from 'puppeteer-core';
import { launchBrowser, findBrowser, browserArgs, gpuArgs, HOST_RESOLVER_RULES } from '../studio/browser.js';
import { PAINTER_SECRET } from '../studio/frames/page.js';
import { tempDir, tempDefaultDb, captureHosts, slowTest, sharedBrowser, closeBrowser } from './helpers.js';

const root = process.cwd(), data = tempDir(), T = { timeout: 120000 };
// One browser for the file with launchBrowser's flags for srv's port (every test that opens studio.html on srv), and one
// with the GPU flags alone (the tests that stand in for the user's own browser). Each test takes fresh pages of them.
// The --dev server's browser (its own port), the bare resolver-rules one and the net-logging one are launched by the
// one test that needs each.
let db, srv, devSrv;
const main = sharedBrowser(() => launchBrowser({ port: srv.port }));
const plainBrowser = sharedBrowser(() => puppeteer.launch({ executablePath: findBrowser(), headless: true, pipe: true, args: gpuArgs() }));
beforeAll(async () => {
  db = openDb(':memory:', { defaultPath: tempDefaultDb() });
  srv = serve({ db, root, data, token: 't', events: createEvents(), port: 0 });
  // The same studio as with --dev, which alone serves the studio.html scrubber (studio.html without ?render).
  devSrv = serve({ db, root, data, token: 't', events: createEvents(), port: 0, dev: true });
});
// Closing a browser can take a while on a busy machine; never long enough to fail the file over it.
afterAll(async () => {
  await Promise.all([main.close(), plainBrowser.close()]);
  srv?.stop();
  devSrv?.stop();
}, 30000);

// Opened on the studio's own origin, as a user would; the server sends studio.html to w0.localhost.
async function open(query, b) {
  b ??= await main.get();
  const page = await b.newPage(), errors = [], messages = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => messages.push(m.text()));
  await page.goto(`${srv.url}/studio.html?render&painter=${PAINTER_SECRET}&${query}`);
  await page.waitForFunction('window.ready === true', { timeout: 60000 });
  return { page, errors, messages };
}

slowTest('loads the original by default on w0.localhost and renders a frame, within its content security policy', async () => {
  const { page, errors, messages } = await open('');
  expect(page.url()).toStartWith(`http://w0.localhost:${srv.port}/studio.html?render&painter=${PAINTER_SECRET}`);
  expect(await page.evaluate(() => [CH.length, VERSION.id, ENGINE.wipes])).toEqual([9, 'original', true]);
  expect(await page.evaluate(() => window.renderAt(40, 'image/jpeg', .5).then(u => u.length))).toBeGreaterThan(10000);
  expect(errors).toEqual([]);
  expect(messages.filter(m => /Content.Security.Policy/i.test(m))).toEqual([]);
  // The policy holds: version code can't reach any other server.
  expect(await page.evaluate(() => fetch('https://example.com/').then(() => 'fetched', () => 'blocked'))).toBe('blocked');
  await page.close();
}, T);

slowTest('the bundled fonts load, and studio.html makes no request to any non-loopback host', async () => {
  const page = await (await main.get()).newPage(), requests = [];
  page.on('request', r => requests.push(r.url()));
  await page.goto(`${srv.url}/studio.html?render&painter=${PAINTER_SECRET}`);
  await page.waitForFunction('window.ready === true', { timeout: 60000 });
  expect(await page.evaluate(() => window.loadError || null)).toBeNull();
  expect(await page.evaluate(() => [document.fonts.check('100px "Permanent Marker"'), document.fonts.check('800 50px "Shantell Sans"')])).toEqual([true, true]);
  const hosts = requests.map(u => new URL(u).hostname);
  expect(hosts.every(h => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost'))).toBe(true);
  await page.close();
}, T);

slowTest('the launched browser goes direct only to the studio port; everything else hits a dead proxy', async () => {
  const cap = await captureHosts(['other-port']), otherPort = cap.port('other-port');
  const probe = await (await main.get()).newPage();
  await probe.goto(`${srv.url}/api/song`);   // any page on the studio's own origin (not /api/health: that asks the Claude CLI)
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

slowTest('behind the proxy, --host-resolver-rules still refuses to resolve any host outside the allow-list', async () => {
  // The proxy means Chrome never resolves a proxied host itself, so the rules can't be seen at work through the
  // launched browser; they're checked on their own here (and that launchBrowser passes them, below).
  const bare = await puppeteer.launch({ executablePath: findBrowser(), headless: true, pipe: true, args: ['--host-resolver-rules=' + HOST_RESOLVER_RULES] });
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
  expect((await main.get()).process().spawnargs).toContain('--host-resolver-rules=' + HOST_RESOLVER_RULES);
}, T);

slowTest('a chapter cannot leak data through dns-prefetch/preconnect, under the same network lockdown that loads the bundled fonts', async () => {
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
  const logged = await puppeteer.launch({ executablePath: findBrowser(), headless: true, pipe: true,
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

slowTest('loads a database version with its engine options', async () => {
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

slowTest('loads a work folder, and reports broken code', async () => {
  db.createVersion({ id: 'broken' });
  const jid = db.addJob({ kind: 'chapter', versionId: 'broken', params: { chapter: 1 } });
  const dir = join(data, '.studio/work', String(jid));
  mkdirSync(join(dir, 'ch'), { recursive: true });
  writeFileSync(join(dir, 'ch/c01.js'), "throw new Error('boom');");
  const { page, errors } = await open(`work=${jid}`);
  expect(errors.join()).toContain('boom');
  await page.close();
}, T);

slowTest('an unknown version sets loadError', async () => {
  const { page } = await open('v=nope');
  expect(await page.evaluate(() => window.loadError)).toContain('no such version');
  await page.close();
}, T);

slowTest('without ?render, studio.html is a scrubber that paints the requested version, served only with --dev', async () => {
  // Without --dev there is none, on either host: chapter code never runs in the user's browser.
  const off = await (await main.get()).newPage();
  expect((await off.goto(`${srv.url}/studio.html?v=mini&t=5`)).status()).toBe(404);
  expect((await off.goto(`http://w0.localhost:${srv.port}/studio.html?v=mini&t=5`)).status()).toBe(404);
  expect(await off.evaluate(() => typeof window.paintAt)).toBe('undefined');
  await off.close();

  const devBrowser = await launchBrowser({ port: devSrv.port });
  try {
    const page = await devBrowser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${devSrv.url}/studio.html?v=mini&t=5`);
    expect(page.url()).toStartWith(`http://w0.localhost:${devSrv.port}/studio.html?v=mini`);
    await page.waitForFunction(() => document.getElementById('tt').textContent.includes('ms/frame'), { timeout: 60000 });
    expect(await page.evaluate(() => [VERSION.id, document.getElementById('tt').textContent.split(' ')[0]])).toEqual(['mini', '5.00s']);
    expect(errors).toEqual([]);
  } finally {
    await closeBrowser(devBrowser, 10000);
  }
}, T);

slowTest("in the user's own browser (no proxy, no request interception), the scrubber's chapter still cannot open a popup, navigate, run inline script or use RTCPeerConnection", async () => {
  // The studio.html scrubber (--dev only) runs chapter code in whatever browser opens it, where none of launchBrowser's
  // flags or render.mjs's interception apply: only what the server sends (the CSP and its sandbox) and what
  // src/loader.js does before the version's scripts run. So this opens the scrubber in a browser launched with the
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
attempt(() => { const w = document.open('/src/lyrics.js', 'same', ''); setTimeout(() => attempt(() => w.fetch(E['popup-fetch'] + '/w-fetch')), 300); });
attempt(() => fetch(E.fetch + '/fetch').catch(() => {}));
attempt(() => { new Image().src = E.img + '/img'; });
attempt(() => { const s = document.createElement('script'); s.textContent = 'window.INLINE_RAN = true; fetch(' + JSON.stringify(E.inline + '/inline') + ')'; document.head.append(s); });
attempt(() => { window.RTC_TYPE = typeof RTCPeerConnection + '/' + typeof webkitRTCPeerConnection;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'turn:127.0.0.1:${cap.port('rtc')}?transport=tcp', username: 'u', credential: 'p' }] });
  pc.createDataChannel('x'); pc.createOffer().then(o => pc.setLocalDescription(o)); });
// Navigation last, with the guard that stops it disarmed as far as this code can (put back afterwards, since the
// scrubber itself still needs addEventListener for its controls).
const { preventDefault } = Event.prototype, { addEventListener } = EventTarget.prototype;
Event.prototype.preventDefault = () => {};
EventTarget.prototype.addEventListener = () => {};
attempt(() => { location.href = E.nav + '/nav'; });
attempt(() => { document.body.appendChild(document.createElement('iframe')).contentWindow.parent.location.href = E['nav-realm'] + '/nav-realm'; });
Object.assign(Event.prototype, { preventDefault });
Object.assign(EventTarget.prototype, { addEventListener });
attempt(() => { const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=' + E['nav-meta'] + '/nav-meta'; document.head.append(m); });
` }], { source: 'manual' });
  // A browser context of its own: whatever this hostile chapter manages to leave behind (cookies, storage, a stray
  // page) goes with it, instead of into the shared browser's default context the file's other tests use.
  const plain = await plainBrowser.get(), context = await plain.createBrowserContext();
  let rendering, state, page;
  const popups = [], onTarget = t => { if (t.type() === 'page' && t.browserContext() === context) popups.push(t.url()); };
  try {
    page = await context.newPage();
    plain.on('targetcreated', onTarget);
    await page.goto(`${devSrv.url}/studio.html?v=b-escapee`);
    // The scrubber comes up and goes on painting frames, its chapter's attempts notwithstanding.
    rendering = await page.waitForFunction(() => document.getElementById('tt')?.textContent.includes('ms/frame'), { timeout: 60000 })
      .then(() => page.evaluate(() => window.renderAt(1, 'image/jpeg', .5).then(u => u.length > 10000)), () => false);
    await Bun.sleep(1500);
    state = await page.evaluate(() => [window.CHAPTER_RAN === true, window.INLINE_RAN === true, window.RTC_TYPE, location.pathname]).catch(e => e.message);
  } finally {
    plain.off('targetcreated', onTarget);
    await page?.close().catch(() => {});
    await context.close().catch(() => {});
    cap.stop();
  }
  expect(cap.hits).toEqual({});
  expect(rendering).toBe(true);
  expect(state).toEqual([true, false, 'undefined/undefined', '/studio.html']);
  expect(popups).toEqual([]);
}, T);

slowTest('on a renderer host, every page but studio.html is inert: an opaque origin that runs no script and loads nothing', async () => {
  // What a popup or frame of an engine script, a version file or an API answer would be, were chapter code to get one
  // open on its own origin: nothing to reach into and no fetch, Image or Worker of its own to use.
  const cap = await captureHosts(['from-page']);
  const page = await (await plainBrowser.get()).newPage();
  try {
    for (const path of ['/src/lyrics.js', '/v/original/ch/c01_lab.js', '/api/versions/original', '/nope']) {
      await page.goto(`http://w0.localhost:${srv.port}${path}`);
      expect([path, await page.evaluate(() => [window.origin, document.querySelectorAll('iframe').length])]).toEqual([path, ['null', 0]]);
      expect([path, await page.evaluate(u => fetch(u).then(() => 'fetched', () => 'blocked'), cap.url('from-page'))]).toEqual([path, 'blocked']);
      await page.evaluate(u => { new Image().src = u; try { new Worker('/src/lyrics.js'); } catch {} }, cap.url('from-page'));
    }
    await Bun.sleep(500);
  } finally {
    await page.close().catch(() => {});
    cap.stop();
  }
  expect(cap.hits).toEqual({});
}, T);

// Talking to Chrome over a pipe rather than a WebSocket, Chrome ends with the process that launched it, however that
// ends: a studio (or render.mjs, or a test) killed with SIGKILL leaves no painting browser behind.
slowTest('a browser from launchBrowser dies with the process that launched it, even on SIGKILL', async () => {
  const script = join(tempDir('owner-'), 'owner.js');
  writeFileSync(script, `import { launchBrowser } from ${JSON.stringify(join(root, 'studio/browser.js'))};
const b = await launchBrowser({ port: 1 });
console.log('chrome pid ' + b.process().pid);
setInterval(() => {}, 1000);`);
  const owner = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' });
  const reader = owner.stdout.getReader();
  let out = '';
  while (!/chrome pid (\d+)/.test(out)) { const { value, done } = await reader.read(); if (done) throw new Error('the owner exited: ' + out); out += new TextDecoder().decode(value); }
  const chrome = +/chrome pid (\d+)/.exec(out)[1], alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  expect(alive(chrome)).toBe(true);
  owner.kill('SIGKILL');
  await owner.exited;
  let gone = false;
  for (const t0 = Date.now(); Date.now() - t0 < 10000 && !(gone = !alive(chrome)); ) await Bun.sleep(100);
  if (!gone) process.kill(chrome, 'SIGKILL');   // (don't leave it behind when this fails)
  expect(gone).toBe(true);
}, T);
