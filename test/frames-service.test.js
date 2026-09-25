import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../studio/db.js';
import { serve } from '../studio/serve.js';
import { createApp } from '../studio/app.js';
import { createEvents } from '../studio/events.js';
import { snapshotOf } from '../studio/snapshot.js';
import { createCache } from '../studio/frames/cache.js';
import { createPool } from '../studio/frames/pool.js';
import { createFrameService } from '../studio/frames/service.js';
import { N, engineHash, segmentKeys, currentShas } from '../studio/frames/keys.js';
import { CHAPTER_WINDOWS } from '../studio/storyboard.js';
import { tempDir, tempDefaultDb } from './helpers.js';

// One sealed painting pool for the file, over a throwaway data root and user database holding small versions whose
// chapters paint in a few tens of milliseconds (the Original's take up to a second a frame).
const root = process.cwd(), T = { timeout: 120000 }, token = 'tok', PAINTERS = 3;
let data, db, events, cache, pool, service, srv, port;
const painted = [];   // every frame the pool hands over, in order

// A chapter that paints a moving block and its number; nothing near the wipes (±0.3 s around 1.5, 38.5, 73, 109.4 s)
// is painted in these tests, so frames stay cheap.
const fastChapter = (n, extra = '') => {
  const [a, b] = CHAPTER_WINDOWS[n - 1];
  return `chapter('c${n}', ${a}, ${b}, [[${a}, t => { ${extra} paint(rectPts(100 + (t - ${a}) * 20, 200, 300, 200), { wash: PAL.clay }); letter('${n}', 960, 540, 90, PAL.ink); }]]);`;
};
const fastVersion = (id, options = {}) => {
  db.createVersion({ id, options });
  db.writeFiles(id, [{ path: 'shared.js', content: '// shared' }, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ path: `ch/c0${n}.js`, content: fastChapter(n) }))], { source: 'manual' });
};
const freePort = () => { const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }); const p = s.port; s.stop(true); return p; };
// A frame through the service, painted if need be.
const frameOf = async (versionId, i, prio = 'preview') => { const r = service.frame(versionId, i, prio); return r.pending ? r.pending : r; };
const keysOf = versionId => segmentKeys(snapshotOf(db, versionId), engineHash(root));
const at = (host, path, init = {}) => srv.app.fetch(new Request(`http://${host}${path}`, { ...init, headers: { host, ...init.headers } }));

beforeAll(() => {
  data = tempDir();
  db = openDb(join(data, 'user.db'), { defaultPath: tempDefaultDb() });
  fastVersion('tiny');
  fastVersion('rev', { cornerMeter: false });
  db.createVersion({ id: 'partial' });
  db.writeFiles('partial', [{ path: 'ch/c01.js', content: fastChapter(1) }], { source: 'manual' });
  db.createVersion({ id: 'bad' });
  db.writeFiles('bad', [
    { path: 'ch/c01.js', content: fastChapter(1) },
    { path: 'ch/c02.js', content: "chapter('c2', 23, 38.5, [[23, t => { throw new Error('chapter two is broken'); }]]);" },
    { path: 'ch/c03.js', content: "chapter('c3', 38.5, 59, [[38.5, t => { for (;;) {} }]]);" },
    { path: 'ch/c04.js', content: "throw new Error('chapter four failed to load');" },
    { path: 'ch/c05.js', content: fastChapter(5) },
  ], { source: 'manual' });
  db.createVersion({ id: 'slow' });
  db.writeFiles('slow', [{ path: 'ch/c01.js', content: fastChapter(1, 'const end = performance.now() + 800; while (performance.now() < end) {}') }], { source: 'manual' });
  db.remixVersion('original', { id: 'orig' });
  // CAST entries read, missing and listed: chapter 2 defines a guest, chapter 9 reads it and one nobody defined,
  // chapter 8 lists them all
  db.createVersion({ id: 'casty' });
  db.writeFiles('casty', [
    { path: 'ch/c02.js', content: "CAST.guest = () => 1;\n" + fastChapter(2) },
    { path: 'ch/c08.js', content: fastChapter(8, 'Object.keys(CAST);') },
    { path: 'ch/c09_end.js', content: fastChapter(9, 'CAST.guest(); CAST.nobody;') },
  ], { source: 'manual' });

  port = freePort();
  events = createEvents();
  cache = createCache({ dir: join(data, '.studio/cache/frames'), capBytes: 1e12 });
  pool = createPool({ port, baseUrl: `http://localhost:${port}`, painters: PAINTERS, paintTimeoutMs: 2000,
    onPainted: p => { painted.push(p); cache.put(p.key, p.frame, p.jpeg, p.deps); } });
  service = createFrameService({ db, cache, pool, events, root });
  srv = serve({ db, root, data, token, events, port, frames: service });
});
afterAll(async () => { await pool?.close(); srv?.stop(); });

