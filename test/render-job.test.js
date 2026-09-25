import { test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../studio/db.js';
import { serve } from '../studio/serve.js';
import { createEvents } from '../studio/events.js';
import { createCache } from '../studio/frames/cache.js';
import { createPool } from '../studio/frames/pool.js';
import { createFrameService } from '../studio/frames/service.js';
import { createRenderRunner } from '../studio/render-job.js';
import { snapshotOf } from '../studio/snapshot.js';
import { FPS, segmentKeys, engineHash } from '../studio/frames/keys.js';
import { CHAPTER_WINDOWS } from '../studio/storyboard.js';
import { tempDir, tempDefaultDb } from './helpers.js';

// One sealed painting pool for the file, over small versions whose one or two chapters paint in a few tens of
// milliseconds each — the Original's take up to a second a frame, far too slow for a suite that renders whole
// ranges of frames repeatedly.
const root = process.cwd(), T = { timeout: 120000 };
const ctx = (signal = new AbortController().signal) => ({ signal, log: () => {}, progress: () => {}, cost: () => {} });

const fastChapter = (n, extra = '') => {
  const [a, b] = CHAPTER_WINDOWS[n - 1];
  return `chapter('c${n}', ${a}, ${b}, [[${a}, t => { ${extra} paint(rectPts(100 + (t - ${a}) * 20, 200, 300, 200), { wash: PAL.clay }); }]]);`;
};
const freePort = () => { const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }); const p = s.port; s.stop(true); return p; };
// Seconds bounds that render() turns back into exactly frames first..last (rangeFor(f,l) : Math.round(a*FPS) === f
// and Math.round(b*FPS) - 1 === l, since f and l+1 are themselves whole numbers of frames).
const rangeFor = (first, last) => `${first / FPS}:${(last + 1) / FPS}`;
const keyOf = (versionId, n) => segmentKeys(snapshotOf(db, versionId), engineHash(root))[n];

let data, db, events, cache, pool, service, srv, runners, port;

beforeAll(async () => {
  data = tempDir();
  db = openDb(join(data, 'user.db'), { defaultPath: tempDefaultDb() });

  // Ten frames (96..105, ~4-4.4s), all inside chapter 1 — one segment, cheap to paint and re-render.
  db.createVersion({ id: 'short', title: 'Short One', logline: 'A quick take.' });
  db.writeFiles('short', [{ path: 'ch/c01.js', content: fastChapter(1) }], { source: 'manual' });

  // Chapters 1 and 2 (window boundary at 23s / frame 552): two segments, so a range straddling it pins both.
  db.createVersion({ id: 'boundary', title: 'Boundary', logline: 'Spans two chapters.' });
  db.writeFiles('boundary', [{ path: 'ch/c01.js', content: fastChapter(1) }, { path: 'ch/c02.js', content: fastChapter(2) }], { source: 'manual' });

  db.createVersion({ id: 'delone', title: 'Deleted Later', logline: 'Goes away after its render.' });
  db.writeFiles('delone', [{ path: 'ch/c01.js', content: fastChapter(1) }], { source: 'manual' });

  // A chapter that takes a while per frame, so an abort fired right after starting a render lands mid-fill.
  db.createVersion({ id: 'slowcancel', title: 'Slow', logline: 'Long enough to cancel mid-fill.' });
  db.writeFiles('slowcancel', [{ path: 'ch/c01.js', content: fastChapter(1, 'const end = performance.now() + 200; while (performance.now() < end) {}') }], { source: 'manual' });

  // Chapter 1 is healthy, chapter 2 throws while painting, and chapters 3-9 are never written at all.
  db.createVersion({ id: 'patchy', title: 'Patchy' });
  db.writeFiles('patchy', [
    { path: 'ch/c01.js', content: fastChapter(1) },
    { path: 'ch/c02.js', content: "chapter('c2', 23, 38.5, [[23, t => { throw new Error('chapter two is broken'); }]]);" },
  ], { source: 'manual' });

  port = freePort();
  events = createEvents();
  cache = createCache({ dir: join(data, '.studio/cache/frames'), capBytes: 1e12 });
  pool = createPool({ port, baseUrl: `http://localhost:${port}`, painters: 3, paintTimeoutMs: 5000,
    onPainted: p => cache.put(p.key, p.frame, p.jpeg, p.deps) });
  service = createFrameService({ db, cache, pool, events, root });
  srv = serve({ db, root, data, token: 't', events, port, frames: service });
  runners = createRenderRunner({ db, root, data, events, frames: service });
});
afterAll(async () => { await pool?.close(); srv?.stop(); });

