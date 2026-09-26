import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, existsSync, rmSync, mkdirSync, cpSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../studio/db.js';
import { serve } from '../studio/serve.js';
import { createApp } from '../studio/app.js';
import { createEvents } from '../studio/events.js';
import { snapshotOf, rememberSnapshot } from '../studio/snapshot.js';
import { createCache } from '../studio/frames/cache.js';
import { createPool } from '../studio/frames/pool.js';
import { createFrameService } from '../studio/frames/service.js';
import { launchBrowser } from '../studio/browser.js';
import { N, engineHash, segmentKeys, currentShas, depsHash } from '../studio/frames/keys.js';
import { CHAPTER_WINDOWS } from '../studio/storyboard.js';
import { tempDir, tempDefaultDb, captureHosts, slowTest } from './helpers.js';

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
// The frame and coverage routes answer only with the token (studio/http.js), as the studio page sends it.
const fetchT = (url, init = {}) => fetch(url, { ...init, headers: { 'x-studio-token': token, ...init.headers } });
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
  // a chapter that never finishes painting, on its own (the timeout-break clock test)
  db.createVersion({ id: 'spin' });
  db.writeFiles('spin', [{ path: 'ch/c06.js', content: "chapter('c6', 95.4, 109.4, [[95.4, t => { for (;;) {} }]]);" }], { source: 'manual' });
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

