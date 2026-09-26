// service.js: frames for versions, by way of the cache and the painting pool. A version's frames are always looked up
// under its current snapshot's segment keys and file hashes (studio/frames/keys.js), so when a chapter changes, only
// that chapter's frames stop counting as cached (and any frame that read one of its CAST entries); the rest stay.
// Publishes the SSE event `frames` { versionId, ranges, broken, segments } as frames get painted or segments break, at
// most every 500 ms.
import { existsSync } from 'node:fs';
import { snapshotOf, rememberSnapshot } from '../snapshot.js';
import { N, chapterOfFrame, framesOfChapter, engineHash, segmentKeys, currentShas } from './keys.js';
import { PRIORITIES } from './pool.js';

// A paint-ahead sweep keeps at most this many of its frames queued in the pool at once, queueing the next as each is
// done: the rest of a song is thousands of frames, and they don't all need to sit in the queue.
const SWEEP_BATCH = 6;

// dev (the server's --dev): the engine may be edited while the studio runs, so its hash is checked on every use.
export function createFrameService({ db, cache, pool, events, root, publishEveryMs = 500, leaseMs = 45000, dev = false }) {
  const engine = () => engineHash(root, { recheck: dev });
  // segment key -> { error, until }: broken for good (until null: the chapter's own error, which only a new key
  // clears) or until then (a timeout, or a snapshot that failed to load).
  const broken = new Map();
  // snapshot id -> { error, until }: a snapshot whose page didn't load (a load error such as a missing font, shared.js
  // throwing). That's the snapshot's, not any segment's: other versions sharing a segment are unaffected.
  const failedSnapshots = new Map();
  const liveEntry = (map, k) => {
    const b = map.get(k);
    if (b && b.until != null && b.until <= Date.now()) { map.delete(k); return null; }
    return b || null;
  };
  const live = (map, k) => liveEntry(map, k)?.error ?? null;
  const brokenOf = key => live(broken, key);

  // The cached frame valid for these file hashes, as long as its file is really there: one deleted behind the
  // cache's back is taken out of it, to be painted again.
  const lookup = (key, i, shas) => {
    for (;;) {
      const found = cache.find(key, i, shas);
      if (!found || existsSync(found.path)) return found;
      cache.forget(key, i, found.depsHash);
    }
  };

  // The version's current snapshot (remembered, so the painting pages can load it), its keys and its file hashes.
  const current = versionId => {
    const snap = snapshotOf(db, versionId);
    if (!snap) return null;
    rememberSnapshot(snap);
    const e = engine();
    return { snap, keys: segmentKeys(snap, e), shas: currentShas(snap), engine: e };
  };

  const dirty = new Set();
  let timer = null, lastPublished = 0;
  const flush = () => {
    timer = null; lastPublished = Date.now();
    for (const versionId of dirty) {
      try {
        const c = coverage(versionId);
        if (c) events?.publish('frames', { versionId, ranges: c.ranges, broken: c.broken, segments: c.segments });
      } catch (e) { console.error(`frames event for ${versionId}: ${e.message}`); }
    }
    dirty.clear();
  };
  const changed = versionId => {
    dirty.add(versionId);
    timer ??= setTimeout(flush, Math.max(0, lastPublished + publishEveryMs - Date.now()));
  };

  // Resolves to { file, key, depsHash } once painted, { broken, key } if its segment broke, { unavailable: why, key }
  // if the painting browser didn't start (nothing can be painted for a while), or { retry, key } if the request was
  // superseded, cancelled or couldn't be painted (it's worth asking again).
  const paint = (versionId, cur, i, prio, { signal, near } = {}) => {
    const key = cur.keys[chapterOfFrame(i)];
    return pool.request({ versionId, snapshotId: cur.snap.id, engine: cur.engine, key, frame: i, prio, currentShas: cur.shas, signal, near }).then(r => {
      if (r.unavailable) return { unavailable: r.error, key };
      if (r.broken) {
        (r.snapshot ? failedSnapshots : broken).set(r.snapshot ? cur.snap.id : key, { error: r.error, until: r.until ?? null });
        changed(versionId);
        return { broken: r.error, key };
      }
      const found = r.ok && lookup(key, i, cur.shas);
      if (!found) return { retry: r.error || 'not in the cache', key };
      changed(versionId);
      return { file: found.path, depsHash: found.depsHash, key };
    });
  };

  // { file, key, depsHash } when cached; { pending: Promise (as paint's), key } while it's painted (with no painting
  // browser, it resolves at once, as unavailable); { broken, key } for a broken segment; { missing } for a version or
  // chapter that doesn't exist. A preview or prefetch request renews the version's paint-ahead lease (paintAhead). A
  // preview request supersedes the version's older queued ones: only the newest playhead position matters. signal:
  // aborting it withdraws the request.
  function frame(versionId, i, prio = 'preview', { signal } = {}) {
    const cur = current(versionId);
    if (!cur) return { missing: 'no such version' };
    const n = chapterOfFrame(i), key = cur.keys[n];
    if (!key) return { missing: `chapter ${n} isn't written yet` };
    // The player asking for frames still wants its version painted ahead.
    if (prio === 'preview' || prio === 'prefetch') renewSweep(versionId);
    const b = brokenOf(key);
    if (b) return { broken: b, key };
    const found = lookup(key, i, cur.shas);
    if (found) { cache.touch(key); return { file: found.path, depsHash: found.depsHash, key }; }
    const failed = live(failedSnapshots, cur.snap.id);   // what's cached is still good; nothing new can be painted
    if (failed) return { broken: failed, key };
    if (prio === 'preview') pool.supersede(versionId, 'preview');
    return { pending: paint(versionId, cur, i, prio, { signal }), key };
  }

  // The bytes of a cached frame valid for the version's current snapshot: { bytes, key, depsHash }, or null (not
  // cached: ask again). Files are never replaced once written, so what's read is the frame that was found.
  async function read(versionId, i) {
    const cur = current(versionId);
    const key = cur?.keys[chapterOfFrame(i)], found = key && lookup(key, i, cur.shas);
    if (!found) return null;
    try { return { bytes: await Bun.file(found.path).bytes(), key, depsHash: found.depsHash }; }
    catch { cache.forget(key, i, found.depsHash); return null; }
  }

  // { total, ranges: [[first, last], ...] cached for the current snapshot, broken: [{ chapter, error, until? }],
  // segments: { 1..9: segment key, or null for a chapter not written } }, or null. until (ms since the epoch): when a
  // break that runs out (a timeout, a snapshot that didn't load) does; a chapter's own error has none, and lasts until
  // its code changes. The segment keys let the player tell when a chapter's frames changed (a frame's ETag names the
  // key it was painted under), so it never shows one from a chapter's older code.
  function coverage(versionId) {
    const cur = current(versionId);
    if (!cur) return null;
    const failed = liveEntry(failedSnapshots, cur.snap.id);
    const brokenChapters = Object.entries(cur.keys).map(([n, k]) => [+n, k && (failed || liveEntry(broken, k))]).filter(([, b]) => b)
      .map(([chapter, b]) => ({ chapter, error: b.error, ...(b.until != null && { until: b.until }) }));
    return { total: N, ranges: cache.coverage(cur.keys, cur.shas), broken: brokenChapters, segments: cur.keys };
  }

  // Queues the missing frames of [from, from + count) at prefetch priority, in place of the version's earlier prefetch.
  function prefetch(versionId, from, count) {
    const cur = current(versionId);
    if (!cur) return 0;
    pool.supersede(versionId, 'prefetch');
    let queued = 0;
    for (let i = Math.max(0, from); i < Math.min(N, from + count); i++) {
      const key = cur.keys[chapterOfFrame(i)];
      if (!key || brokenOf(key) || lookup(key, i, cur.shas)) continue;
      paint(versionId, cur, i, 'prefetch', { near: from });
      queued++;
    }
    return queued;
  }

  // The first frame from `from` on that the version can't play: the start of the first chapter (from `from`'s own)
  // that isn't written or is broken, or N.
  const playableEnd = (cur, from) => {
    if (live(failedSnapshots, cur.snap.id)) return from;
    for (let i = from; i < N;) {
      const n = chapterOfFrame(i), key = cur.keys[n];
      if (!key || brokenOf(key)) return i;
      i = framesOfChapter(n)[1] + 1;
    }
    return N;
  };

  // A background sweep: paints a version's missing frames from `from` to the end of what can play, at the lowest
  // priority (after previews, prefetch, renders and thumbs), SWEEP_BATCH at a time. Only the page being viewed needs
  // one, so a new sweep replaces the earlier one, whatever its version (a seek re-aims it; leaving a version drops
  // its sweep). A write to the version (its storyboard, a chapter) doesn't stop it: it carries on under the new
  // snapshot, from where it started, so a changed chapter is painted again under its new key. It stops at the end,
  // or when a frame of it can't be painted (broken, superseded, the pool gone); the player re-aims it when it stalls.
  // A sweep is the whole rest of the song (minutes of GPU), so it's held on a lease: each paint-ahead call and each of
  // the version's preview or prefetch frame requests renews it, and it stops once leaseMs passes without either (the
  // page went away, or stopped wanting it) or when no studio page is left on the event stream.
  // Progress shows as `frames` events, as for any paint. Returns { from, end }, or null for no such version.
  let sweep = null;   // the running sweep's token: { versionId, from, lease }
  const endSweep = token => { if (token && sweep === token) { clearTimeout(token.lease); sweep = null; } };
  // Ended, and whatever of it is still queued withdrawn.
  const stopSweep = token => { if (token && sweep === token) { endSweep(token); pool.supersede(null, 'background'); } };
  const renew = token => {
    clearTimeout(token.lease);
    token.lease = setTimeout(() => stopSweep(token), leaseMs);
    token.lease.unref?.();
  };
  const renewSweep = versionId => { if (sweep?.versionId === versionId) renew(sweep); };
  events?.onStreams?.(n => { if (!n) stopSweep(sweep); });
  function paintAhead(versionId, from) {
    let cur = current(versionId);
    if (!cur) return null;
    // The same sweep asked for again (the player renewing it): it goes on as it is.
    if (sweep && sweep.versionId === versionId && sweep.from === from) { renew(sweep); return { from, end: sweep.end() }; }
    stopSweep(sweep);
    let end = playableEnd(cur, from), next = from, active = 0;
    const token = { versionId, from, end: () => end };
    sweep = token;
    renew(token);
    const going = () => sweep === token;
    const more = () => {
      if (!going()) return;
      const now = current(versionId);
      if (!now) { endSweep(token); return; }
      if (now.snap.id !== cur.snap.id) {   // written to since: go on under the new snapshot, from the start
        cur = now; end = playableEnd(cur, from); next = from;
      }
      while (active < SWEEP_BATCH && next < end) {
        const i = next++;
        if (lookup(cur.keys[chapterOfFrame(i)], i, cur.shas)) continue;
        active++;
        paint(versionId, cur, i, 'background').then(r => {
          active--;
          if (r.file) more();
          else endSweep(token);
        });
      }
      if (next >= end && !active) endSweep(token);
    };
    more();
    return { from, end };
  }

  // A version that was deleted: whatever of it is still queued in the pool goes, at every priority, and its sweep
  // stops. A frame being painted right now finishes (into the cache, where it ages out like any unused segment).
  // The segments themselves aren't touched: the cache is keyed by content, not by version, so another version may
  // share them, and nothing of the deleted one is pinned (it has no render running: deleting waits for its jobs).
  function dropVersion(versionId) {
    if (sweep?.versionId === versionId) endSweep(sweep);
    for (const prio of PRIORITIES) pool.supersede(versionId, prio);
  }

  // Paints every missing frame of a final render (frames from..to, the whole song by default) at render priority,
  // with the segments pinned so eviction can't take them before they're encoded (and a frame file, once written, is
  // never replaced). Resolves to { snapshot, keys, files: the frame files in order, release() }: the caller releases
  // the pins when done. Rejects (and releases them) when a chapter is missing or broken, or (also releasing them)
  // when signal aborts: aborting withdraws whichever of the still-missing frames are still queued in the pool at
  // once (pool.request already drops a waiter whose signal fires), which fails this fill as soon as any of them
  // comes back cancelled — a frame already being painted keeps painting, but nothing further is queued for it.
  async function fillForRender(versionId, onProgress, { from = 0, to = N - 1, signal } = {}) {
    const cur = current(versionId);
    if (!cur) throw new Error('no such version');
    const frames = Array.from({ length: to - from + 1 }, (_, k) => from + k);
    const chapters = [...new Set(frames.map(chapterOfFrame))];
    const failed = live(failedSnapshots, cur.snap.id);
    if (failed) throw new Error(`the version did not load: ${failed}`);
    for (const n of chapters) {
      if (!cur.keys[n]) throw new Error(`chapter ${n} isn't written yet`);
      if (brokenOf(cur.keys[n])) throw new Error(`chapter ${n} is broken: ${brokenOf(cur.keys[n])}`);
    }
    const pinned = [...new Set(chapters.map(n => cur.keys[n]))];
    pinned.forEach(k => cache.pin(k));
    let released = false;
    const release = () => { if (!released) { released = true; pinned.forEach(k => cache.unpin(k)); } };
    const files = new Map();
    try {
      const todo = [];
      for (const i of frames) {
        const found = lookup(cur.keys[chapterOfFrame(i)], i, cur.shas);
        if (found) files.set(i, found.path); else todo.push(i);
      }
      let done = frames.length - todo.length;
      onProgress?.(done / frames.length);
      await Promise.all(todo.map(i => paint(versionId, cur, i, 'render', { signal }).then(r => {
        if (r.unavailable) throw new Error(r.unavailable);
        if (r.broken) throw new Error(`chapter ${chapterOfFrame(i)} is broken: ${r.broken}`);
        if (!r.file) throw new Error(`frame ${i} was not painted: ${r.retry}`);
        files.set(i, r.file);
        onProgress?.(++done / frames.length);
      })));
    } catch (e) {
      pool.supersede(versionId, 'render');
      release();
      throw e;
    }
    return { snapshot: cur.snap, keys: cur.keys, files: frames.map(i => files.get(i)), release };
  }

  // Whether frames can be painted at all: { ok, reason } (reason: why the painting browser didn't start).
  const painter = () => pool.health?.() ?? { ok: true, reason: null };

  return { frame, read, coverage, prefetch, paintAhead, dropVersion, fillForRender, painter, cache };
}
