// service.js: frames for versions, by way of the cache and the painting pool. A version's frames are always looked up
// under its current snapshot's segment keys (studio/frames/keys.js), so when a chapter changes, only that chapter's
// frames stop counting as cached (and any frame that read one of its CAST entries); the rest stay. Publishes the SSE
// event `frames` { versionId, ranges, broken } as frames get painted or segments break, at most every 500 ms.
import { snapshotOf, rememberSnapshot } from '../snapshot.js';
import { N, chapterOfFrame, engineHash, segmentKeys, currentShas } from './keys.js';

export function createFrameService({ db, cache, pool, events, root, publishEveryMs = 500 }) {
  const engine = engineHash(root);
  const broken = new Map();   // segment key -> error; a key never changes meaning, so this is never cleared

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
      const c = coverage(versionId);
      if (c) events?.publish('frames', { versionId, ranges: c.ranges, broken: c.broken });
    }
    dirty.clear();
  };
  const changed = versionId => {
    dirty.add(versionId);
    timer ??= setTimeout(flush, Math.max(0, lastPublished + publishEveryMs - Date.now()));
  };

  // Resolves to { file, key } once painted, { broken, key } if its segment broke, or { retry, key } if the request
  // was superseded or the pool couldn't paint it (it's worth asking again).
  const paint = (versionId, cur, i, prio) => {
    const key = cur.keys[chapterOfFrame(i)];
    return pool.request({ versionId, snapshotId: cur.snap.id, key, frame: i, prio, currentShas: cur.shas }).then(r => {
      if (r.ok) { changed(versionId); return { file: cache.path(key, i), key }; }
      if (r.broken) { broken.set(key, r.error); changed(versionId); return { broken: r.error, key }; }
      return { retry: r.error, key };
    });
  };

  // { file, key } when cached; { pending: Promise (as paint's), key } while it's painted; { broken, key } for a broken
  // segment; { missing } for a version or chapter that doesn't exist. A preview request supersedes the version's
  // older queued ones: only the newest playhead position matters.
  function frame(versionId, i, prio = 'preview') {
    const cur = current(versionId);
    if (!cur) return { missing: 'no such version' };
    const n = chapterOfFrame(i), key = cur.keys[n];
    if (!key) return { missing: `chapter ${n} isn't written yet` };
    if (broken.has(key)) return { broken: broken.get(key), key };
    if (cache.has(key, i, cur.shas)) { cache.touch(key); return { file: cache.path(key, i), key }; }
    if (prio === 'preview') pool.supersede(versionId, 'preview');
    return { pending: paint(versionId, cur, i, prio), key };
  }

  // The bytes of a cached frame, as long as they're still valid for the version's current snapshot once read: a frame
  // file can be replaced at any moment (repainted for another version sharing its segment but not the chapters its
  // CAST entries came from), and put() swaps the file and the index in one synchronous step, so a check after the
  // read catches that. { bytes, key }, or null (not cached, or no longer valid: ask again).
  async function read(versionId, i) {
    let cur = current(versionId);
    const key = cur?.keys[chapterOfFrame(i)];
    if (!key || !cache.has(key, i, cur.shas)) return null;
    let bytes;
    try { bytes = await Bun.file(cache.path(key, i)).bytes(); } catch { return null; }
    cur = current(versionId);
    return cur?.keys[chapterOfFrame(i)] === key && cache.has(key, i, cur.shas) ? { bytes, key } : null;
  }

  // { total, ranges: [[first, last], ...] cached for the current snapshot, broken: [{ chapter, error }] }, or null.
  function coverage(versionId) {
    const cur = current(versionId);
    if (!cur) return null;
    const brokenChapters = Object.entries(cur.keys).filter(([, k]) => k && broken.has(k)).map(([n, k]) => ({ chapter: +n, error: broken.get(k) }));
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
      if (!key || broken.has(key) || cache.has(key, i, cur.shas)) continue;
      paint(versionId, cur, i, 'prefetch');
      queued++;
    }
    return queued;
  }

  // Paints every missing frame of a final render (frames from..to, the whole song by default) at render priority,
  // with the segments pinned so eviction can't take them before they're encoded. Resolves to { snapshot, keys, files:
  // the frame files in order, release() }: the caller releases the pins when done. Rejects (and releases them) when a
  // chapter is missing or broken.
  async function fillForRender(versionId, onProgress, { from = 0, to = N - 1 } = {}) {
    const cur = current(versionId);
    if (!cur) throw new Error('no such version');
    const frames = Array.from({ length: to - from + 1 }, (_, k) => from + k);
    const chapters = [...new Set(frames.map(chapterOfFrame))];
    for (const n of chapters) {
      if (!cur.keys[n]) throw new Error(`chapter ${n} isn't written yet`);
      if (broken.has(cur.keys[n])) throw new Error(`chapter ${n} is broken: ${broken.get(cur.keys[n])}`);
    }
    const pinned = [...new Set(chapters.map(n => cur.keys[n]))];
    pinned.forEach(cache.pin);
    let released = false;
    const release = () => { if (!released) { released = true; pinned.forEach(cache.unpin); } };
    try {
      const todo = frames.filter(i => !cache.has(cur.keys[chapterOfFrame(i)], i, cur.shas));
      let done = frames.length - todo.length;
      onProgress?.(done / frames.length);
      await Promise.all(todo.map(i => paint(versionId, cur, i, 'render').then(r => {
        if (r.broken) throw new Error(`chapter ${chapterOfFrame(i)} is broken: ${r.broken}`);
        if (!r.file) throw new Error(`frame ${i} was not painted: ${r.retry}`);
        onProgress?.(++done / frames.length);
      })));
    } catch (e) {
      pool.supersede(versionId, 'render');
      release();
      throw e;
    }
    return { snapshot: cur.snap, keys: cur.keys, files: frames.map(i => cache.path(cur.keys[chapterOfFrame(i)], i)), release };
  }

  return { frame, read, coverage, prefetch, fillForRender, cache };
}
