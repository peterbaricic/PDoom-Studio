import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../studio/db.js';
import { serve } from '../studio/serve.js';
import { createApp } from '../studio/app.js';
import { createEvents } from '../studio/events.js';
import { snapshotOf } from '../studio/snapshot.js';
import { createCache } from '../studio/frames/cache.js';
import { createPool } from '../studio/frames/pool.js';
import { createFrameService } from '../studio/frames/service.js';
import { N, engineHash, segmentKeys, currentShas, depsHash } from '../studio/frames/keys.js';
import { CHAPTER_WINDOWS } from '../studio/storyboard.js';
import { tempDir, tempDefaultDb, captureHosts } from './helpers.js';

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
const until = async (check, ms = 20000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error('timed out waiting'); await Bun.sleep(100); } };
const at = (host, path, init = {}) => srv.app.fetch(new Request(`http://${host}${path}`, { ...init, headers: { host, ...init.headers } }));

let cap;
beforeAll(async () => {
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
  // CAST entries taken while loading: chapter 9 takes chapter 2's guest at load; chapter 5 wraps it at load, and
  // chapter 8 calls the wrapper while painting
  db.createVersion({ id: 'loadcast' });
  db.writeFiles('loadcast', [
    { path: 'ch/c02.js', content: "CAST.guest = () => 1;\n" + fastChapter(2) },
    { path: 'ch/c05.js', content: "{ const g = CAST.guest; CAST.wrapper = () => g(); }\n" + fastChapter(5) },
    { path: 'ch/c08.js', content: fastChapter(8, 'CAST.wrapper();') },
    { path: 'ch/c09.js', content: "const { guest } = CAST;\n" + fastChapter(9, 'guest();') },
  ], { source: 'manual' });
  // a chapter whose script never finishes loading
  db.createVersion({ id: 'hangload' });
  db.writeFiles('hangload', [
    { path: 'ch/c01.js', content: fastChapter(1) },
    { path: 'ch/c03.js', content: 'for (;;) {}' },
  ], { source: 'manual' });
  // a version whose page can't load (chapter 5 declares a load error), and one sharing its chapter 1 that can
  db.createVersion({ id: 'sabotaged' });
  db.writeFiles('sabotaged', [{ path: 'ch/c01.js', content: fastChapter(1) }, { path: 'ch/c05.js', content: "window.loadError = 'sabotaged';" }], { source: 'manual' });
  db.createVersion({ id: 'sound' });
  db.writeFiles('sound', [{ path: 'ch/c01.js', content: fastChapter(1) }], { source: 'manual' });
  // a chapter that tries to reach other hosts, while loading and while painting
  cap = await captureHosts(['fetch', 'image', 'open', 'link', 'beacon']);
  const leak = when => `fetch('${cap.url('fetch')}/${when}', { mode: 'no-cors' }).catch(() => {});
    new Image().src = '${cap.url('image')}/${when}';
    try { document.open('${cap.url('open')}/${when}', '_blank', ''); } catch {}
    { const a = document.createElement('a'); a.href = '${cap.url('link')}/${when}'; a.target = '_blank'; document.body.append(a); a.click(); }
    try { navigator.sendBeacon('${cap.url('beacon')}/${when}', 'x'); } catch {}`;
  db.createVersion({ id: 'leaky' });
  db.writeFiles('leaky', [{ path: 'ch/c01.js', content: leak('load') + '\n' + fastChapter(1, leak('paint')) }], { source: 'manual' });

  port = freePort();
  events = createEvents();
  cache = createCache({ dir: join(data, '.studio/cache/frames'), capBytes: 1e12 });
  pool = createPool({ port, baseUrl: `http://localhost:${port}`, painters: PAINTERS, paintTimeoutMs: 2000, brokenTtlMs: 4000,
    onPainted: p => { painted.push(p); cache.put(p.key, p.frame, p.jpeg, p.deps); } });
  service = createFrameService({ db, cache, pool, events, root });
  srv = serve({ db, root, data, token, events, port, frames: service });
});
afterAll(async () => { await pool?.close(); srv?.stop(); cap?.stop(); });

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

  // over HTTP: the JPEG itself, revalidated on every use, tagged with its content (segment key and dependencies)
  const res = await fetch(`${srv.url}/api/frames/tiny/48.jpg`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/jpeg');
  expect(res.headers.get('etag')).toBe(`"${keysOf('tiny')[1]}.-"`);
  expect(res.headers.get('cache-control')).toBe('private, no-cache');
  const same = await fetch(`${srv.url}/api/frames/tiny/48.jpg`, { headers: { 'if-none-match': res.headers.get('etag') } });
  expect(same.status).toBe(304);
  expect(same.headers.get('etag')).toBe(res.headers.get('etag'));
  const jpeg = new Uint8Array(await res.arrayBuffer());
  expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
  expect(jpeg.length).toBeGreaterThan(10000);
  expect(pool.stats().painted - before).toBe(1);
  // a frame not painted yet is painted while the request waits
  const held = await fetch(`${srv.url}/api/frames/tiny/60.jpg?prio=prefetch`);
  expect(held.status).toBe(200);
  expect(pool.stats().painted - before).toBe(2);
  // a frame file deleted behind the cache's back is painted again, not answered 202 for ever
  const shas = currentShas(snapshotOf(db, 'tiny')), used = cache.usedBytes();
  rmSync(cache.find(keysOf('tiny')[1], 60, shas).path);
  const repainted = await fetch(`${srv.url}/api/frames/tiny/60.jpg`);
  expect(repainted.status).toBe(200);
  expect(pool.stats().painted - before).toBe(3);
  expect(existsSync(cache.find(keysOf('tiny')[1], 60, shas).path)).toBe(true);
  expect(Math.abs(cache.usedBytes() - used)).toBeLessThan(used / 100);
}, T);

