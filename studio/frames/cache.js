// cache.js: the frame cache on disk. Frames are <dir>/<segmentKey>/f<frameIndex>.jpg, with a sidecar
// f<frameIndex>.deps.json listing { chapterPath: contentHash } for the other chapters whose CAST entries the frame read
// (none: no sidecar). <dir>/cache.json indexes the segments: their size and how recently each was used (file access
// times aren't reliable), so that over the cap, whole least-recently-used segments go first. Pins (held by a running
// final render) live in memory only: they belong to this process's jobs.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { framesOfChapter } from './keys.js';

const KEY = /^[0-9a-f]{64}$/, FRAME = /^f(\d+)\.jpg$/, DEPS = /^f(\d+)\.deps\.json$/;

export function createCache({ dir, capBytes }) {
  mkdirSync(dir, { recursive: true });
  const indexFile = join(dir, 'cache.json');
  // key -> { used: logical clock of the last use, bytes, frames: Map<frame, deps object or null> | null until read }
  const segments = new Map(), pins = new Map();
  let clock = 0;

  const writeAtomic = (file, data) => { writeFileSync(file + '.tmp', data); renameSync(file + '.tmp', file); };
  const save = () => writeAtomic(indexFile, JSON.stringify({
    clock, segments: Object.fromEntries([...segments].map(([k, s]) => [k, { used: s.used, bytes: s.bytes }])),
  }));
  const sizeOf = f => { try { return statSync(f).size; } catch { return 0; } };

  // What's on disk is the truth; the index adds recency (and saves stat-ing every frame at start). A segment folder
  // the index doesn't know (it was written just before a crash) is counted as the least recently used.
  let saved = {};
  try { saved = JSON.parse(readFileSync(indexFile, 'utf8')); } catch {}
  clock = saved.clock || 0;
  for (const k of readdirSync(dir).filter(n => KEY.test(n))) {
    const known = saved.segments?.[k];
    const bytes = known?.bytes ?? readdirSync(join(dir, k)).filter(f => FRAME.test(f) || DEPS.test(f)).reduce((sum, f) => sum + sizeOf(join(dir, k, f)), 0);
    segments.set(k, { used: known?.used ?? 0, bytes, frames: null });
  }

  // A segment's frames, read from its folder the first time they're needed.
  const framesOf = key => {
    const seg = segments.get(key);
    if (!seg) return null;
    if (!seg.frames) {
      seg.frames = new Map();
      const names = readdirSync(join(dir, key));
      for (const f of names) {
        const m = FRAME.exec(f);
        if (!m) continue;
        let deps = null;
        if (names.includes(`f${m[1]}.deps.json`)) { try { deps = JSON.parse(readFileSync(join(dir, key, `f${m[1]}.deps.json`), 'utf8')); } catch { continue; } }
        seg.frames.set(+m[1], deps);
      }
    }
    return seg.frames;
  };

  const path = (key, i) => join(dir, key, `f${i}.jpg`);

  function has(key, i, currentShas) {
    const frames = framesOf(key);
    if (!frames?.has(i)) return false;
    const deps = frames.get(i);
    return !deps || Object.entries(deps).every(([p, sha]) => currentShas[p] === sha);
  }

  const mostRecent = () => { let best = null; for (const [k, s] of segments) if (!best || s.used > segments.get(best).used) best = k; return best; };

  function touch(key) {
    const seg = segments.get(key);
    if (!seg || key === mostRecent()) return;   // already the most recently used: nothing to record
    seg.used = ++clock;
    save();
  }

  function put(key, i, jpegBytes, deps = {}) {
    if (!KEY.test(key)) throw new Error(`not a segment key: ${key}`);
    mkdirSync(join(dir, key), { recursive: true });
    if (!segments.has(key)) segments.set(key, { used: 0, bytes: 0, frames: new Map() });
    const seg = segments.get(key), frames = framesOf(key), depsFile = join(dir, key, `f${i}.deps.json`);
    const before = sizeOf(path(key, i)) + sizeOf(depsFile), hasDeps = deps && Object.keys(deps).length > 0;
    // The sidecar first: a frame file never sits next to dependencies that aren't its own.
    if (hasDeps) writeAtomic(depsFile, JSON.stringify(deps)); else if (existsSync(depsFile)) unlinkSync(depsFile);
    writeAtomic(path(key, i), jpegBytes);
    seg.bytes += sizeOf(path(key, i)) + sizeOf(depsFile) - before;
    frames.set(i, hasDeps ? deps : null);
    seg.used = ++clock;
    save();
    evict();
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
      if (!keys[n] || !segments.has(keys[n])) continue;
      const [first, last] = framesOfChapter(n);
      const cached = [...framesOf(keys[n]).keys()].filter(i => i >= first && i <= last && has(keys[n], i, currentShas)).sort((a, b) => a - b);
      for (const i of cached) {
        const r = ranges[ranges.length - 1];
        if (r && r[1] === i - 1) r[1] = i; else ranges.push([i, i]);
      }
    }
    return ranges;
  }

  return { has, path, put, touch, pin, unpin, usedBytes, evict, clear, coverage, capBytes, dir };
}