slowTest('a frame is painted once, then served from the cache', async () => {
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
  const res = await fetchT(`${srv.url}/api/frames/tiny/48.jpg`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/jpeg');
  expect(res.headers.get('etag')).toBe(`"${keysOf('tiny')[1]}.-"`);
  expect(res.headers.get('cache-control')).toBe('private, no-cache');
  const same = await fetchT(`${srv.url}/api/frames/tiny/48.jpg`, { headers: { 'if-none-match': res.headers.get('etag') } });
  expect(same.status).toBe(304);
  expect(same.headers.get('etag')).toBe(res.headers.get('etag'));
  const jpeg = new Uint8Array(await res.arrayBuffer());
  expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
  expect(jpeg.length).toBeGreaterThan(10000);
  expect(pool.stats().painted - before).toBe(1);
  // a frame not painted yet is painted while the request waits
  const held = await fetchT(`${srv.url}/api/frames/tiny/60.jpg?prio=prefetch`);
  expect(held.status).toBe(200);
  expect(pool.stats().painted - before).toBe(2);
  // a frame file deleted behind the cache's back is painted again, not answered 202 for ever
  const shas = currentShas(snapshotOf(db, 'tiny')), used = cache.usedBytes();
  rmSync(cache.find(keysOf('tiny')[1], 60, shas).path);
  const repainted = await fetchT(`${srv.url}/api/frames/tiny/60.jpg`);
  expect(repainted.status).toBe(200);
  expect(pool.stats().painted - before).toBe(3);
  expect(existsSync(cache.find(keysOf('tiny')[1], 60, shas).path)).toBe(true);
  expect(Math.abs(cache.usedBytes() - used)).toBeLessThan(used / 100);
}, T);

slowTest('revising a chapter resets only that chapter\'s coverage; the other chapters stay cached (Review Focus 2)', async () => {
  const seen = [];
  const off = events.subscribe(e => { if (e.type === 'frames' && e.data.versionId === 'rev') seen.push({ at: Date.now(), ...e.data }); });
  try {
    await Promise.all([24, 25, 600, 601].map(i => frameOf('rev', i, 'prefetch')));   // (previews would supersede each other)
    // coverage names each chapter's segment key, so the player can tell when a chapter's frames change
    const keysBefore = keysOf('rev');
    expect(service.coverage('rev')).toEqual({ total: N, ranges: [[24, 25], [600, 601]], broken: [], segments: keysBefore });
    const res = await fetchT(`${srv.url}/api/coverage/rev`);
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

slowTest('the Original\'s curtain call records its CAST reads as dependencies; changing one of those chapters invalidates only the frames that read it', async () => {
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
  const etagOf = async i => (await fetchT(`${srv.url}/api/frames/orig/${i}.jpg`)).headers.get('etag');
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
  const fresh = await fetchT(`${srv.url}/api/frames/orig/${bows}.jpg`, { headers: { 'if-none-match': bowsTag } });
  expect(fresh.status).toBe(200);
  expect(fresh.headers.get('etag')).not.toBe(bowsTag);
  expect(fresh.headers.get('etag')).toStartWith(`"${keys[9]}.`);
  expect((await fresh.arrayBuffer()).byteLength).toBeGreaterThan(10000);
  expect((await fetchT(`${srv.url}/api/frames/orig/${curtain}.jpg`, { headers: { 'if-none-match': curtainTag } })).status).toBe(304);

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
    const got = await fetchT(`${srv.url}/api/frames/${v}/${bow}.jpg`);
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer())).toEqual(readFileSync(both[k].file));
  }
  expect(pool.stats().painted - before).toBe(2);
}, T);

slowTest('CAST entries a chapter takes while loading are dependencies of its frames, through wrappers too', async () => {
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

slowTest('reading a CAST entry nobody defined, or listing them, depends on the whole set of chapters', async () => {
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

slowTest('a chapter that throws, one that never finishes and one whose script throws while loading each break only their own segment', async () => {
  // A timeout's break lasts brokenTtlMs (4 s here) from when its answer arrives, so it's looked at right then: the
  // other four requests can finish any time later (a slow machine loads and paints slowly; the timeout is wall-clock).
  let loopingNow, coverageNow;
  const whenLoopsAnswers = r => { loopingNow = service.frame('bad', 1201, 'prefetch'); coverageNow = service.coverage('bad'); return r; };
  // (prefetch: several previews at once would supersede each other)
  const [loops, throws, failsToLoad, fine, alsoFine] = await Promise.all([1200, 600, 1500, 24, 1780]
    .map(i => i === 1200 ? frameOf('bad', i, 'prefetch').then(whenLoopsAnswers) : frameOf('bad', i, 'prefetch')));
  expect(loops.broken).toBe('painting frame 1200 took over 2 s');
  // then another frame of that chapter answered broken at once, without painting
  expect(loopingNow.broken).toBe('painting frame 1200 took over 2 s');
  expect(loopingNow.pending).toBeUndefined();
  expect(coverageNow.broken.map(b => b.chapter)).toContain(3);
  expect(throws.broken).toBe('chapter two is broken');
  expect(failsToLoad.broken).toContain('chapter four failed to load');
  expect(fine.file).toBeDefined();
  expect(alsoFine.file).toBeDefined();
  // (No wall-clock bound on all this: the looping chapter's answer above is the 2 s paint timeout's own, and a busy
  // machine can take any time over the others.)

  // a chapter's own errors answer at once, without painting, until their key changes
  const before = pool.stats().painted + pool.stats().failures;
  expect(service.frame('bad', 601).broken).toContain('chapter two is broken');
  expect(service.frame('bad', 1501).broken).toContain('chapter four failed to load');
  const res = await fetchT(`${srv.url}/api/frames/bad/601.jpg`);
  expect(res.status).toBe(409);
  expect((await res.json()).error).toContain('chapter two is broken');
  expect(pool.stats().painted + pool.stats().failures).toBe(before);
  // (chapter 3's break may have run out by now, however long the others took)
  expect(service.coverage('bad').broken.map(b => b.chapter).filter(n => n !== 3)).toEqual([2, 4]);

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

slowTest('a frame drawn by another chapter\'s registration (one reaching past its own window) breaks its segment for a while, with a clear error', async () => {
  // chapter 2 reaches 1.5 s into chapter 3's window: the frames there are keyed under chapter 3, but chapter 2 draws them
  db.createVersion({ id: 'overrun' });
  db.writeFiles('overrun', [
    { path: 'ch/c02.js', content: fastChapter(2).replace(', 38.5, [[', ', 40, [[') },
    { path: 'ch/c03.js', content: fastChapter(3) },
  ], { source: 'manual' });
  const into3 = 930;   // 38.75 s
  const r = await frameOf('overrun', into3, 'prefetch');
  expect(r.broken).toBe("frame 930 was drawn by ch/c02.js, not by chapter 3: a chapter() window reaches into chapter 3's 38.5–59 s");
  expect(service.coverage('overrun').broken).toEqual([{ chapter: 3, error: r.broken, until: expect.any(Number) }]);
  expect(existsSync(cache.path(keysOf('overrun')[3], into3))).toBe(false);   // never cached under chapter 3's key
  // chapter 2's own frames are fine; chapter 3's past the overrun too, once the break has run out (4 s here)
  expect((await frameOf('overrun', 600, 'prefetch')).file).toBeDefined();
  await until(() => !service.frame('overrun', 1000, 'prefetch').broken, 10000);
  expect((await frameOf('overrun', 1000, 'prefetch')).file).toBeDefined();
}, T);

slowTest('a chapter that never finishes painting holds one painter only: the other chapters\' frames are answered first', async () => {
  // (options of its own, so none of these frames is cached by the tests above)
  db.createVersion({ id: 'wedge', options: { wipes: false } });
  db.writeFiles('wedge', [{ path: 'ch/c01.js', content: fastChapter(1) }, { path: 'ch/c03.js', content: "chapter('c3', 38.5, 59, [[38.5, t => { for (;;) {} }]]);" },
    { path: 'ch/c05.js', content: fastChapter(5) }], { source: 'manual' });
  expect((await frameOf('wedge', 24, 'prefetch')).file).toBeDefined();   // the snapshot's first load, done alone
  const order = [];
  const ask = (i, label) => frameOf('wedge', i, 'prefetch').then(r => { order.push(label); return r; });
  // the looping frame asked for first, then four that paint in milliseconds
  const [loops, ...fine] = await Promise.all([ask(1200, 'loops'), ask(25, 'fine'), ask(26, 'fine'), ask(1780, 'fine'), ask(1781, 'fine')]);
  expect(loops.broken).toBe('painting frame 1200 took over 2 s');
  for (const r of fine) expect(r.file).toBeDefined();
  expect(order).toEqual(['fine', 'fine', 'fine', 'fine', 'loops']);
}, T);

slowTest('a paint that times out stays broken for brokenTtlMs from when its answer arrives, not from the timeout', async () => {
  // Closing the stuck page comes first (Chrome takes about half a second to end a looping renderer here, up to the 5 s
  // closePage allows); that time used to come off the break, so a slow close could hand over a break already over.
  const snap = snapshotOf(db, 'spin');
  rememberSnapshot(snap);
  const r = await pool.request({ versionId: 'spin', snapshotId: snap.id, key: keysOf('spin')[6], frame: 2400, prio: 'prefetch', currentShas: currentShas(snap) });
  const left = r.until - Date.now();
  expect(r).toMatchObject({ ok: false, broken: true, error: 'painting frame 2400 took over 2 s' });
  expect(left).toBeGreaterThan(4000 - 100);
  expect(left).toBeLessThanOrEqual(4000);
}, T);

slowTest('a chapter that never finishes loading breaks only itself, fails fast after that, and holds no more than one page', async () => {
  // a pool of its own, with a short load timeout (the shared one keeps the default, so a slow machine's loads aren't
  // taken for hangs)
  const own = createPool({ port, baseUrl: `http://localhost:${port}`, painters: PAINTERS, loadTimeoutMs: 5000,
    onPainted: p => cache.put(p.key, p.frame, p.jpeg, p.deps) });
  const svc = createFrameService({ db, cache, pool: own, events, root });
  const get = async (v, i, prio = 'prefetch') => { const r = svc.frame(v, i, prio); return r.pending ? r.pending : r; };
  try {
    // more requests for the snapshot than there are painters, queued in one go (a prefetch run, then one more)
    expect(svc.prefetch('hangload', 1200, 6)).toBe(6);
    const hangs = get('hangload', 1206), fine = get('hangload', 24, 'render');
    let hangAnswered = false;
    hangs.then(() => { hangAnswered = true; });
    // its first load runs alone, on one page
    await until(() => own.stats().loads > 0);
    await Bun.sleep(500);
    expect(own.stats().loads).toBe(1);
    expect(own.stats().painting).toBe(1);
    // meanwhile another version's preview paints: the hanging load holds one page, not every one, so the preview is
    // answered while that load still hangs (were every page held, it would be answered only once the load timed out)
    expect((await get('tiny', 130, 'preview')).file).toBeDefined();
    expect(hangAnswered).toBe(false);
    expect((await hangs).broken).toBe('chapter 3 did not finish loading within 5 s');
    // the version's other chapters load without it and paint
    expect((await fine).file).toBeDefined();
    // and from now on the chapter fails at once, without loading a page: answered broken there and then, not pending
    const loads = own.stats().loads;
    for (const i of [1201, 1202]) {
      const r = svc.frame('hangload', i);
      expect([i, r.pending, r.broken]).toEqual([i, undefined, 'chapter 3 did not finish loading within 5 s']);
    }
    expect(own.stats().loads).toBe(loads);
    expect(svc.coverage('hangload').broken).toEqual([{ chapter: 3, error: 'chapter 3 did not finish loading within 5 s', until: expect.any(Number) }]);
  } finally { await own.close(); }
}, T);

slowTest('a version whose page fails to load fails on its own, not other versions sharing its segments', async () => {
  expect(keysOf('sound')[1]).toBe(keysOf('sabotaged')[1]);
  // (chapter 1 is the same as other versions' here, so frames other tests painted are cached for it already: these
  // two aren't)
  expect((await frameOf('sabotaged', 70, 'prefetch')).broken).toBe('sabotaged');
  expect(service.frame('sabotaged', 71).broken).toBe('sabotaged');
  expect(service.coverage('sabotaged').broken).toEqual([1, 5].map(chapter => ({ chapter, error: 'sabotaged', until: expect.any(Number) })));
  expect((await frameOf('sound', 70, 'prefetch')).file).toBeDefined();
  expect(service.coverage('sound').broken).toEqual([]);
  // what's cached for it (painted for the other version) is still served meanwhile
  expect(service.frame('sabotaged', 70).file).toBeDefined();
}, T);

slowTest('a chapter cannot reach another host from a painting page, while loading or painting', async () => {
  expect((await frameOf('leaky', 30, 'prefetch')).file).toBeDefined();
  await Bun.sleep(1500);
  expect(cap.hits).toEqual({});
}, T);

slowTest('rapid preview requests supersede each other: at most one queued per version, and the latest painted first (Review Focus 3)', async () => {
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

slowTest('a render backlog delays a preview request by at most the frame being painted', async () => {
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

slowTest('a paint-ahead sweep paints at the lowest priority, a few frames queued at a time, and a new one re-aims it', async () => {
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

slowTest('a paint-ahead sweep goes on through writes: past one that leaves its keys alone, and under a changed chapter\'s new key', async () => {
  const painted = [];
  const one = createPool({ port, baseUrl: `http://localhost:${port}`, painters: 1,
    onPainted: p => { painted.push(p); cache.put(p.key, p.frame, p.jpeg, p.deps); } });
  const svc = createFrameService({ db, cache, pool: one, events, root });
  const bg = () => one.stats().queued.filter(q => q.prio === 'background');
  try {
    fastVersion('sweeper');
    svc.paintAhead('sweeper', 1200);
    await until(() => painted.length >= 3);
    // the storyboard changes the snapshot, not a segment key
    db.writeFiles('sweeper', [{ path: 'STORYBOARD.md', content: '# a new storyboard' }], { source: 'manual' });
    const count = painted.length;
    await until(() => painted.length >= count + 10);
    expect(bg().length).toBeGreaterThan(0);
    // chapter 3 (frames 924..1415) gets new code: the sweep paints it again from where it started, under the new key
    const oldKey = keysOf('sweeper')[3];
    db.writeFiles('sweeper', [{ path: 'ch/c03.js', content: fastChapter(3) + '\n// revised' }], { source: 'manual' });
    const newKey = keysOf('sweeper')[3];
    expect(newKey).not.toBe(oldKey);
    await until(() => painted.some(p => p.key === newKey && p.frame === 1200));
    await until(() => painted.filter(p => p.key === newKey).length >= 5);
  } finally { await one.close(); }
}, T);

slowTest('a paint-ahead sweep replaces every version\'s earlier one: only the page being viewed needs it', async () => {
  const painted = [];
  const one = createPool({ port, baseUrl: `http://localhost:${port}`, painters: 1,
    onPainted: p => { painted.push(p); cache.put(p.key, p.frame, p.jpeg, p.deps); } });
  const svc = createFrameService({ db, cache, pool: one, events, root });
  const bg = () => one.stats().queued.filter(q => q.prio === 'background');
  try {
    fastVersion('left');
    svc.paintAhead('left', 1500);
    await until(() => painted.length >= 2);
    svc.paintAhead('rev', 3400);
    expect(bg().length).toBeGreaterThan(0);
    expect(bg().every(q => q.versionId === 'rev')).toBe(true);
    const count = painted.length;
    await until(() => painted.length >= count + 6);
    // at most the frame being painted when it changed is the old version's
    expect(painted.slice(count + 1).every(p => p.versionId === 'rev')).toBe(true);
  } finally { await one.close(); }
}, T);

slowTest('a deleted version\'s queued paints are dropped at every priority, and its sweep stops; other versions\' stay', async () => {
  const painted = [];
  const one = createPool({ port, baseUrl: `http://localhost:${port}`, painters: 1,
    onPainted: p => { painted.push(p); cache.put(p.key, p.frame, p.jpeg, p.deps); } });
  const svc = createFrameService({ db, cache, pool: one, events, root });
  const queued = versionId => one.stats().queued.filter(q => q.versionId === versionId);
  try {
    fastVersion('doomed');
    svc.paintAhead('doomed', 2000);
    await until(() => painted.some(p => p.versionId === 'doomed'));
    svc.prefetch('doomed', 3000, 10);
    const held = svc.frame('doomed', 3500, 'preview');
    svc.prefetch('rev', 3000, 10);
    expect(new Set(queued('doomed').map(q => q.prio))).toEqual(new Set(['preview', 'prefetch', 'background']));
    expect(queued('rev').length).toBeGreaterThan(0);

    db.deleteVersion('doomed', { videos: false });
    svc.dropVersion('doomed');
    expect(queued('doomed')).toEqual([]);
    expect(queued('rev').length).toBeGreaterThan(0);
    expect(await held.pending).toMatchObject({ retry: expect.any(String) });
    // at most the frame being painted when it was deleted is the doomed version's; then only the other's
    const count = painted.length;
    await until(() => painted.filter((p, k) => k > count && p.versionId === 'rev').length >= 3);
    expect(painted.slice(count + 1).every(p => p.versionId === 'rev')).toBe(true);
    expect(queued('doomed')).toEqual([]);
  } finally { await one.close(); }
}, T);

slowTest('a paint-ahead sweep stops at the first chapter that is not written or is broken', async () => {
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

slowTest('POST /api/frames/<v>/paint-ahead: UI hosts, the token, a known version and a frame index', async () => {
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

slowTest('a request held past the hold time is answered 202, to be asked again', async () => {
  const app = createApp({ db, root, data, token, events, port, frames: service, frameHoldMs: 100 });
  const get = path => app.fetch(new Request(`http://localhost:${port}${path}`, { headers: { host: `localhost:${port}`, 'x-studio-token': token } }));
  const res = await get('/api/frames/slow/48.jpg');
  expect(res.status).toBe(202);
  expect(res.headers.get('retry-after')).toBe('1');
  // painting went on (the request was already being painted): asked again, it's there
  await until(async () => (await get('/api/frames/slow/48.jpg')).status === 200);
}, T);

test('without a painting browser the studio stays up: frame requests fail at once with the reason (503), and /api/health says why', async () => {
  const down = createPool({ port, baseUrl: `http://localhost:${port}`, painters: 1, onPainted() {},
    launch: () => Promise.reject(new Error('Browser was not found at the configured executablePath (/nope/chrome)')) });
  const svc = createFrameService({ db, cache, pool: down, events, root });
  const app = createApp({ db, root, data, token, events, port, frames: svc });
  const get = path => app.fetch(new Request(`http://localhost:${port}${path}`, { headers: { host: `localhost:${port}`, 'x-studio-token': token } }));
  fastVersion('no-browser', { wipes: false });   // keys of its own: nothing of it is cached
  const reason = 'the painting browser did not start: Browser was not found at the configured executablePath (/nope/chrome)';
  try {
    expect((await (await get('/api/health')).json()).painter).toEqual({ ok: true, reason: null });
    const res = await get('/api/frames/no-browser/100.jpg');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'the studio cannot paint frames right now', reason });
    // the next one is answered without trying again (no 30 s hold, no 202 to ask again for ever)
    const t0 = Date.now();
    expect((await get('/api/frames/no-browser/101.jpg?prio=prefetch')).status).toBe(503);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await (await get('/api/health')).json()).painter).toEqual({ ok: false, reason });
    // a render can't be filled either, and says why
    await expect(svc.fillForRender('no-browser', null, { from: 100, to: 102 })).rejects.toThrow(reason);
  } finally { await down.close(); }
});

slowTest('a bad CHROME_PATH fixed while the studio runs: painting recovers once the retry interval has passed', async () => {
  let path = '/nope/chrome';
  const pool2 = createPool({ port, baseUrl: `http://localhost:${port}`, painters: 1, launchRetryMs: 500,
    onPainted: p => cache.put(p.key, p.frame, p.jpeg, p.deps), launch: opts => launchBrowser({ ...opts, chrome: path }) });
  const svc = createFrameService({ db, cache, pool: pool2, events, root });
  const get = async i => { const r = svc.frame('no-browser-2', i, 'prefetch'); return r.pending ? r.pending : r; };
  fastVersion('no-browser-2', { wipes: false, cornerMeter: false });
  try {
    expect(await get(100)).toMatchObject({ unavailable: expect.stringContaining('/nope/chrome') });
    expect(svc.painter().ok).toBe(false);
    path = undefined;   // found as usual from here on
    expect(await get(101)).toMatchObject({ unavailable: expect.any(String) });   // not tried again yet
    await Bun.sleep(600);
    expect((await get(102)).file).toBeDefined();
    expect(svc.painter()).toEqual({ ok: true, reason: null });
  } finally { await pool2.close(); }
}, T);

test('frame and coverage requests another site made, or sent without the token, are refused before anything is queued', async () => {
  const before = { ...pool.stats(), queued: pool.stats().queued.length };
  for (const site of ['cross-site', 'same-site']) {
    for (const path of ['/api/frames/tiny/3001.jpg', '/api/coverage/tiny', '/api/coverage/nope']) {
      expect([site, path, (await fetchT(`${srv.url}${path}`, { headers: { 'sec-fetch-site': site } })).status]).toEqual([site, path, 403]);
    }
  }
  for (const path of ['/api/frames/tiny/3001.jpg', '/api/frames/nope/1.jpg', '/api/coverage/tiny', '/api/coverage/nope']) {
    expect([path, (await fetch(`${srv.url}${path}`)).status]).toEqual([path, 403]);
  }
  const after = pool.stats();
  expect([after.queued.length, after.painting, after.painted, after.loads]).toEqual([before.queued, before.painting, before.painted, before.loads]);
  // the studio's own page: same-origin, with the token
  expect((await fetchT(`${srv.url}/api/coverage/tiny`, { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
});

// A stand-in pool for what needs no painting browser: requests wait until the test answers them. paint() answers
// the oldest background one as painted (a stand-in JPEG in the cache), as the real pool would.
function fakePool(fakeCache) {
  const pending = [], superseded = [];
  const settle = (p, r) => { pending.splice(pending.indexOf(p), 1); p.resolve(r); };
  return {
    pending, superseded,
    background: () => pending.filter(p => p.prio === 'background'),
    request: w => new Promise(resolve => pending.push({ ...w, resolve })),
    supersede(versionId, prio) {
      superseded.push([versionId, prio]);
      for (const p of [...pending]) if ((versionId == null || p.versionId === versionId) && p.prio === prio) settle(p, { ok: false, superseded: true, error: 'superseded' });
    },
    answer(frame, result) { settle(pending.find(x => x.frame === frame), result); },
    paint() {
      const p = pending.find(x => x.prio === 'background');
      fakeCache.put(p.key, p.frame, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {});
      settle(p, { ok: true, deps: {}, depsHash: '-' });
    },
  };
}
const leased = (extra = {}) => {
  const fakeCache = createCache({ dir: join(tempDir(), 'frames'), capBytes: 1e12 }), fake = fakePool(fakeCache);
  return { fake, svc: createFrameService({ db, cache: fakeCache, pool: fake, events, root, ...extra }) };
};
const settled = () => Bun.sleep(20);

test('coverage says when a break that runs out does (until), so the page can ask again then; a chapter\'s own error has none', async () => {
  fastVersion('breaks');
  const { fake, svc } = leased();
  const slow = svc.frame('breaks', 600, 'prefetch').pending, throws = svc.frame('breaks', 1000, 'prefetch').pending;
  const until = Date.now() + 60000;
  fake.answer(600, { ok: false, broken: true, error: 'painting frame 600 took over 20 s', until });
  fake.answer(1000, { ok: false, broken: true, error: 'boom' });
  await Promise.all([slow, throws]);
  expect(svc.coverage('breaks').broken).toEqual([{ chapter: 2, error: 'painting frame 600 took over 20 s', until }, { chapter: 3, error: 'boom' }]);
});

test('under --dev, an engine edit changes every segment key, so frames of the old engine are never shown for the new', () => {
  fastVersion('engine-dev');
  const copy = tempDir('engine-');
  for (const p of ['studio.html', 'src', 'node_modules/p5/lib/p5.min.js', 'node_modules/p5.brush/dist/p5.brush.js', 'assets/fonts']) {
    mkdirSync(join(copy, p, '..'), { recursive: true });
    cpSync(join(root, p), join(copy, p), { recursive: true });
  }
  const fakeCache = createCache({ dir: join(tempDir(), 'frames'), capBytes: 1e12 });
  const dev = createFrameService({ db, cache: fakeCache, pool: fakePool(fakeCache), events, root: copy, dev: true });
  const before = dev.coverage('engine-dev').segments;
  appendFileSync(join(copy, 'src/timeline.js'), '\n// edited');
  const after = dev.coverage('engine-dev').segments;
  for (let n = 1; n <= 9; n++) expect(after[n]).not.toBe(before[n]);
  // (outside --dev the engine is taken as fixed: see test/frames-keys.test.js)
});

test('a paint-ahead sweep stops once its lease runs out: nothing more is queued, and what was queued is withdrawn', async () => {
  fastVersion('lease-1');
  const { fake, svc } = leased({ leaseMs: 200 });
  svc.paintAhead('lease-1', 0);
  expect(fake.background().map(p => p.frame)).toEqual([0, 1, 2, 3, 4, 5]);
  fake.paint(); await settled();
  expect(fake.background().map(p => p.frame)).toEqual([1, 2, 3, 4, 5, 6]);   // one done, the next queued
  await Bun.sleep(250);
  expect(fake.background()).toEqual([]);
  expect(fake.superseded).toContainEqual([null, 'background']);
  // (a frame already being painted when it lapsed queues nothing after it)
  svc.frame('lease-1', 2000, 'preview');
  await settled();
  expect(fake.background()).toEqual([]);
});

test('a paint-ahead sweep goes on while it is renewed, by paint-ahead calls or the version\'s own frame requests', async () => {
  fastVersion('lease-2');
  const { fake, svc } = leased({ leaseMs: 200 });
  expect(svc.paintAhead('lease-2', 0)).toEqual({ from: 0, end: N });
  for (let k = 0; k < 6; k++) {   // 600 ms, three times the lease
    await Bun.sleep(100);
    if (k % 2) svc.frame('lease-2', 3000 + k, 'prefetch');
    else expect(svc.paintAhead('lease-2', 0)).toEqual({ from: 0, end: N });   // renewed, not restarted
    fake.paint(); await settled();
  }
  expect(fake.background().map(p => p.frame)).toEqual([6, 7, 8, 9, 10, 11]);
  // another version's frames don't renew it, nor do a render's or the thumbnails'
  fastVersion('lease-other');
  for (let k = 0; k < 3; k++) {
    await Bun.sleep(100);
    svc.frame('lease-other', 100 + k, 'preview');
    svc.frame('lease-2', 200 + k, 'thumbs');
  }
  expect(fake.background()).toEqual([]);
});

test('a paint-ahead sweep stops when no studio page is left on the event stream', async () => {
  fastVersion('lease-3');
  const ev = createEvents(), fakeCache = createCache({ dir: join(tempDir(), 'frames'), capBytes: 1e12 }), fake = fakePool(fakeCache);
  const svc = createFrameService({ db, cache: fakeCache, pool: fake, events: ev, root });
  const tabs = [new AbortController(), new AbortController()];
  for (const t of tabs) ev.stream(new Request('http://localhost/api/events', { signal: t.signal }));
  expect(ev.streamCount()).toBe(2);
  svc.paintAhead('lease-3', 0);
  tabs[0].abort();   // one page left: it goes on
  fake.paint(); await settled();
  expect(fake.background()).toHaveLength(6);
  tabs[1].abort();
  expect(ev.streamCount()).toBe(0);
  expect(fake.background()).toEqual([]);
});

test('the old renders\' frame folders are counted in /api/cache, and deleted only by clearing the cache', async () => {
  const own = tempDir(), legacy = join(own, '.studio/frames');
  for (const v of ['old-a', 'old-b']) { mkdirSync(join(legacy, v), { recursive: true }); writeFileSync(join(legacy, v, 'f00001.jpg'), Buffer.alloc(1000)); }
  const app = createApp({ db, root, data: own, token, events, port, frames: createFrameService({ db, cache: createCache({ dir: join(own, '.studio/cache/frames'), capBytes: 1e12 }), pool, events, root }) });
  const call = (path, init = {}) => app.fetch(new Request(`http://localhost:${port}${path}`, { ...init, headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'x-studio-token': token } }));
  expect(await (await call('/api/cache')).json()).toEqual({ usedBytes: 0, capBytes: 1e12, legacyBytes: 2000 });
  expect(existsSync(join(legacy, 'old-a/f00001.jpg'))).toBe(true);   // looking deletes nothing
  expect(await (await call('/api/cache/clear', { method: 'POST' })).json()).toEqual({ usedBytes: 0, capBytes: 1e12, legacyBytes: 0 });
  expect(existsSync(legacy)).toBe(false);
});

test('missing versions, chapters and frames are 404s', async () => {
  expect((await fetchT(`${srv.url}/api/frames/partial/1500.jpg`)).status).toBe(404);
  expect((await fetchT(`${srv.url}/api/frames/nope/10.jpg`)).status).toBe(404);
  expect((await fetchT(`${srv.url}/api/frames/tiny/${N}.jpg`)).status).toBe(404);
  expect((await fetchT(`${srv.url}/api/coverage/nope`)).status).toBe(404);
}, T);

slowTest('the frame, coverage and cache routes are served on UI hosts only', async () => {
  const w0 = `w0.localhost:${port}`, headers = { origin: `http://localhost:${port}`, 'x-studio-token': token };
  for (const path of ['/api/frames/tiny/48.jpg', '/api/coverage/tiny', '/api/cache']) {
    expect((await at(w0, path, { headers: { 'x-studio-token': token } })).status).toBe(404);
    expect((await at(`localhost:${port}`, path, { headers: { 'x-studio-token': token } })).status).toBe(200);
  }
  expect((await at(w0, '/api/cache/clear', { method: 'POST', headers })).status).toBe(404);
}, T);

slowTest('clearing the cache needs the token', async () => {
  const url = `${srv.url}/api/cache/clear`, origin = srv.url;
  expect((await fetch(url, { method: 'POST', headers: { origin } })).status).toBe(403);
  expect((await fetch(url, { method: 'POST', headers: { origin, 'x-studio-token': 'wrong' } })).status).toBe(403);
  expect(service.coverage('tiny').ranges.length).toBeGreaterThan(0);
  const info = await (await fetch(`${srv.url}/api/cache`)).json();
  expect(info.usedBytes).toBeGreaterThan(0);
  expect(info.capBytes).toBe(1e12);
  const res = await fetch(url, { method: 'POST', headers: { origin, 'x-studio-token': token } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ usedBytes: 0, capBytes: 1e12, legacyBytes: 0 });
  expect(service.coverage('tiny').ranges).toEqual([]);
}, T);
