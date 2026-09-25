import { test, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../studio/db.js';
import { createApp } from '../studio/app.js';
import { createEvents } from '../studio/events.js';
import { createQueue } from '../studio/queue.js';
import { buildWebIfStale } from '../studio/build-web.js';
import { launchBrowser } from '../studio/browser.js';
import { goodStoryboard, tempDir, tempDefaultDb, isolatedEnv } from './helpers.js';

const root = process.cwd();
buildWebIfStale(root);   // studio/web/dist must exist before any test below can serve it
const defaultDbPath = tempDefaultDb();   // once per file: a private copy, examples are read from it, never written
let db, app, calls, data;
const H = { host: 'localhost:8080' }, W = { ...H, origin: 'http://localhost:8080', 'x-studio-token': 'tok', 'content-type': 'application/json' };
const get = p => app.fetch(new Request('http://localhost:8080' + p, { headers: H }));
const getOn = (host, p) => app.fetch(new Request(`http://${host}${p}`, { headers: { host } }));
const send = (method, p, body, headers = W) => app.fetch(new Request('http://localhost:8080' + p, { method, headers, body: body && JSON.stringify(body) }));

// A second app, backed by a fresh in-memory user.db with default.db attached, so 'original' is present as an
// example. Tests that need the Original use this instead of `app`. Shares the module-level default.db copy unless
// given its own (promoteVersion writes to default.db, so a test that promotes needs a copy of its own).
function withExamples(defaultPath = defaultDbPath, extra = {}) {
  const db2 = openDb(':memory:', { defaultPath });
  const queue2 = { enqueue: () => 7, approve: () => [8, 9], cancel: () => true, retry: () => 10 };
  const app2 = createApp({ db: db2, root, data, token: 'tok', queue: queue2, events: createEvents(), port: 8080, ...extra });
  const get2 = p => app2.fetch(new Request('http://localhost:8080' + p, { headers: H }));
  const send2 = (method, p, body, headers = W) => app2.fetch(new Request('http://localhost:8080' + p, { method, headers, body: body && JSON.stringify(body) }));
  return { db: db2, app: app2, get: get2, send: send2 };
}

beforeEach(() => {
  db = openDb(':memory:'); calls = []; data = tempDir();
  const queue = {
    enqueue: j => { calls.push(['enqueue', j]); return 7; }, approve: (id, model) => { calls.push(['approve', id, model]); return [8, 9]; },
    cancel: id => { calls.push(['cancel', id]); return true; }, retry: id => { calls.push(['retry', id]); return 10; },
  };
  app = createApp({ db, root, data, token: 'tok', queue, events: createEvents(), port: 8080 });
});

const SPA_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self'; font-src 'self'; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

test('the SPA shell carries the token and the exact SPA CSP, on the studio hosts only', async () => {
  const { get: get2 } = withExamples();   // /versions/original needs 'original' to exist
  for (const path of ['/', '/versions/original', '/versions/original/watch', '/library']) {
    const res = await get2(path);
    expect([path, res.status]).toEqual([path, 200]);
    expect(await res.text()).toContain('content="tok"');
    expect(res.headers.get('content-security-policy')).toBe(SPA_CSP);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');
  }
  // Never on a renderer host: chapter code has no more business loading the studio's UI than the UI has loading it.
  for (const path of ['/', '/versions/original', '/library']) {
    const onRenderer = await app.fetch(new Request(`http://w0.localhost:8080${path}`, { headers: { host: 'w0.localhost:8080' } }));
    expect([path, onRenderer.status]).toEqual([path, 404]);
    expect(await onRenderer.text()).not.toContain('tok');
  }
});

test('hashed SPA assets are served with an immutable, long-lived cache-control', async () => {
  const assetDir = join(root, 'studio/web/dist/app-assets');
  const [asset] = readdirSync(assetDir).filter(f => f.endsWith('.js'));
  const res = await get(`/app-assets/${asset}`);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect((await res.text()).length).toBeGreaterThan(0);
  expect((await app.fetch(new Request(`http://w0.localhost:8080/app-assets/${asset}`, { headers: { host: 'w0.localhost:8080' } }))).status).toBe(404);
});

test('the old plain-JS UI still works at /ui/, kept until it is removed', async () => {
  const res = await get('/ui/');
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('content="tok"');
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  expect((await get('/ui')).status).toBe(200);
  expect((await get('/ui/app.js')).status).toBe(200);
  const onRenderer = await app.fetch(new Request('http://w0.localhost:8080/ui/', { headers: { host: 'w0.localhost:8080' } }));
  expect(onRenderer.status).toBe(404);
});

test('/api/song reports the engine timing and every lyric line, matching src/lyrics.js', async () => {
  const lyricsSrc = readFileSync(join(root, 'src/lyrics.js'), 'utf8');
  const expectedCount = new Function(`${lyricsSrc}\nreturn LY.length;`)();
  const song = await (await get('/api/song')).json();
  expect(song.fps).toBe(24);
  expect(song.frames).toBe(Math.ceil(156.6 * 24));
  expect(song.duration).toBe(156.6);
  expect(song.chapters).toHaveLength(9);
  expect(song.lyrics).toHaveLength(expectedCount);
  expect(expectedCount).toBeGreaterThan(0);
  for (const [start, end, text] of song.lyrics) {
    expect(typeof start).toBe('number');
    expect(typeof end).toBe('number');
    expect(typeof text).toBe('string');
    expect(end).toBeGreaterThan(start);
  }
  // renderer hosts get nothing from /api/ that isn't on the loader's allow-list
  expect((await app.fetch(new Request('http://w0.localhost:8080/api/song', { headers: { host: 'w0.localhost:8080' } }))).status).toBe(404);
});

test('--dev accepts Origin http://localhost:5173; without it, that origin is refused', async () => {
  const devApp = createApp({ db, root, data, token: 'tok', queue: { enqueue: () => 1 }, events: createEvents(), port: 8080, dev: true });
  const fromVite = { host: 'localhost:8080', origin: 'http://localhost:5173', 'x-studio-token': 'tok', 'content-type': 'application/json' };
  const dbVersion = 'dev-mode-test';
  const devReq = () => devApp.fetch(new Request('http://localhost:8080/api/versions', { method: 'POST', headers: fromVite, body: JSON.stringify({ id: dbVersion }) }));
  expect((await devReq()).status).toBe(201);
  // The studio's own origins keep working in --dev too.
  expect((await devApp.fetch(new Request('http://localhost:8080/api/versions', { method: 'POST', headers: { ...W, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'dev-mode-test-2' }) }))).status).toBe(201);
  // Without --dev, the Vite origin is refused exactly like any other outside origin.
  const res = await send('POST', '/api/versions', { id: 'nope' }, fromVite);
  expect(res.status).toBe(403);
});