test('a short-range render paints only the missing frames, and re-rendering a fully cached range paints nothing', async () => {
  const first = 96, last = 105;
  // Pre-paint half of the range directly through the frame service.
  for (let i = first; i < first + 5; i++) {
    const r = service.frame('short', i, 'prefetch');
    await (r.pending ?? r);
  }
  const before = pool.stats().painted;
  const job1 = db.getJob(db.addJob({ kind: 'render', versionId: 'short', params: { frames: rangeFor(first, last) } }));
  await runners.render(job1, ctx());
  expect(pool.stats().painted - before).toBe(5);   // only the other five were missing

  const before2 = pool.stats().painted;
  const job2 = db.getJob(db.addJob({ kind: 'render', versionId: 'short', params: { frames: rangeFor(first, last) } }));
  await runners.render(job2, ctx());
  expect(pool.stats().painted).toBe(before2);      // the range is now fully cached: nothing new to paint
}, T);

test('the MP4 duration matches the range, and the render row carries the revisions, snapshot, title and logline', async () => {
  const first = 200, last = 223;   // 24 frames = exactly 1 second
  const job = db.getJob(db.addJob({ kind: 'render', versionId: 'short', params: { frames: rangeFor(first, last) } }));
  await runners.render(job, ctx());
  const [r] = db.listRenders();
  expect(r.version_id).toBe('short');
  expect(r.title).toBe('Short One');
  expect(r.logline).toBe('A quick take.');
  expect(r.snapshot_id).toBe(snapshotOf(db, 'short').id);
  expect(r.revision_ids).toEqual(db.listFiles('short').map(f => f.revision_id));
  expect(existsSync(join(data, 'library', r.file))).toBe(true);
  expect(existsSync(join(data, 'library', r.poster))).toBe(true);

  const proc = Bun.spawn(['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', join(data, 'library', r.file)], { stdout: 'pipe', stderr: 'pipe' });
  const { format } = JSON.parse(await new Response(proc.stdout).text());
  await proc.exited;
  expect(Math.abs(+format.duration - (last - first + 1) / FPS)).toBeLessThan(.15);
}, T);

test('a render under a tiny cache cap keeps its own segments pinned until it releases them (Review Focus 5)', async () => {
  const tinyCache = createCache({ dir: join(tempDir(), 'cache'), capBytes: 0.001 * 1e9 });
  const tinyPool = createPool({ port, baseUrl: `http://localhost:${port}`, painters: 3, paintTimeoutMs: 5000,
    onPainted: p => tinyCache.put(p.key, p.frame, p.jpeg, p.deps) });
  const tinyService = createFrameService({ db, cache: tinyCache, pool: tinyPool, events, root });
  const tinyRunners = createRenderRunner({ db, root, data, events, frames: tinyService });
  try {
    const first = 532, last = 571;   // straddles the chapter 1/2 boundary at frame 552: two pinned segments
    const job = db.getJob(db.addJob({ kind: 'render', versionId: 'boundary', params: { frames: rangeFor(first, last) } }));
    await tinyRunners.render(job, ctx());
    const [r] = db.listRenders();
    expect(r.version_id).toBe('boundary');
    expect(existsSync(join(data, 'library', r.file))).toBe(true);
    // Genuinely over the cap — had the segments not been pinned while painting the other one, eviction (which runs
    // after every cache.put) would have taken one out from under the still-running render, and either the encode
    // would have failed outright or the render would never have completed at all.
    const used = tinyCache.usedBytes();
    expect(used).toBeGreaterThan(tinyCache.capBytes);
    // Once the render releases its pins, the older (not most-recently-used) segment is fair game again — eviction
    // never drops the single most-recently-used segment regardless of the cap, so usedBytes need not fall under it,
    // only actually shrink, proving the pin (not just "it's the newest") was what protected it during the render.
    tinyCache.evict();
    expect(tinyCache.usedBytes()).toBeLessThan(used);
  } finally { await tinyPool.close(); }
}, T);

test('after deleting the version row, the render still lists with its stored title and logline', async () => {
  const first = 96, last = 105;
  const job = db.getJob(db.addJob({ kind: 'render', versionId: 'delone', params: { frames: rangeFor(first, last) } }));
  await runners.render(job, ctx());
  const [r] = db.listRenders();
  expect(r.version_id).toBe('delone');

  db.db.query('DELETE FROM versions WHERE id = $id').run({ id: 'delone' });
  expect(db.getVersion('delone')).toBeNull();

  const after = db.listRenders().find(x => x.id === r.id);
  expect(after).toMatchObject({ version_id: 'delone', title: 'Deleted Later', logline: 'Goes away after its render.' });
}, T);

test('cancelling during the fill rejects with "cancelled" and leaves no library entry', async () => {
  const before = db.listRenders().length;
  const ctrl = new AbortController();
  const job = db.getJob(db.addJob({ kind: 'render', versionId: 'slowcancel', params: { frames: '0:5' } }));
  const p = runners.render(job, ctx(ctrl.signal));
  ctrl.abort();
  await expect(p).rejects.toThrow('cancelled');
  expect(db.listRenders().length).toBe(before);
}, T);