test('a frame is painted once, then served from the cache', async () => {
  const before = pool.stats().painted;
  // two requests at once coalesce into one paint
  const [a, b] = await Promise.all([frameOf('tiny', 48), frameOf('tiny', 48)]);
  expect(a.file).toBe(cache.path(keysOf('tiny')[1], 48));
  expect(b.file).toBe(a.file);
  expect(pool.stats().painted - before).toBe(1);
  const again = service.frame('tiny', 48, 'preview');
  expect(again.pending).toBeUndefined();
  expect(again.file).toBe(a.file);
  expect(pool.stats().painted - before).toBe(1);

  // over HTTP: the JPEG itself, immutable, tagged with its segment key
  const res = await fetch(`${srv.url}/api/frames/tiny/48.jpg`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/jpeg');
  expect(res.headers.get('etag')).toBe(`"${keysOf('tiny')[1]}"`);
  expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
  const jpeg = new Uint8Array(await res.arrayBuffer());
  expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
  expect(jpeg.length).toBeGreaterThan(10000);
  expect(pool.stats().painted - before).toBe(1);
  // a frame not painted yet is painted while the request waits
  const held = await fetch(`${srv.url}/api/frames/tiny/60.jpg?prio=prefetch`);
  expect(held.status).toBe(200);
  expect(pool.stats().painted - before).toBe(2);
}, T);

test('revising a chapter resets only that chapter\'s coverage; the other chapters stay cached (Review Focus 2)', async () => {
  const seen = [];
  const off = events.subscribe(e => { if (e.type === 'frames' && e.data.versionId === 'rev') seen.push({ at: Date.now(), ...e.data }); });
  try {
    await Promise.all([24, 25, 600, 601].map(i => frameOf('rev', i)));
    expect(service.coverage('rev')).toEqual({ total: N, ranges: [[24, 25], [600, 601]], broken: [] });
    const res = await fetch(`${srv.url}/api/coverage/rev`);
    expect(await res.json()).toEqual({ total: N, ranges: [[24, 25], [600, 601]], broken: [] });

    const keysBefore = keysOf('rev');
    db.writeFiles('rev', [{ path: 'ch/c02.js', content: fastChapter(2) + '\n// revised' }], { source: 'manual' });
    const keysAfter = keysOf('rev');
    expect(keysAfter[2]).not.toBe(keysBefore[2]);
    for (const n of [1, 3, 4, 5, 6, 7, 8, 9]) expect(keysAfter[n]).toBe(keysBefore[n]);
    expect(service.coverage('rev').ranges).toEqual([[24, 25]]);

    const before = pool.stats().painted;
    expect(service.frame('rev', 24).file).toBeDefined();   // still cached, no paint
    const repaint = service.frame('rev', 600);
    expect(repaint.pending).toBeDefined();
    expect((await repaint.pending).file).toBe(cache.path(keysAfter[2], 600));
    expect(pool.stats().painted - before).toBe(1);

    // frames events: the version's ranges, coalesced (at most one per 500 ms)
    await Bun.sleep(700);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1).ranges).toEqual([[24, 25], [600, 600]]);
    for (let k = 1; k < seen.length; k++) expect(seen[k].at - seen[k - 1].at).toBeGreaterThanOrEqual(450);
  } finally { off(); }
}, T);

