// service.js: frames for versions, by way of the cache and the painting pool. A version's frames are always looked up
// under its current snapshot's segment keys and file hashes (studio/frames/keys.js), so when a chapter changes, only
// that chapter's frames stop counting as cached (and any frame that read one of its CAST entries); the rest stay.
// Publishes the SSE event `frames` { versionId, ranges, broken } as frames get painted or segments break, at most every
// 500 ms.
import { snapshotOf, rememberSnapshot } from '../snapshot.js';
import { N, chapterOfFrame, engineHash, segmentKeys, currentShas } from './keys.js';

export function createFrameService({ db, cache, pool, events, root, publishEveryMs = 500 }) {
  const engine = engineHash(root);
  // segment key -> { error, until }: broken for good (until null: the chapter's own error, which only a new key
  // clears) or until then (a timeout, or a snapshot that failed to load).
  const broken = new Map();
  const brokenOf = key => {
    const b = broken.get(key);
    if (b && b.until != null && b.until <= Date.now()) { broken.delete(key); return null; }
    return b?.error ?? null;
  };

  // The version's current snapshot (remembered, so the painting pages can load it), its keys and its file hashes.
  const current = versionId => {
    const snap = snapshotOf(db, versionId);
    if (!snap) return null;
    rememberSnapshot(snap);
    return { snap, keys: segmentKeys(snap, engine), shas: currentShas(snap) };
  };

  const dirty = new Set();
  let timer = null, lastPublished = 0;
  const flush = () => {
    timer = null; lastPublished = Date.now();
    for (const versionId of dirty) {
      try {
        const c = coverage(versionId);
        if (c) events?.publish('frames', { versionId, ranges: c.ranges, broken: c.broken });
      } catch (e) { console.error(`frames event for ${versionId}: ${e.message}`); }
    }
    dirty.clear();
  };
  const changed = versionId => {
    dirty.add(versionId);
    timer ??= setTimeout(flush, Math.max(0, lastPublished + publishEveryMs - Date.now()));
  };

  // Resolves to { file, key, depsHash } once painted, { broken, key } if its segment broke, or { retry, key } if the
  // request was superseded, cancelled or couldn't be painted (it's worth asking again).
  const paint = (versionId, cur, i, prio, signal) => {
    const key = cur.keys[chapterOfFrame(i)];
    return pool.request({ versionId, snapshotId: cur.snap.id, key, frame: i, prio, currentShas: cur.shas, signal }).then(r => {
      if (r.broken) { broken.set(key, { error: r.error, until: r.until ?? null }); changed(versionId); return { broken: r.error, key }; }
      const found = r.ok && cache.find(key, i, cur.shas);
      if (!found) return { retry: r.error || 'not in the cache', key };
      changed(versionId);
      return { file: found.path, depsHash: found.depsHash, key };
    });
  };

  // { file, key, depsHash } when cached; { pending: Promise (as paint's), key } while it's painted; { broken, key } for
  // a broken segment; { missing } for a version or chapter that doesn't exist. A preview request supersedes the
  // version's older queued ones: only the newest playhead position matters. signal: aborting it withdraws the request.
  function frame(versionId, i, prio = 'preview', { signal } = {}) {
    const cur = current(versionId);
    if (!cur) return { missing: 'no such version' };
    const n = chapterOfFrame(i), key = cur.keys[n];
    if (!key) return { missing: `chapter ${n} isn't written yet` };
    const b = brokenOf(key);
    if (b) return { broken: b, key };
    const found = cache.find(key, i, cur.shas);
    if (found) { cache.touch(key); return { file: found.path, depsHash: found.depsHash, key }; }
    if (prio === 'preview') pool.supersede(versionId, 'preview');
    return { pending: paint(versionId, cur, i, prio, signal), key };
  }

  // The bytes of a cached frame valid for the version's current snapshot: { bytes, key, depsHash }, or null (not
  // cached: ask again). Files are never replaced once written, so what's read is the frame that was found.
  async function read(versionId, i) {
    const cur = current(versionId);
    const key = cur?.keys[chapterOfFrame(i)], found = key && cache.find(key, i, cur.shas);
    if (!found) return null;
    try { return { bytes: await Bun.file(found.path).bytes(), key, depsHash: found.depsHash }; } catch { return null; }
  }

  // { total, ranges: [[first, last], ...] cached for the current snapshot, broken: [{ chapter, error }] }, or null.
  function coverage(versionId) {
    const cur = current(versionId);
    if (!cur) return null;
    const brokenChapters = Object.entries(cur.keys).filter(([, k]) => k && brokenOf(k)).map(([n, k]) => ({ chapter: +n, error: brokenOf(k) }));
    return { total: N, ranges: cache.coverage(cur.keys, cur.shas), broken: brokenChapters };
  }

  // Queues the missing frames of [from, from + count) at prefetch priority, in place of the version's earlier prefetch.
  function prefetch(versionId, from, count) {
    const cur = current(versionId);
    if (!cur) return 0;
    pool.supersede(versionId, 'prefetch');
    let queued = 0;
    for (let i = Math.max(0, from); i < Math.min(N, from + count); i++) {
      const key = cur.keys[chapterOfFrame(i)];
      if (!key || brokenOf(key) || cache.has(key, i, cur.shas)) continue;
      paint(versionId, cur, i, 'prefetch');
      queued++;
    }
    return queued;
  }

  // Paints every missing frame of a final render (frames from..to, the whole song by default) at render priority,
  // with the segments pinned so eviction can't take them before they're encoded (and a frame file, once written, is
  // never replaced). Resolves to { snapshot, keys, files: the frame files in order, release() }: the caller releases
  // the pins when done. Rejects (and releases them) when a chapter is missing or broken.
  async function fillForRender(versionId, onProgress, { from = 0, to = N - 1 } = {}) {
    const cur = current(versionId);
    if (!cur) throw new Error('no such version');
    const frames = Array.from({ length: to - from + 1 }, (_, k) => from + k);
    const chapters = [...new Set(frames.map(chapterOfFrame))];
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
        const found = cache.find(cur.keys[chapterOfFrame(i)], i, cur.shas);
        if (found) files.set(i, found.path); else todo.push(i);
      }
      let done = frames.length - todo.length;
      onProgress?.(done / frames.length);
      await Promise.all(todo.map(i => paint(versionId, cur, i, 'render').then(r => {
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

  return { frame, read, coverage, prefetch, fillForRender, cache };
}