test('revising a chapter resets only that chapter\'s coverage; the other chapters stay cached (Review Focus 2)', async () => {
  const seen = [];
  const off = events.subscribe(e => { if (e.type === 'frames' && e.data.versionId === 'rev') seen.push({ at: Date.now(), ...e.data }); });
  try {
    await Promise.all([24, 25, 600, 601].map(i => frameOf('rev', i, 'prefetch')));   // (previews would supersede each other)
    // coverage names each chapter's segment key, so the player can tell when a chapter's frames change
    const keysBefore = keysOf('rev');
    expect(service.coverage('rev')).toEqual({ total: N, ranges: [[24, 25], [600, 601]], broken: [], segments: keysBefore });
    const res = await fetch(`${srv.url}/api/coverage/rev`);
    expect(await res.json()).toEqual({ total: N, ranges: [[24, 25], [600, 601]], broken: [], segments: keysBefore });
    expect(Object.keys(keysBefore)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);

    db.writeFiles('rev', [{ path: 'ch/c02.js', content: fastChapter(2) + '\n// revised' }], { source: 'manual' });
    const keysAfter = keysOf('rev');
    expect(keysAfter[2]).not.toBe(keysBefore[2]);
    for (const n of [1, 3, 4, 5, 6, 7, 8, 9]) expect(keysAfter[n]).toBe(keysBefore[n]);
    expect(service.coverage('rev').ranges).toEqual([[24, 25]]);
    expect(service.coverage('rev').segments).toEqual(keysAfter);
    // a chapter the version doesn't have is null
    expect(service.coverage('partial').segments).toEqual(keysOf('partial'));
    expect(service.coverage('partial').segments[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(service.coverage('partial').segments[9]).toBeNull();

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
    expect(seen.at(-1).segments).toEqual(keysAfter);
    for (let k = 1; k < seen.length; k++) expect(seen[k].at - seen[k - 1].at).toBeGreaterThanOrEqual(450);
  } finally { off(); }
}, T);

test('the Original\'s curtain call records its CAST reads as dependencies; changing one of those chapters invalidates only the frames that read it', async () => {
  // t = 145 s: the whole cast bows (entries of chapters 2, 3, 4, 5 and 7); t = 140.625 s: only the shoggoth has run on
  // (chapter 2's); t = 153 s: the curtain, no guests; t = 138 s: chapter 8's basilisk puppet (chapter 4's).
  const [bows, runOn, curtain, puppet] = [3480, 3375, 3672, 3312];
  const results = await Promise.all([bows, runOn, curtain, puppet].map(i => frameOf('orig', i, 'prefetch')));
  for (const r of results) expect(r.file).toBeDefined();
  const keys = keysOf('orig'), files = snapshotOf(db, 'orig').files, shasBefore = currentShas(snapshotOf(db, 'orig'));
  const depsOf = (n, i) => { const f = cache.find(keys[n], i, shasBefore).path.replace(/\.jpg$/, '.deps.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
  const bowsDeps = Object.fromEntries(['ch/c02_chorus1.js', 'ch/c03_takeoff.js', 'ch/c04_chorus2.js', 'ch/c05_obsolete.js', 'ch/c07_scale.js'].map(p => [p, files[p]]));
  expect(depsOf(9, bows)).toEqual(bowsDeps);
  expect(depsOf(9, runOn)).toEqual({ 'ch/c02_chorus1.js': files['ch/c02_chorus1.js'] });
  expect(depsOf(9, curtain)).toBeNull();
  expect(depsOf(8, puppet)).toEqual({ 'ch/c04_chorus2.js': files['ch/c04_chorus2.js'] });
  const etagOf = async i => (await fetch(`${srv.url}/api/frames/orig/${i}.jpg`)).headers.get('etag');
  const [bowsTag, curtainTag] = [await etagOf(bows), await etagOf(curtain)];
  expect(bowsTag).toBe(`"${keys[9]}.${depsHash(bowsDeps)}"`);
  expect(curtainTag).toBe(`"${keys[9]}.-"`);

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
  // a browser holding the old frame asks again and gets the new one; the curtain it may keep
  const fresh = await fetch(`${srv.url}/api/frames/orig/${bows}.jpg`, { headers: { 'if-none-match': bowsTag } });
  expect(fresh.status).toBe(200);
  expect(fresh.headers.get('etag')).not.toBe(bowsTag);
  expect(fresh.headers.get('etag')).toStartWith(`"${keys[9]}.`);
  expect((await fresh.arrayBuffer()).byteLength).toBeGreaterThan(10000);
  expect((await fetch(`${srv.url}/api/frames/orig/${curtain}.jpg`, { headers: { 'if-none-match': curtainTag } })).status).toBe(304);

  // Another version with the same chapter 9 (so the same segment key) but the old chapter 3, asking for a frame of the
  // bows (t = 146 s) at the same time: one paint can't serve both, so each gets a frame painted from its own files,
  // kept side by side.
  db.remixVersion('original', { id: 'orig2' });
  expect(keysOf('orig2')[9]).toBe(keys[9]);
  const bow = 3504, before = pool.stats().painted;
  const both = await Promise.all(['orig', 'orig2'].map(v => frameOf(v, bow, 'prefetch')));
  expect(both.map(r => !!r.file)).toEqual([true, true]);
  expect(both[0].file).not.toBe(both[1].file);
  expect(pool.stats().painted - before).toBe(2);
  for (const [k, v] of ['orig', 'orig2'].entries()) {
    expect(cache.find(keys[9], bow, currentShas(snapshotOf(db, v))).path).toBe(both[k].file);
    const deps = JSON.parse(readFileSync(both[k].file.replace(/\.jpg$/, '.deps.json'), 'utf8'));
    expect(deps['ch/c03_takeoff.js']).toBe(snapshotOf(db, v).files['ch/c03_takeoff.js']);
    const got = await fetch(`${srv.url}/api/frames/${v}/${bow}.jpg`);
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer())).toEqual(readFileSync(both[k].file));
  }
  expect(pool.stats().painted - before).toBe(2);
}, T);

test('CAST entries a chapter takes while loading are dependencies of its frames, through wrappers too', async () => {
  const [nine, eight, two] = [3500, 3100, 600];
  for (const r of await Promise.all([nine, eight, two].map(i => frameOf('loadcast', i, 'prefetch')))) expect(r.file).toBeDefined();
  const keys = keysOf('loadcast'), shas = currentShas(snapshotOf(db, 'loadcast'));
  const deps = (n, i) => JSON.parse(readFileSync(cache.find(keys[n], i, shas).path.replace(/\.jpg$/, '.deps.json'), 'utf8'));
  expect(deps(9, nine)).toEqual({ 'ch/c02.js': shas['ch/c02.js'] });
  expect(deps(8, eight)).toEqual({ 'ch/c05.js': shas['ch/c05.js'], 'ch/c02.js': shas['ch/c02.js'] });
  // revising the chapter that defined the guest: frames that took it, directly or wrapped, go; its own stay
  db.writeFiles('loadcast', [{ path: 'ch/c02.js', content: "CAST.guest = () => 2;\n" + fastChapter(2) }], { source: 'manual' });
  const now = currentShas(snapshotOf(db, 'loadcast'));
  expect(keysOf('loadcast')[9]).toBe(keys[9]);
  expect(cache.has(keys[9], nine, now)).toBe(false);
  expect(cache.has(keys[8], eight, now)).toBe(false);
  expect(service.coverage('loadcast').ranges).toEqual([]);   // chapter 2's own key changed, the rest depended on it
}, T);

test('reading a CAST entry nobody defined, or listing them, depends on the whole set of chapters', async () => {
  const [nine, eight] = [3500, 3100];
  for (const r of await Promise.all([nine, eight].map(i => frameOf('casty', i, 'prefetch')))) expect(r.file).toBeDefined();
  const keys = keysOf('casty'), shas = currentShas(snapshotOf(db, 'casty'));
  const deps = (n, i) => JSON.parse(readFileSync(cache.find(keys[n], i, shas).path.replace(/\.jpg$/, '.deps.json'), 'utf8'));
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

  // a timeout might be a one-off: it's tried again once brokenTtlMs (4 s here) has passed; the chapter's own error stays
  await until(() => !service.frame('bad', 1201, 'prefetch').broken, 10000);
  expect(service.frame('bad', 601).broken).toBe('chapter two is broken');
  expect((await frameOf('bad', 1201, 'prefetch')).broken).toBe('painting frame 1201 took over 2 s');

  // fixed, the chapter paints again
  db.writeFiles('bad', [{ path: 'ch/c02.js', content: fastChapter(2) }], { source: 'manual' });
  expect((await frameOf('bad', 601)).file).toBeDefined();
}, T);

test('a chapter that never finishes loading breaks only itself, fails fast after that, and holds no more than one page', async () => {
  // a pool of its own, with a short load timeout (the shared one keeps the default, so a slow machine's loads aren't
  // taken for hangs)
  const own = createPool({ port, baseUrl: `http://localhost:${port}`, painters: PAINTERS, loadTimeoutMs: 5000,
    onPainted: p => cache.put(p.key, p.frame, p.jpeg, p.deps) });
  const svc = createFrameService({ db, cache, pool: own, events, root });
  const get = async (v, i, prio = 'prefetch') => { const r = svc.frame(v, i, prio); return r.pending ? r.pending : r; };
  try {
    const t0 = Date.now();
    // more requests for the snapshot than there are painters, queued in one go (a prefetch run, then one more)
    expect(svc.prefetch('hangload', 1200, 6)).toBe(6);
    const hangs = get('hangload', 1206), fine = get('hangload', 24, 'render');
    // its first load runs alone, on one page
    await until(() => own.stats().loads > 0);
    await Bun.sleep(500);
    expect(own.stats().loads).toBe(1);
    expect(own.stats().painting).toBe(1);
    // meanwhile another version's preview paints: the hanging load holds one page, not every one
    const p0 = Date.now();
    expect((await get('tiny', 130, 'preview')).file).toBeDefined();
    expect(Date.now() - p0).toBeLessThan(4000);
    expect((await hangs).broken).toBe('chapter 3 did not finish loading within 5 s');
    // the version's other chapters load without it and paint
    expect((await fine).file).toBeDefined();
    expect(Date.now() - t0).toBeLessThan(30000);
    // and from now on the chapter fails at once, without loading a page
    const loads = own.stats().loads, t1 = Date.now();
    expect((await get('hangload', 1201)).broken).toBe('chapter 3 did not finish loading within 5 s');
    expect(svc.frame('hangload', 1202).broken).toBe('chapter 3 did not finish loading within 5 s');
    expect(Date.now() - t1).toBeLessThan(500);
    expect(own.stats().loads).toBe(loads);
    expect(svc.coverage('hangload').broken).toEqual([{ chapter: 3, error: 'chapter 3 did not finish loading within 5 s' }]);
  } finally { await own.close(); }
}, T);

test('a version whose page fails to load fails on its own, not other versions sharing its segments', async () => {
  expect(keysOf('sound')[1]).toBe(keysOf('sabotaged')[1]);
  // (chapter 1 is the same as other versions' here, so frames other tests painted are cached for it already: these
  // two aren't)
  expect((await frameOf('sabotaged', 70, 'prefetch')).broken).toBe('sabotaged');
  expect(service.frame('sabotaged', 71).broken).toBe('sabotaged');
  expect(service.coverage('sabotaged').broken).toEqual([1, 5].map(chapter => ({ chapter, error: 'sabotaged' })));
  expect((await frameOf('sound', 70, 'prefetch')).file).toBeDefined();
  expect(service.coverage('sound').broken).toEqual([]);
  // what's cached for it (painted for the other version) is still served meanwhile
  expect(service.frame('sabotaged', 70).file).toBeDefined();
}, T);

test('a chapter cannot reach another host from a painting page, while loading or painting', async () => {
  expect((await frameOf('leaky', 30, 'prefetch')).file).toBeDefined();
  await Bun.sleep(1500);
  expect(cap.hits).toEqual({});
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
    // a request withdrawn (its client gone) leaves the queue at once
    const withdraw = new AbortController();
    const gone = svc.frame('tiny', 410, 'prefetch', { signal: withdraw.signal });
    expect(one.stats().queued.some(q => q.frame === 410)).toBe(true);
    withdraw.abort();
    expect(one.stats().queued.some(q => q.frame === 410)).toBe(false);
    expect((await gone.pending).retry).toBe('cancelled');
    // prefetch queues are bounded per version: the newest 240 stay
    const many = Array.from({ length: 300 }, (_, k) => svc.frame('tiny', 1000 + k, 'prefetch'));
    const queuedPrefetch = one.stats().queued.filter(q => q.prio === 'prefetch' && q.versionId === 'tiny');
    expect(queuedPrefetch).toHaveLength(240);
    expect(Math.min(...queuedPrefetch.map(q => q.frame))).toBe(1060);
    expect((await many[0].pending).retry).toContain('superseded');
    svc.prefetch('tiny', 0, 0);   // drops the version's queued prefetch again
    // a prefetch run longer than the cap keeps the frames nearest where it starts (the playhead)
    expect(svc.prefetch('tiny', 1500, 300)).toBe(300);
    const kept = one.stats().queued.filter(q => q.prio === 'prefetch' && q.versionId === 'tiny').map(q => q.frame);
    expect(kept).toHaveLength(240);
    expect([Math.min(...kept), Math.max(...kept)]).toEqual([1500, 1739]);
    svc.prefetch('tiny', 0, 0);
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

test('a paint-ahead sweep paints at the lowest priority, a few frames queued at a time, and a new one re-aims it', async () => {
  // one painter, so the order is exact
  const order = [];
  const one = createPool({ port, baseUrl: `http://localhost:${port}`, painters: 1,
    onPainted: p => { order.push(p.frame); cache.put(p.key, p.frame, p.jpeg, p.deps); } });
  const svc = createFrameService({ db, cache, pool: one, events, root });
  const bg = () => one.stats().queued.filter(q => q.prio === 'background').map(q => q.frame);
  try {
    expect(svc.paintAhead('tiny', 2400)).toEqual({ from: 2400, end: N });
    expect(bg().length).toBeLessThanOrEqual(6);   // bounded: not the 1359 frames to the end
    await until(() => order.length >= 1);
    // everything else goes first: a render fill, thumbs, prefetch and a preview queued after it
    const fill = svc.fillForRender('tiny', null, { from: 2600, to: 2609 });
    const via = (i, prio) => { const r = svc.frame('tiny', i, prio); return r.pending ?? r; };
    const thumbs = via(2700, 'thumbs');
    const prefetch = via(2800, 'prefetch');
    const preview = via(2900, 'preview');
    const queuedAt = order.length;   // plus the one frame being painted then, which may be the sweep's
    await Promise.all([fill.then(f => f.release()), thumbs, prefetch, preview]);
    const started = order.length;
    await until(() => order.length >= started + 3);
    const at = f => order.indexOf(f);
    const others = [2600, 2601, 2602, 2603, 2604, 2605, 2606, 2607, 2608, 2609, 2700, 2800, 2900];
    const sweepAfter = order.map((f, k) => (k > queuedAt && f >= 2400 && f < 2600 ? k : -1)).filter(k => k >= 0);
    expect(sweepAfter.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...others.map(at))).toBeLessThan(Math.min(...sweepAfter));
    expect(at(2900)).toBeLessThan(at(2800));   // preview, then prefetch,
    expect(at(2800)).toBeLessThan(at(2600));   // then render,
    expect(Math.max(...others.slice(0, 10).map(at))).toBeLessThan(at(2700));   // then thumbs
    // the sweep goes on after them, in order, and is still bounded
    expect(order.slice(started).every(f => f > 2400 && f < 2600)).toBe(true);
    expect(bg().length).toBeLessThanOrEqual(6);
    // a new sweep replaces it
    svc.paintAhead('tiny', 3700);
    await until(() => bg().length > 0 && bg().every(f => f >= 3700));
    const count = order.length;
    await until(() => order.length >= count + 2);
    expect(order.slice(count + 1).every(f => f >= 3700)).toBe(true);
  } finally { await one.close(); }
}, T);

test('a paint-ahead sweep stops at the first chapter that is not written or is broken', async () => {
  db.createVersion({ id: 'sweepy' });
  db.writeFiles('sweepy', [
    { path: 'ch/c01.js', content: fastChapter(1) },
    { path: 'ch/c02.js', content: "chapter('c2', 23, 38.5, [[23, t => { throw new Error('two'); }]]);" },
    { path: 'ch/c04.js', content: fastChapter(4) },
  ], { source: 'manual' });
  expect(service.paintAhead('sweepy', 1500)).toEqual({ from: 1500, end: 1752 });   // chapter 5 isn't written
  expect(service.paintAhead('sweepy', 1000)).toEqual({ from: 1000, end: 1000 });   // nor chapter 3
  expect((await frameOf('sweepy', 600)).broken).toBe('two');
  expect(service.paintAhead('sweepy', 100)).toEqual({ from: 100, end: 552 });      // chapter 2 is broken
  expect(service.paintAhead('sweepy', 600)).toEqual({ from: 600, end: 600 });
  expect(service.paintAhead('nope', 0)).toBeNull();
  await until(() => !pool.stats().queued.some(q => q.prio === 'background'), 60000);
}, T);

test('POST /api/frames/<v>/paint-ahead: UI hosts, the token, a known version and a frame index', async () => {
  const post = (body, { host = `localhost:${port}`, tok = token, id = 'tiny' } = {}) => at(host, `/api/frames/${id}/paint-ahead`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { origin: `http://localhost:${port}`, 'content-type': 'application/json', ...(tok && { 'x-studio-token': tok }) },
  });
  expect((await post({ from: 3740 }, { tok: null })).status).toBe(403);
  expect((await post({ from: 3740 }, { host: `w0.localhost:${port}` })).status).toBe(404);
  expect((await post({ from: 3740 }, { id: 'nope' })).status).toBe(404);
  for (const from of [-1, N, 1.5, '12', null]) expect((await post({ from })).status).toBe(400);
  const res = await post({ from: 3740 });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ from: 3740, end: N });
  await until(() => service.coverage('tiny').ranges.some(([a, b]) => a <= 3740 && b >= 3758), 60000);
}, T);

test('a request held past the hold time is answered 202, to be asked again', async () => {
  const app = createApp({ db, root, data, token, events, port, frames: service, frameHoldMs: 100 });
  const get = path => app.fetch(new Request(`http://localhost:${port}${path}`, { headers: { host: `localhost:${port}` } }));
  const res = await get('/api/frames/slow/48.jpg');
  expect(res.status).toBe(202);
  expect(res.headers.get('retry-after')).toBe('1');
  // painting went on (the request was already being painted): asked again, it's there
  await until(async () => (await get('/api/frames/slow/48.jpg')).status === 200);
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