test('the Original\'s curtain call records its CAST reads as dependencies; changing one of those chapters invalidates only the frames that read it', async () => {
  // t = 145 s: the whole cast bows (entries of chapters 2, 3, 4, 5 and 7); t = 140.625 s: only the shoggoth has run on
  // (chapter 2's); t = 153 s: the curtain, no guests; t = 138 s: chapter 8's basilisk puppet (chapter 4's).
  const [bows, runOn, curtain, puppet] = [3480, 3375, 3672, 3312];
  const results = await Promise.all([bows, runOn, curtain, puppet].map(i => frameOf('orig', i)));
  for (const r of results) expect(r.file).toBeDefined();
  const keys = keysOf('orig'), files = snapshotOf(db, 'orig').files;
  const depsOf = (n, i) => { const f = join(cache.path(keys[n], i).replace(/\.jpg$/, '.deps.json')); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
  expect(depsOf(9, bows)).toEqual(Object.fromEntries(['ch/c02_chorus1.js', 'ch/c03_takeoff.js', 'ch/c04_chorus2.js', 'ch/c05_obsolete.js', 'ch/c07_scale.js'].map(p => [p, files[p]])));
  expect(depsOf(9, runOn)).toEqual({ 'ch/c02_chorus1.js': files['ch/c02_chorus1.js'] });
  expect(depsOf(9, curtain)).toBeNull();
  expect(depsOf(8, puppet)).toEqual({ 'ch/c04_chorus2.js': files['ch/c04_chorus2.js'] });

  db.writeFiles('orig', [{ path: 'ch/c03_takeoff.js', content: db.getFile('orig', 'ch/c03_takeoff.js').content + '\n// revised' }], { source: 'manual' });
  const after = keysOf('orig'), shas = currentShas(snapshotOf(db, 'orig'));
  expect(after[9]).toBe(keys[9]);   // chapter 9's own key is unchanged…
  expect(cache.has(keys[9], bows, shas)).toBe(false);   // …but the bows read chapter 3's sydney
  expect(cache.has(keys[9], runOn, shas)).toBe(true);
  expect(cache.has(keys[9], curtain, shas)).toBe(true);
  expect(cache.has(keys[8], puppet, shas)).toBe(true);
  const ranges = service.coverage('orig').ranges;
  expect(ranges).toContainEqual([runOn, runOn]);
  expect(ranges.some(([a, b]) => a <= bows && bows <= b)).toBe(false);

  // Another version with the same chapter 9 (so the same segment key) but the old chapter 3, asking for a frame of the
  // bows (t = 146 s) at the same time: one paint can't serve both, so each gets a frame painted from its own files.
  db.remixVersion('original', { id: 'orig2' });
  expect(keysOf('orig2')[9]).toBe(keys[9]);
  const bow = 3504, before = pool.stats().painted;
  const both = await Promise.all(['orig', 'orig2'].map(v => frameOf(v, bow, 'prefetch')));
  expect(both.map(r => !!r.file)).toEqual([true, true]);
  expect(pool.stats().painted - before).toBe(2);
  // one frame file per segment and frame, so the last paint (whichever it was) is the one cached; the other version
  // doesn't take it for its own, over HTTP either
  const valid = ['orig', 'orig2'].filter(v => cache.has(keys[9], bow, currentShas(snapshotOf(db, v))));
  expect(valid).toHaveLength(1);
  const other = valid[0] === 'orig' ? 'orig2' : 'orig';
  expect(await service.read(other, bow)).toBeNull();
  expect((await service.read(valid[0], bow)).key).toBe(keys[9]);
  expect((await fetch(`${srv.url}/api/frames/${other}/${bow}.jpg`)).status).toBe(200);   // repainted for it
  expect(cache.has(keys[9], bow, currentShas(snapshotOf(db, other)))).toBe(true);
}, T);

test('reading a CAST entry nobody defined, or listing them, depends on the whole set of chapters', async () => {
  const [nine, eight] = [3500, 3100];
  for (const r of await Promise.all([nine, eight].map(i => frameOf('casty', i, 'prefetch')))) expect(r.file).toBeDefined();
  const keys = keysOf('casty'), shas = currentShas(snapshotOf(db, 'casty'));
  const deps = (n, i) => JSON.parse(readFileSync(cache.path(keys[n], i).replace(/\.jpg$/, '.deps.json'), 'utf8'));
  expect(deps(9, nine)).toEqual({ 'ch/c02.js': shas['ch/c02.js'], '*': shas['*'] });
  // listing them reads each listed entry's descriptor too, so chapter 2's guest counts as well
  expect(deps(8, eight)).toEqual({ 'ch/c02.js': shas['ch/c02.js'], '*': shas['*'] });
  // a new chapter could define what was missing: both frames go, while chapter 2's own frames don't depend on it
  expect((await frameOf('casty', 600, 'prefetch')).file).toBeDefined();
  db.writeFiles('casty', [{ path: 'ch/c05.js', content: fastChapter(5) }], { source: 'manual' });
  expect(keysOf('casty')[9]).toBe(keys[9]);
  expect(service.coverage('casty').ranges).toEqual([[600, 600]]);
}, T);

test('a chapter that throws, one that never finishes and one whose script throws while loading each break only their own segment', async () => {
  const t0 = Date.now();
  // (prefetch: several previews at once would supersede each other)
  const [loops, throws, failsToLoad, fine, alsoFine] = await Promise.all([1200, 600, 1500, 24, 1780].map(i => frameOf('bad', i, 'prefetch')));
  expect(loops.broken).toBe('painting frame 1200 took over 2 s');
  expect(throws.broken).toBe('chapter two is broken');
  expect(failsToLoad.broken).toContain('chapter four failed to load');
  expect(fine.file).toBeDefined();
  expect(alsoFine.file).toBeDefined();
  expect(Date.now() - t0).toBeLessThan(30000);

  // broken segments answer at once, without painting, until their key changes
  const before = pool.stats().painted + pool.stats().failures;
  expect(service.frame('bad', 601).broken).toContain('chapter two is broken');
  expect(service.frame('bad', 1201).broken).toContain('took over 2 s');
  const res = await fetch(`${srv.url}/api/frames/bad/601.jpg`);
  expect(res.status).toBe(409);
  expect((await res.json()).error).toContain('chapter two is broken');
  expect(pool.stats().painted + pool.stats().failures).toBe(before);
  expect(service.coverage('bad').broken.map(b => b.chapter)).toEqual([2, 3, 4]);

  // the pool still paints, the hung page replaced
  expect((await frameOf('bad', 25)).file).toBeDefined();
  expect((await frameOf('tiny', 100)).file).toBeDefined();

  // fixed, the chapter paints again
  db.writeFiles('bad', [{ path: 'ch/c02.js', content: fastChapter(2) }], { source: 'manual' });
  expect((await frameOf('bad', 601)).file).toBeDefined();
}, T);

test('rapid preview requests supersede each other: at most one queued per version, and the latest painted first (Review Focus 3)', async () => {
  const from = painted.length, requests = [];
  for (let i = 200; i < 250; i++) requests.push(service.frame('tiny', i, 'preview'));
  const queued = pool.stats().queued.filter(q => q.versionId === 'tiny' && q.prio === 'preview');
  expect(queued.length).toBeLessThanOrEqual(1);
  expect(queued[0]?.frame).toBe(249);
  const outcomes = await Promise.all(requests.map(r => r.pending));
  const frames = painted.slice(from).map(p => p.frame);
  expect(frames).toContain(249);
  expect(frames.length).toBeLessThanOrEqual(PAINTERS + 1);
  // the ones superseded answer at once, as "ask again", instead of waiting their turn
  expect(outcomes.filter(o => o.retry).length).toBe(50 - frames.length);
  expect(outcomes[49].file).toBeDefined();
}, T);

test('a render backlog delays a preview request by at most the frame being painted', async () => {
  // one painter, so the order is exact
  const onePainted = [];
  const one = createPool({ port, baseUrl: `http://localhost:${port}`, painters: 1,
    onPainted: p => { onePainted.push(p.frame); cache.put(p.key, p.frame, p.jpeg, p.deps); } });
  const svc = createFrameService({ db, cache, pool: one, events, root });
  try {
    const fill = svc.fillForRender('tiny', null, { from: 300, to: 319 });
    const preview = svc.frame('tiny', 400, 'preview');
    expect(one.stats().queued.filter(q => q.prio === 'render').length).toBe(19);   // one is already being painted
    await preview.pending;
    expect(onePainted.indexOf(400)).toBeLessThanOrEqual(1);
    const { files, release } = await fill;
    expect(files).toHaveLength(20);
    expect(onePainted.filter(i => i >= 300 && i < 320)).toHaveLength(20);
    // a fill pins its segments until released
    cache.clear();
    expect(files.every(f => existsSync(f))).toBe(true);
    expect(existsSync(cache.path(keysOf('rev')[1], 24))).toBe(false);
    release();
    // a fully cached range paints nothing
    const count = onePainted.length;
    (await svc.fillForRender('tiny', null, { from: 300, to: 319 })).release();
    expect(onePainted.length).toBe(count);
  } finally { await one.close(); }
}, T);

test('a request held past the hold time is answered 202, to be asked again', async () => {
  const app = createApp({ db, root, data, token, events, port, frames: service, frameHoldMs: 100 });
  const get = path => app.fetch(new Request(`http://localhost:${port}${path}`, { headers: { host: `localhost:${port}` } }));
  const res = await get('/api/frames/slow/48.jpg');
  expect(res.status).toBe(202);
  expect(res.headers.get('retry-after')).toBe('1');
  await Bun.sleep(3000);
  expect((await get('/api/frames/slow/48.jpg')).status).toBe(200);
}, T);

test('missing versions, chapters and frames are 404s', async () => {
  expect((await fetch(`${srv.url}/api/frames/partial/1500.jpg`)).status).toBe(404);
  expect((await fetch(`${srv.url}/api/frames/nope/10.jpg`)).status).toBe(404);
  expect((await fetch(`${srv.url}/api/frames/tiny/${N}.jpg`)).status).toBe(404);
  expect((await fetch(`${srv.url}/api/coverage/nope`)).status).toBe(404);
}, T);

test('the frame, coverage and cache routes are served on UI hosts only', async () => {
  const w0 = `w0.localhost:${port}`, headers = { origin: `http://localhost:${port}`, 'x-studio-token': token };
  for (const path of ['/api/frames/tiny/48.jpg', '/api/coverage/tiny', '/api/cache']) {
    expect((await at(w0, path)).status).toBe(404);
    expect((await at(`localhost:${port}`, path)).status).toBe(200);
  }
  expect((await at(w0, '/api/cache/clear', { method: 'POST', headers })).status).toBe(404);
}, T);

test('clearing the cache needs the token', async () => {
  const url = `${srv.url}/api/cache/clear`, origin = srv.url;
  expect((await fetch(url, { method: 'POST', headers: { origin } })).status).toBe(403);
  expect((await fetch(url, { method: 'POST', headers: { origin, 'x-studio-token': 'wrong' } })).status).toBe(403);
  expect(service.coverage('tiny').ranges.length).toBeGreaterThan(0);
  const info = await (await fetch(`${srv.url}/api/cache`)).json();
  expect(info.usedBytes).toBeGreaterThan(0);
  expect(info.capBytes).toBe(1e12);
  const res = await fetch(url, { method: 'POST', headers: { origin, 'x-studio-token': token } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ usedBytes: 0, capBytes: 1e12 });
  expect(service.coverage('tiny').ranges).toEqual([]);
}, T);