test('cancelling a render withdraws its queued paints from the pool and releases the pins', async () => {
  const tinyCache = createCache({ dir: join(tempDir(), 'cache'), capBytes: 1e12 });
  const tinyPool = createPool({ port, baseUrl: `http://localhost:${port}`, painters: 1, paintTimeoutMs: 5000,
    onPainted: p => tinyCache.put(p.key, p.frame, p.jpeg, p.deps) });
  const tinyService = createFrameService({ db, cache: tinyCache, pool: tinyPool, events, root });
  const tinyRunners = createRenderRunner({ db, root, data, events, frames: tinyService });
  try {
    const first = 96, last = 495;   // 400 frames inside chapter 1: large enough that most stay queued
    // One frame already cached, so the segment (and its pin) exist from the very start of the render.
    const seed = tinyService.frame('short', first, 'prefetch');
    await (seed.pending ?? seed);

    const beforeRenders = db.listRenders().length;
    const ctrl = new AbortController();
    const job = db.getJob(db.addJob({ kind: 'render', versionId: 'short', params: { frames: rangeFor(first, last) } }));
    const p = tinyRunners.render(job, ctx(ctrl.signal));
    ctrl.abort();   // right away: only the pre-seeded frame is ever "done" — the other 399 are still queued
    await expect(p).rejects.toThrow('cancelled');
    expect(db.listRenders().length).toBe(beforeRenders);

    // The pool withdraws them (rather than leaving them to paint out over time) within a second.
    const deadline = Date.now() + 1000;
    for (;;) {
      const stillQueued = tinyPool.stats().queued.filter(q => q.versionId === 'short' && q.prio === 'render');
      if (stillQueued.length === 0) break;
      if (Date.now() > deadline) throw new Error(`${stillQueued.length} queued render paints did not withdraw within 1 s`);
      await Bun.sleep(20);
    }

    // The pin releases too: clear() (which removes only what ISN'T pinned) would leave the segment behind if it
    // had leaked.
    tinyCache.clear();
    expect(existsSync(join(tinyCache.dir, keyOf('short', 1)))).toBe(false);
  } finally { await tinyPool.close(); }
}, T);

test('thumbnails are composed from three cached frames per chapter, and a second run paints nothing new', async () => {
  const job1 = db.getJob(db.addJob({ kind: 'thumbs', versionId: 'boundary' }));
  const before = pool.stats().painted;
  await runners.thumbs(job1, ctx());
  const out1 = join(data, '.studio/thumbs/boundary/c01.jpg'), out2 = join(data, '.studio/thumbs/boundary/c02.jpg');
  expect(existsSync(out1)).toBe(true);
  expect(existsSync(out2)).toBe(true);
  expect([...readFileSync(out1).subarray(0, 2)]).toEqual([0xff, 0xd8]);   // JPEG magic

  const proc = Bun.spawn(['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_streams', out1], { stdout: 'pipe', stderr: 'pipe' });
  const { streams } = JSON.parse(await new Response(proc.stdout).text());
  await proc.exited;
  // Chapter 1's cached frames are 1920x1080; three of them scaled to 320 px wide, side by side.
  expect(streams[0]).toMatchObject({ width: 960, height: 180 });
  expect(pool.stats().painted - before).toBe(6);   // 3 frames each for boundary's two chapters, none cached yet

  const before2 = pool.stats().painted;
  const job2 = db.getJob(db.addJob({ kind: 'thumbs', versionId: 'boundary' }));
  await runners.thumbs(job2, ctx());
  expect(pool.stats().painted).toBe(before2);      // all six frames were already cached: nothing new to paint
}, T);

test('thumbs skips a broken or missing chapter, logs why, and still succeeds', async () => {
  const lines = [];
  const job = db.getJob(db.addJob({ kind: 'thumbs', versionId: 'patchy' }));
  await runners.thumbs(job, { signal: new AbortController().signal, log: t => lines.push(t), progress: () => {}, cost: () => {} });

  expect(existsSync(join(data, '.studio/thumbs/patchy/c01.jpg'))).toBe(true);    // the healthy chapter still gets one
  expect(existsSync(join(data, '.studio/thumbs/patchy/c02.jpg'))).toBe(false);   // broken
  expect(existsSync(join(data, '.studio/thumbs/patchy/c03.jpg'))).toBe(false);   // never written

  const log = lines.join('');
  expect(log).toContain('chapter 2: skipped');
  expect(log).toContain('chapter two is broken');
  expect(log).toContain('chapter 3: skipped');
  expect(log).toMatch(/chapter 3 isn't written yet/);
}, T);