test('--dev writes the per-start token to <data>/.studio/dev-token, mode 600', async () => {
  const dir = tempDir('dev-token-');
  const userPath = join(dir, 'user.db');
  const env = isolatedEnv(dir, { DEFAULT_DB: defaultDbPath, USER_DB: userPath });
  const p = Bun.spawn(['bun', 'studio/server.js', '--port=0', '--dev'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const reader = p.stdout.getReader(), dec = new TextDecoder();
  let out = '';
  try {
    while (!/Studio: (http:\/\/localhost:\d+)\//.test(out)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the dev server exited: ${out}${await new Response(p.stderr).text()}`);
      out += dec.decode(value);
    }
    const tokenPath = join(dir, '.studio/dev-token');
    expect(existsSync(tokenPath)).toBe(true);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(tokenPath, 'utf8')).toMatch(/^[0-9a-f]{48}$/);
  } finally { p.kill(); await p.exited; }
}, { timeout: 30000 });

test('the token page and the UI are served on the studio hosts only, never where version code runs', async () => {
  for (const host of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080']) {
    expect((await getOn(host, '/')).status).toBe(200);
    expect((await getOn(host, '/ui/app.js')).status).toBe(200);
  }
  for (const host of ['w0.localhost:8080', 'w2.localhost:8080']) {
    const page = await getOn(host, '/');
    expect(page.status).toBe(404);
    expect(await page.text()).not.toContain('tok');
    expect((await getOn(host, '/ui/app.js')).status).toBe(404);
  }
});

test('studio.html runs only on w<n>.localhost, under a content security policy', async () => {
  for (const host of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080']) {
    const res = await getOn(host, '/studio.html?render&v=a');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://w0.localhost:8080/studio.html?render&v=a');
  }
  const res = await getOn('w1.localhost:8080', '/studio.html?v=a');
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('src/loader.js');
  // No inline script, so the policy needn't allow any: chapter code can't add its own (or speculation rules) either.
  expect(html.match(/<script\b[^>]*>/g).filter(tag => !/\bsrc=/.test(tag))).toEqual([]);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  const csp = Object.fromEntries(res.headers.get('content-security-policy').split(';').map(d => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  expect(csp['default-src']).toEqual(["'self'"]);
  expect(csp['script-src']).toEqual(["'self'"]);
  expect(csp['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
  expect(csp['font-src']).toEqual(["'self'"]);
  expect(res.headers.get('content-security-policy')).not.toContain('fonts.googleapis.com');
  expect(res.headers.get('content-security-policy')).not.toContain('fonts.gstatic.com');
  expect(csp['img-src']).toEqual(["'self'", 'data:', 'blob:']);
  expect(csp['connect-src']).toEqual(["'self'"]);
  expect(csp['media-src']).toEqual(["'self'"]);
  expect(csp['worker-src']).toEqual(["'none'"]);
  expect(csp['frame-src']).toEqual(["'none'"]);
  expect(csp['object-src']).toEqual(["'none'"]);
  expect(csp['form-action']).toEqual(["'none'"]);
  expect(csp['base-uri']).toEqual(["'none'"]);
  expect(csp['frame-ancestors']).toEqual(['http://localhost:8080', 'http://127.0.0.1:8080', 'http://*.localhost:8080']);
  // Sandboxed: no popups, top-level navigation, downloads or forms, whatever user activation it gets. Scripts and its
  // own origin stay (the loader's fetches, the player's postMessage origin checks), and so do modal dialogs, without
  // which Chrome silently skips render.mjs's beforeunload guard.
  expect(csp.sandbox).toEqual(['allow-scripts', 'allow-same-origin', 'allow-modals']);
});

test('everything else a renderer host serves is locked down, should it ever be opened as a page', async () => {
  // Chapter code could open (or frame) any of these on its own origin; without a policy of their own, such a page
  // would hand it a window with an unrestricted fetch. Sandboxed into an opaque origin with nothing allowed to load,
  // there's nothing to reach into, and nosniff keeps a script from ever being taken for a page.
  const { db: db2, app: app2 } = withExamples();
  db2.createVersion({ id: 'a' });
  db2.writeFiles('a', [{ path: 'ch/c01.js', content: '// one' }, { path: 'STORYBOARD.md', content: '# a' }], { source: 'manual' });
  const locked = "default-src 'none'; sandbox; frame-ancestors 'none'";
  for (const host of ['w0.localhost:8080', 'w4.localhost:8080']) {
    const at = (p, headers = {}) => app2.fetch(new Request(`http://${host}${p}`, { headers: { host, ...headers } }));
    for (const [p, status, type] of [['/watch.html', 200, 'text/html'], ['/src/core.js', 200, 'text/javascript'], ['/src/loader.js', 200, 'text/javascript'],
      ['/node_modules/p5/lib/p5.min.js', 200, 'text/javascript'], ['/assets/pdoom.mp3', 200, 'audio/mpeg'], ['/v/a/ch/c01.js', 200, 'text/javascript'],
      ['/v/a/STORYBOARD.md', 200, 'text/markdown'], ['/api/versions/a', 200, 'application/json'], ['/api/jobs', 404, 'application/json'], ['/nope.html', 404, 'application/json']]) {
      const res = await at(p);
      expect([p, res.status, res.headers.get('content-type').split(';')[0]]).toEqual([p, status, type]);
      expect([p, res.headers.get('content-security-policy'), res.headers.get('x-content-type-options')]).toEqual([p, locked, 'nosniff']);
    }
    const range = await at('/assets/pdoom.mp3', { range: 'bytes=0-99' });
    expect([range.status, range.headers.get('content-range')?.split('/')[0], range.headers.get('content-security-policy')]).toEqual([206, 'bytes 0-99', locked]);
    expect((await range.arrayBuffer()).byteLength).toBe(100);
  }
  // The studio's own hosts, where no version code runs, are left as they were.
  const own = await app2.fetch(new Request('http://localhost:8080/watch.html', { headers: H }));
  expect([own.status, own.headers.get('content-security-policy')]).toEqual([200, null]);
});

test('renderer hosts never serve a service worker or shared worker script, whatever the path', async () => {
  const { db: db2, app: app2 } = withExamples();
  db2.createVersion({ id: 'a' });
  db2.writeFiles('a', [{ path: 'ch/c01.js', content: '// one' }], { source: 'manual' });
  const fetchAs = (host, p, dest) => app2.fetch(new Request(`http://${host}${p}`, { headers: { host, ...(dest ? { 'sec-fetch-dest': dest } : {}) } }));
  const paths = ['/studio.html', '/v/a/ch/c01.js', '/v/original/ch/c01_lab.js', '/src/lyrics.js', '/api/versions/a', '/nope'];
  for (const host of ['w0.localhost:8080', 'w5.localhost:8080']) {
    for (const p of paths) for (const dest of ['serviceworker', 'sharedworker']) expect((await fetchAs(host, p, dest)).status).toBe(404);
    // the same files still load as what they are
    for (const p of ['/studio.html', '/v/a/ch/c01.js', '/src/lyrics.js', '/api/versions/a']) {
      expect((await fetchAs(host, p, null)).status).toBe(200);
      expect((await fetchAs(host, p, p.endsWith('.js') ? 'script' : p === '/studio.html' ? 'document' : 'empty')).status).toBe(200);
    }
  }
});

test('worker hosts answer only the API endpoints the loader needs; the rest of /api is 404 there', async () => {
  db.createVersion({ id: 'a' });
  const jid = db.addJob({ kind: 'chapter', versionId: 'a', params: { chapter: 1 } });
  mkdirSync(join(data, '.studio/work', String(jid)), { recursive: true });
  for (const host of ['w0.localhost:8080', 'w3.localhost:8080']) {
    expect((await getOn(host, '/api/versions/a')).status).toBe(200);
    expect((await getOn(host, `/api/work/${jid}`)).status).toBe(200);
    for (const p of ['/api/versions', '/api/jobs', `/api/jobs/${jid}`, '/api/health', '/api/library', '/api/events', '/api/versions/a/history']) {
      expect((await getOn(host, p)).status).toBe(404);
    }
  }
  // unaffected on the studio's own hosts
  expect((await get('/api/versions')).status).toBe(200);
  expect((await get(`/api/jobs/${jid}`)).status).toBe(200);
});

test('serves engine files but nothing private', async () => {
  expect((await getOn('w0.localhost:8080', '/studio.html')).status).toBe(200);
  expect((await get('/watch.html')).status).toBe(200);
  expect((await get('/src/core.js')).status).toBe(200);
  expect((await get('/node_modules/p5/lib/p5.min.js')).status).toBe(200);
  for (const p of ['/studio.db', '/.git/config', '/package.json', '/studio/db.js', '/src/../package.json']) expect((await get(p)).status).toBe(404);
});

test('the bundled fonts are served on both the studio and renderer hosts, with their content types', async () => {
  for (const host of ['localhost:8080', 'w0.localhost:8080']) {
    const css = await getOn(host, '/assets/fonts/fonts.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toContain('Permanent Marker');
    for (const [file, family] of [['PermanentMarker-Regular.woff2', 'Permanent Marker'], ['ShantellSans-ExtraBold.woff2', 'Shantell Sans']]) {
      const font = await getOn(host, `/assets/fonts/${file}`);
      expect([family, font.status, font.headers.get('content-type')]).toEqual([family, 200, 'font/woff2']);
    }
  }
  // license texts and anything else in the folder are not served
  expect((await get('/assets/fonts/LICENSE-PermanentMarker.txt')).status).toBe(404);
});

test('changes need the token', async () => {
  expect((await send('POST', '/api/versions', { id: 'a' }, { ...H, origin: 'http://localhost:8080' })).status).toBe(403);
});

test('create, list and describe versions', async () => {
  expect((await send('POST', '/api/versions', { id: 'cooking-show', title: 'Bake-Off', concept: 'bake' })).status).toBe(201);
  expect((await send('POST', '/api/versions', { id: 'Bad Id' })).status).toBe(400);
  expect((await (await get('/api/versions')).json()).map(v => v.id)).toEqual(['cooking-show']);
  const m = await (await get('/api/versions/cooking-show')).json();
  expect(m).toMatchObject({ id: 'cooking-show', title: 'Bake-Off', concept: 'bake', scripts: [] });
  expect((await get('/api/versions/nope')).status).toBe(404);
  await send('PUT', '/api/versions/cooking-show', { options: { wipes: false }, title: 'New' });
  expect((await (await get('/api/versions/cooking-show')).json()).options.wipes).toBe(false);
});

test('manual storyboard edit updates title, logline and status, with history and restore', async () => {
  db.createVersion({ id: 'a' });
  await send('PUT', '/api/versions/a/files/STORYBOARD.md', { content: 'draft' });
  expect((await send('PUT', '/api/versions/a/files/STORYBOARD.md', { content: goodStoryboard() })).status).toBe(200);
  expect(db.getVersion('a')).toMatchObject({ title: 'The P(doom) Bake-Off', status: 'storyboard' });
  const revs = await (await get('/api/versions/a/revisions?path=STORYBOARD.md')).json();
  expect(revs).toHaveLength(2);
  expect(revs[0].content).toBeUndefined();
  expect((await (await get(`/api/revisions/${revs[1].id}`)).json()).content).toBe('draft');
  await send('POST', `/api/revisions/${revs[1].id}/restore`);
  expect(db.getFile('a', 'STORYBOARD.md').content).toBe('draft');
});

test('version files are served from the database', async () => {
  const { get: get2 } = withExamples();
  const res = await get2('/v/original/ch/c01_lab.js');
  expect(res.headers.get('content-type')).toContain('javascript');
  expect(await res.text()).toContain("chapter('lab'");
  expect((await get2('/v/original/../../studio.db')).status).toBe(404);
});

test('approve checks the storyboard first', async () => {
  db.createVersion({ id: 'a' }); db.updateVersion('a', { status: 'storyboard' });
  db.writeFiles('a', [{ path: 'STORYBOARD.md', content: 'not valid' }], { source: 'manual' });
  expect((await send('POST', '/api/versions/a/approve', {})).status).toBe(409);
  db.writeFiles('a', [{ path: 'STORYBOARD.md', content: goodStoryboard() }], { source: 'manual' });
  expect(await (await send('POST', '/api/versions/a/approve', { model: 'opus' })).json()).toEqual({ jobs: [8, 9] });
  expect(calls).toContainEqual(['approve', 'a', 'opus']);
});

test('approve works only on a storyboard waiting for it, and never while shared or chapter jobs run', async () => {
  db.createVersion({ id: 'a' });
  db.writeFiles('a', [{ path: 'STORYBOARD.md', content: goodStoryboard() }], { source: 'manual' });
  for (const status of ['concept', 'approved', 'chapters', 'ready']) {
    db.updateVersion('a', { status });
    expect((await send('POST', '/api/versions/a/approve', {})).status).toBe(409);
  }
  db.updateVersion('a', { status: 'storyboard' });
  for (const kind of ['shared', 'chapter']) for (const status of ['queued', 'running']) {
    const jid = db.addJob({ kind, versionId: 'a', params: { chapter: 1 } }); db.updateJob(jid, { status });
    const res = await send('POST', '/api/versions/a/approve', {});
    expect([res.status, (await res.json()).error]).toEqual([409, `a ${kind} job for this version is already ${status}`]);
    db.updateJob(jid, { status: 'failed' });
  }
  db.updateJob(db.addJob({ kind: 'storyboard', versionId: 'a' }), { status: 'running' });   // other kinds don't block
  expect((await send('POST', '/api/versions/a/approve', {})).status).toBe(200);
  expect(calls.filter(c => c[0] === 'approve')).toHaveLength(1);
});

test('approving twice queues the chapters once', async () => {
  const queue = createQueue({ db, events: createEvents(), runners: {} });   // not started: jobs stay queued
  app = createApp({ db, root, data, token: 'tok', queue, events: createEvents(), port: 8080 });
  db.createVersion({ id: 'a' }); db.updateVersion('a', { status: 'storyboard' });
  db.writeFiles('a', [{ path: 'STORYBOARD.md', content: goodStoryboard() }], { source: 'manual' });
  const [first, second] = await Promise.all([send('POST', '/api/versions/a/approve', {}), send('POST', '/api/versions/a/approve', {})]);
  expect([first.status, second.status].sort()).toEqual([200, 409]);
  expect(db.listJobs({ versionId: 'a' }).map(j => j.kind).sort()).toEqual(['chapter', 'chapter', 'chapter', 'chapter', 'chapter', 'chapter', 'chapter', 'chapter', 'chapter', 'shared']);
});

test('job lists leave the logs out; a single job comes with its log', async () => {
  db.createVersion({ id: 'a' });
  const jid = db.addJob({ kind: 'storyboard', versionId: 'a' }); db.appendLog(jid, 'hello log');
  for (const p of ['/api/jobs', '/api/jobs?version=a']) {
    const [j] = await (await get(p)).json();
    expect(j).toMatchObject({ id: jid, kind: 'storyboard', status: 'queued', params: {} });
    expect('log' in j).toBe(false);
  }
  expect(await (await get(`/api/jobs/${jid}`)).json()).toMatchObject({ id: jid, kind: 'storyboard', params: {}, log: 'hello log' });
  expect((await get('/api/jobs/999')).status).toBe(404);
});

test('a final render needs all nine chapters, and one render of a version at a time', async () => {
  db.createVersion({ id: 'a' });
  const chapter = n => ({ path: `ch/c0${n}.js`, content: `// ${n}` });
  db.writeFiles('a', [1, 2, 3, 4, 5, 6, 7, 8].map(chapter), { source: 'manual' });
  const render = () => send('POST', '/api/jobs', { kind: 'render', versionId: 'a' });
  let res = await render();
  expect([res.status, (await res.json()).error]).toEqual([409, 'a final render needs all nine chapters (8 of 9 are written)']);
  db.writeFiles('a', [chapter(9)], { source: 'manual' });
  expect((await render()).status).toBe(201);
  const jid = db.addJob({ kind: 'render', versionId: 'a' });
  for (const status of ['queued', 'running']) {
    db.updateJob(jid, { status });
    res = await render();
    expect([res.status, (await res.json()).error]).toEqual([409, `a render of this version is already ${status}`]);
  }
  db.updateJob(jid, { status: 'done' });
  expect((await render()).status).toBe(201);
});

test('health reports the tools, and whether the Claude CLI is signed in', async () => {
  const dir = tempDir('cli-'), calls = join(dir, 'calls');
  const cli = (name, body) => { writeFileSync(join(dir, name), body); return `bun ${join(dir, name)}`; };
  const health = async claudeBin => {
    app = createApp({ db, root, data, token: 'tok', queue: {}, events: createEvents(), port: 8080, claudeBin, authTimeoutMs: 500 });
    return (await get('/api/health')).json();
  };
  expect(await health(`bun ${join(root, 'test/fake-claude.js')}`)).toMatchObject({ claude: true, claudeSignedIn: true });
  const out = cli('out.js', `require('fs').appendFileSync(${JSON.stringify(calls)}, 'x'); console.log(JSON.stringify({ loggedIn: false })); process.exit(1);`);
  expect(await health(out)).toMatchObject({ claude: true, claudeSignedIn: false });
  await get('/api/health');                                   // cached for a minute: no second `claude auth status`
  expect(readFileSync(calls, 'utf8')).toBe('x');
  expect(await health(cli('hang.js', 'await Bun.sleep(5000);'))).toMatchObject({ claudeSignedIn: null });
  expect(await health(cli('junk.js', 'console.log("not json")'))).toMatchObject({ claudeSignedIn: null });
  expect(await health('no-such-claude-cli')).toMatchObject({ claude: false, claudeSignedIn: null });
});

test('jobs are handed to the queue', async () => {
  db.createVersion({ id: 'a' });
  expect((await send('POST', '/api/jobs', { kind: 'nonsense', versionId: 'a' })).status).toBe(400);
  expect((await send('POST', '/api/jobs', { kind: 'chapter', versionId: 'missing' })).status).toBe(404);
  expect(await (await send('POST', '/api/jobs', { kind: 'chapter', versionId: 'a', params: { chapter: 2, feedback: 'bigger' } })).json()).toEqual({ id: 7 });
  await send('POST', '/api/jobs/7/cancel'); await send('POST', '/api/jobs/7/retry');
  expect(calls.map(c => c[0])).toEqual(['enqueue', 'cancel', 'retry']);
});

test('library lists renders and deleting removes the files', async () => {
  mkdirSync(join(data, 'library'), { recursive: true });
  writeFileSync(join(data, 'library', 'zz-test.mp4'), 'mp4'); writeFileSync(join(data, 'library', 'zz-test.jpg'), 'jpg');
  db.createVersion({ id: 'a', title: 'A' });
  const rid = db.addRender({ versionId: 'a', file: 'zz-test.mp4', revisionIds: [], durationS: 1, renderS: 1, sizeBytes: 3, poster: 'zz-test.jpg' });
  expect((await (await get('/api/library')).json())[0]).toMatchObject({ id: rid, title: 'A' });
  expect((await get('/library/zz-test.mp4')).status).toBe(200);
  await send('DELETE', `/api/library/${rid}`);
  expect(existsSync(join(data, 'library', 'zz-test.mp4'))).toBe(false);
  expect(db.listRenders()).toEqual([]);
});

test('version responses carry storyboard errors, and the whole history', async () => {
  db.createVersion({ id: 'a' });
  db.writeFiles('a', [{ path: 'STORYBOARD.md', content: 'nope' }], { source: 'manual', note: 'first try' });
  db.writeFiles('a', [{ path: 'ch/c01.js', content: '//' }], { source: 'claude', note: 'make it pop' });
  expect((await (await get('/api/versions/a')).json()).storyboardErrors).toContain('expected 9 chapters, found 0');
  const hist = await (await get('/api/versions/a/history')).json();
  expect(hist.map(r => [r.path, r.note])).toEqual([['ch/c01.js', 'make it pop'], ['STORYBOARD.md', 'first try']]);
  expect(hist[0].content).toBeUndefined();
});

test('the legacy-format Original never shows storyboard errors', async () => {
  const { get: get2 } = withExamples();
  expect((await (await get2('/api/versions/original')).json()).storyboardErrors).toEqual([]);
});

test('version listing and detail carry the example flag', async () => {
  const { db: db2, get: get2 } = withExamples();
  db2.createVersion({ id: 'mine' });
  const list = await (await get2('/api/versions')).json();
  expect(list.find(v => v.id === 'original').example).toBe(true);
  expect(list.find(v => v.id === 'mine').example).toBe(false);
  expect((await (await get2('/api/versions/original')).json()).example).toBe(true);
});

test('changing an example is refused everywhere it would write: storyboard, metadata, approve, restore, and claude jobs', async () => {
  const { db: db2, get: get2, send: send2 } = withExamples();
  const denied = async res => { expect(res.status).toBe(403); expect((await res.json()).error).toBe('examples are read-only — remix it first'); };

  await denied(await send2('PUT', '/api/versions/original/files/STORYBOARD.md', { content: 'x' }));
  await denied(await send2('PUT', '/api/versions/original', { title: 'x' }));
  await denied(await send2('POST', '/api/versions/original/approve', {}));
  for (const kind of ['storyboard', 'shared', 'chapter']) await denied(await send2('POST', '/api/jobs', { kind, versionId: 'original' }));

  const [rev] = db2.history('original', 'STORYBOARD.md');
  await denied(await send2('POST', `/api/revisions/${rev.id}/restore`));
});

test('retrying a storyboard, shared or chapter job of an example is refused; render and thumbs retry', async () => {
  const retried = [];
  const { db: db2 } = withExamples();
  const app2 = createApp({ db: db2, root, data, token: 'tok', queue: { retry: id => { retried.push(id); return 10; } }, events: createEvents(), port: 8080 });
  const retry = jid => app2.fetch(new Request(`http://localhost:8080/api/jobs/${jid}/retry`, { method: 'POST', headers: W }));
  const failed = kind => { const jid = db2.addJob({ kind, versionId: 'original', params: { chapter: 1 } }); db2.updateJob(jid, { status: 'failed' }); return jid; };
  for (const kind of ['storyboard', 'shared', 'chapter']) {
    const res = await retry(failed(kind));
    expect([res.status, (await res.json()).error]).toEqual([403, 'examples are read-only — remix it first']);
  }
  expect(retried).toEqual([]);
  const allowed = ['render', 'thumbs'].map(failed);
  for (const jid of allowed) expect((await retry(jid)).status).toBe(200);
  expect(retried).toEqual(allowed);
});

test('render and thumbs jobs are allowed on examples', async () => {
  const { send: send2 } = withExamples();
  expect((await send2('POST', '/api/jobs', { kind: 'render', versionId: 'original' })).status).toBe(201);
  expect((await send2('POST', '/api/jobs', { kind: 'thumbs', versionId: 'original' })).status).toBe(201);
});

test('remix copies an example into a new, writable version; a clashing id is refused', async () => {
  const { send: send2 } = withExamples();
  const res = await send2('POST', '/api/versions/original/remix', { id: 'my-remix', title: 'My Remix' });
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ id: 'my-remix', title: 'My Remix', example: false, status: 'ready' });

  const clash = await send2('POST', '/api/versions/original/remix', { id: 'my-remix', title: 'Again' });
  expect(clash.status).toBe(409);
});

test('promote moves a user version into default.db, and refuses when it cannot', async () => {
  const { db: db2, send: send2 } = withExamples(tempDefaultDb());   // its own copy: promote writes to default.db
  db2.createVersion({ id: 'mine', title: 'Mine' });
  db2.writeFiles('mine', [{ path: 'ch/c01.js', content: '// 1' }], { source: 'manual' });

  const res = await send2('POST', '/api/versions/mine/promote');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ id: 'mine', example: true });

  const again = await send2('POST', '/api/versions/mine/promote');
  expect(again.status).toBe(409);
});

test('promote waits for the version\'s storyboard, shared and chapter jobs to finish', async () => {
  const { db: db2, send: send2 } = withExamples(tempDefaultDb());   // its own copy: promote writes to default.db
  db2.createVersion({ id: 'mine' });
  for (const kind of ['storyboard', 'shared', 'chapter']) for (const status of ['queued', 'running']) {
    const jid = db2.addJob({ kind, versionId: 'mine', params: { chapter: 1 } }); db2.updateJob(jid, { status });
    const res = await send2('POST', '/api/versions/mine/promote');
    expect([res.status, (await res.json()).error]).toEqual([409, `a ${kind} job for this version is still ${status} — let it finish or cancel it first`]);
    expect(db2.getVersion('mine').example).toBe(false);
    db2.updateJob(jid, { status: 'failed' });
  }
  db2.updateJob(db2.addJob({ kind: 'render', versionId: 'mine' }), { status: 'running' });   // renders don't block
  const res = await send2('POST', '/api/versions/mine/promote');
  expect(res.status).toBe(200);
  expect(db2.getVersion('mine').example).toBe(true);
});

test('work folders are served while a job runs', async () => {
  db.createVersion({ id: 'a' });
  const jid = db.addJob({ kind: 'chapter', versionId: 'a', params: { chapter: 1 } });
  const dir = join(data, '.studio/work', String(jid));
  mkdirSync(join(dir, 'ch'), { recursive: true }); writeFileSync(join(dir, 'ch/c01.js'), '// c1');
  expect((await (await get(`/api/work/${jid}`)).json()).scripts).toEqual(['ch/c01.js']);
  expect(await (await get(`/work/${jid}/ch/c01.js`)).text()).toBe('// c1');
  expect((await get(`/work/${jid}/TASK.md`)).status).toBe(404);
});

// The Vite build must emit no inline scripts — the SPA CSP's script-src 'self' allows none. Proven end to end: a real
// server, a real (sealed, but not network-isolated the way the render browser is — this is the studio's own UI)
// headless Chrome, and the browser's own CSP enforcement, not a static read of the HTML.
let cspServer, cspBrowser;
beforeAll(async () => {
  const dir = tempDir('csp-');
  cspServer = Bun.spawn(['bun', 'studio/server.js', '--port=0'], { cwd: root, env: isolatedEnv(dir, { DEFAULT_DB: defaultDbPath }), stdout: 'pipe', stderr: 'pipe' });
  const reader = cspServer.stdout.getReader(), dec = new TextDecoder();
  let out = '';
  while (!/Studio: (http:\/\/localhost:\d+)\//.test(out)) out += dec.decode((await reader.read()).value);
  cspServer.url = /Studio: (http:\/\/localhost:\d+)\//.exec(out)[1];
  cspBrowser = await launchBrowser({ port: new URL(cspServer.url).port });
}, 30000);
afterAll(async () => { await cspBrowser?.close(); cspServer?.kill(); await cspServer?.exited; });

test('the built SPA loads under the SPA CSP with no violations (so, no inline scripts)', async () => {
  const page = await cspBrowser.newPage();
  const violations = [];
  await page.evaluateOnNewDocument(() => {
    document.addEventListener('securitypolicyviolation', e => {
      (window.__cspViolations ??= []).push(`${e.violatedDirective}: ${e.blockedURI}`);
    });
  });
  const pageErrors = [], frames = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('response', r => { if (r.url().includes('/api/frames/')) frames.push(`${r.request().method()} ${r.status()} ${r.headers()['content-type']}`); });
  // Not networkidle0: the app opens an EventSource('/api/events') that's meant to stay open, so the network is
  // never idle.
  await page.goto(`${cspServer.url}/`, { waitUntil: 'domcontentloaded' });
  // The "/" -> "/versions/<id>" client-side redirect (router.tsx) has to have actually run for this to prove
  // anything: it depends on a same-origin fetch succeeding under connect-src 'self'.
  await page.waitForFunction(() => location.pathname.startsWith('/versions/'), { timeout: 10000 });

  // The workspace: the preview player draws a server-painted frame onto its canvas (fetch, createImageBitmap, canvas;
  // no chapter code on this page), and a timeline block's tooltip opens (Radix positions it with inline styles, set
  // through the CSSOM, which the CSP allows; a <style> tag it doesn't).
  await page.waitForSelector('[role="slider"][aria-label="Playhead"]', { timeout: 10000 });
  await page.waitForSelector('[data-painting="false"] canvas', { timeout: 40000 });
  expect(frames).toContain('GET 200 image/jpeg');
  // past what it fetches, the player has the server paint ahead (a token-guarded POST)
  await page.waitForFunction(() => performance.getEntriesByType('resource').some(e => e.name.endsWith('/paint-ahead')), { timeout: 10000 });
  expect(frames.filter(f => f.startsWith('POST')).map(f => f.split(';')[0])).toContain('POST 200 application/json');
  await page.hover('button[aria-label^="Chapter 2"]');
  await page.waitForSelector('[role="tooltip"]', { timeout: 10000 });

  // The pieces that bring their own runtime CSS have to be on screen too: a toast (sonner injects a <style> tag at
  // import time) and a modal sheet (Radix locks page scroll through react-remove-scroll, which injects one when it
  // opens). Clearing the cache from the settings popover shows a toast; the jobs indicator opens the jobs drawer.
  await page.click('button[aria-label="Settings"]');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Clear cache' && !b.disabled), { timeout: 10000 });
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Clear cache').click());
  await page.waitForSelector('[data-sonner-toast]', { timeout: 10000 });
  // sonner's stylesheet made it into the bundle (a CSP-blocked <style> tag would have left the toaster unstyled).
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-sonner-toaster]')).position)).toBe('fixed');
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Jobs:')).click());
  await page.waitForSelector('[role="dialog"][data-slot="sheet-content"]', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 300));   // let any late violation reports arrive

  violations.push(...(await page.evaluate(() => window.__cspViolations || [])));
  expect(violations).toEqual([]);
  expect(pageErrors).toEqual([]);
  // Page scroll is still locked while the sheet is open, without a <style> tag.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe('hidden');
  await page.close();
}, 90000);
