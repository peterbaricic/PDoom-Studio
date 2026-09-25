// cache.js: the frame cache on disk, one folder per segment: <dir>/<segmentKey>/. A frame that read no other chapter's
// CAST entries is f<frameIndex>.jpg; one that did is f<frameIndex>-<depsHash>.jpg, next to f<frameIndex>-<depsHash>.deps.json
// listing those dependencies ({ chapterPath: contentHash }, see depsOf in keys.js). So the same frame of the same
// segment painted against different dependencies (two versions sharing a chapter but not the chapters it borrows
// from) is two files, and a file, once written, is never replaced: a path handed out stays valid as long as its
// segment is there, which pinning guarantees.
// <dir>/cache.json indexes the segments by how recently each was used (file access times aren't reliable), so that
// over the cap, whole least-recently-used segments go first. Pins (held by a running final render) live in memory
// only: they belong to this process's jobs.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { framesOfChapter, depsHash } from './keys.js';

const KEY = /^[0-9a-f]{64}$/, FRAME = /^f(\d+)(?:-([0-9a-f]{64}))?\.jpg$/;

export function createCache({ dir, capBytes }) {
  mkdirSync(dir, { recursive: true });
  const indexFile = join(dir, 'cache.json');
  // key -> { used: logical clock of the last use, bytes, frames: Map<frame, Map<depsHash, deps | null>> | null until read }
  const segments = new Map(), pins = new Map();
  let clock = 0;

  const writeAtomic = (file, data) => { writeFileSync(file + '.tmp', data); renameSync(file + '.tmp', file); };
  const save = () => writeAtomic(indexFile, JSON.stringify({ clock, segments: Object.fromEntries([...segments].map(([k, s]) => [k, { used: s.used }])) }));
  const sizeOf = f => { try { return statSync(f).size; } catch { return 0; } };
  const fileName = (i, h) => h === '-' ? `f${i}.jpg` : `f${i}-${h}.jpg`;
  const path = (key, i, h = '-') => join(dir, key, fileName(i, h));
  const depsFile = (key, i, h) => join(dir, key, `f${i}-${h}.deps.json`);

  // What's on disk is the truth: the segments are its folders (an index entry without one is dropped, a folder the
  // index doesn't know counts as the least recently used), their sizes are what's in them, and anything a crash left
  // half-written (*.tmp) goes. The index only adds recency.
  let saved = {};
  try { saved = JSON.parse(readFileSync(indexFile, 'utf8')); } catch {}
  clock = saved.clock || 0;
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.tmp')) { rmSync(join(dir, name), { force: true }); continue; }
    if (!KEY.test(name)) continue;
    let bytes = 0;
    try {
      for (const f of readdirSync(join(dir, name))) {
        if (f.endsWith('.tmp')) rmSync(join(dir, name, f), { force: true }); else bytes += sizeOf(join(dir, name, f));
      }
    } catch { continue; }
    segments.set(name, { used: saved.segments?.[name]?.used ?? 0, bytes, frames: null });
  }
  save();

  // A segment's frames, read from its folder the first time they're needed. A folder that has gone (deleted behind
  // the cache's back) takes its segment with it.
  const framesOf = key => {
    const seg = segments.get(key);
    if (!seg) return null;
    if (!seg.frames) {
      let names;
      try { names = readdirSync(join(dir, key)); } catch { segments.delete(key); return null; }
      seg.frames = new Map();
      for (const f of names) {
        const m = FRAME.exec(f);
        if (!m) continue;
        const i = +m[1], h = m[2] || '-';
        let deps = null;
        if (h !== '-') { try { deps = JSON.parse(readFileSync(depsFile(key, i, h), 'utf8')); } catch { continue; } }
        if (!seg.frames.has(i)) seg.frames.set(i, new Map());
        seg.frames.get(i).set(h, deps);
      }
    }
    return seg.frames;
  };

  const valid = (deps, currentShas) => !deps || Object.entries(deps).every(([p, sha]) => currentShas[p] === sha);

  // The frame valid for these current file hashes: { path, depsHash }, or null.
  function find(key, i, currentShas) {
    const variants = framesOf(key)?.get(i);
    for (const [h, deps] of variants || []) if (valid(deps, currentShas)) return { path: path(key, i, h), depsHash: h };
    return null;
  }
  const has = (key, i, currentShas) => !!find(key, i, currentShas);

  const mostRecent = () => { let best = null; for (const [k, s] of segments) if (!best || s.used > segments.get(best).used) best = k; return best; };

  function touch(key) {
    const seg = segments.get(key);
    if (!seg || key === mostRecent()) return;   // already the most recently used: nothing to record
    seg.used = ++clock;
    save();
  }

  // Stores a painted frame with the dependencies it was painted with; one already there is kept as it is.
  // Returns { path, depsHash }.
  function put(key, i, jpegBytes, deps = {}) {
    if (!KEY.test(key)) throw new Error(`not a segment key: ${key}`);
    const h = depsHash(deps);
    mkdirSync(join(dir, key), { recursive: true });
    if (!segments.has(key)) segments.set(key, { used: 0, bytes: 0, frames: new Map() });
    const seg = segments.get(key), frames = framesOf(key);
    if (!frames.get(i)?.has(h) || !existsSync(path(key, i, h))) {
      // The sidecar first: a frame file never sits there without its dependencies.
      if (h !== '-') { writeAtomic(depsFile(key, i, h), JSON.stringify(deps)); seg.bytes += sizeOf(depsFile(key, i, h)); }
      writeAtomic(path(key, i, h), jpegBytes);
      seg.bytes += sizeOf(path(key, i, h));
      if (!frames.has(i)) frames.set(i, new Map());
      frames.get(i).set(h, h === '-' ? null : deps);
    }
    seg.used = ++clock;
    save();
    evict();
    return { path: path(key, i, h), depsHash: h };
  }

  const pin = key => pins.set(key, (pins.get(key) || 0) + 1);
  const unpin = key => { const n = (pins.get(key) || 0) - 1; if (n > 0) pins.set(key, n); else pins.delete(key); };

  const usedBytes = () => { let sum = 0; for (const s of segments.values()) sum += s.bytes; return sum; };

  const remove = key => { rmSync(join(dir, key), { recursive: true, force: true }); segments.delete(key); };

  // Whole segments, least recently used first, until usage is under the cap. Never a pinned one, and never the most
  // recently used: that's the one being painted or played right now, and dropping it would only have it repainted.
  function evict() {
    let used = usedBytes(), changed = false;
    const keep = mostRecent();
    const candidates = [...segments].filter(([k]) => !pins.has(k) && k !== keep).sort((a, b) => a[1].used - b[1].used);
    for (const [k, s] of candidates) {
      if (used <= capBytes) break;
      remove(k); used -= s.bytes; changed = true;
    }
    if (changed) save();
  }

  // Everything that isn't pinned.
  function clear() {
    for (const k of [...segments.keys()]) if (!pins.has(k)) remove(k);
    save();
  }

  // [[first, last], ...] (inclusive, merged) of the frames cached for these keys ({ 1..9: key | null }) that are valid
  // for these current file hashes.
  function coverage(keys, currentShas) {
    const ranges = [];
    for (let n = 1; n <= 9; n++) {
      const frames = keys[n] && framesOf(keys[n]);
      if (!frames) continue;
      const [first, last] = framesOfChapter(n);
      const cached = [...frames.keys()].filter(i => i >= first && i <= last && has(keys[n], i, currentShas)).sort((a, b) => a - b);
      for (const i of cached) {
        const r = ranges[ranges.length - 1];
        if (r && r[1] === i - 1) r[1] = i; else ranges.push([i, i]);
      }
    }
    return ranges;
  }

  return { has, find, path, put, touch, pin, unpin, usedBytes, evict, clear, coverage, capBytes, dir };
}
