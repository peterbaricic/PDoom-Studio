// keys.js: what a cached frame is keyed by. A frame at time t is fully determined by the engine, the version's options,
// its shared.js and the chapter covering t, so frames are cached per chapter segment under
// segment key = SHA-256(engineHash, options with sorted keys, shared.js's content hash or '-', the chapter's content hash).
// The one exception, CAST entries another chapter defined (the Original's curtain call), is tracked per frame as
// dependencies (depsOf) next to the frame itself — see studio/frames/cache.js.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CHAPTER_WINDOWS } from '../storyboard.js';
import { sha256, canonicalJson } from '../snapshot.js';

export const FPS = 24, DURATION = 156.6, N = Math.ceil(DURATION * FPS);

// The frames a range of seconds [a, b) covers: those whose time i / fps falls in it, clamped to the song's n frames.
// The song ends partway through its last frame (156.6 s is frame 3758.4), which is a frame all the same: the default
// full range 0..DURATION is frames 0..N-1. The small epsilon keeps a bound that is exactly a frame's time (as
// first / fps and (last + 1) / fps are, give or take floating point) on that frame.
export function frameRange(a, b, fps = FPS, n = N) {
  return { first: Math.max(0, Math.ceil(a * fps - 1e-6)), last: Math.min(n - 1, Math.ceil(b * fps - 1e-6) - 1) };
}

// Which chapter window each frame falls in, by t = i / FPS, exactly as the engine picks the chapter for t
// (t >= start && t < end).
const CHAPTER_OF = new Uint8Array(N).map((_, i) => 1 + CHAPTER_WINDOWS.findIndex(([a, b]) => i / FPS >= a && i / FPS < b));
const FRAMES_OF = CHAPTER_WINDOWS.map((_, k) => [CHAPTER_OF.indexOf(k + 1), CHAPTER_OF.lastIndexOf(k + 1)]);

export function chapterOfFrame(i) {
  if (!(Number.isInteger(i) && i >= 0 && i < N)) throw new Error(`no frame ${i} (frames run 0..${N - 1})`);
  return CHAPTER_OF[i];
}

// [first, last] frame index of chapter n (1..9), both inclusive.
export const framesOfChapter = n => FRAMES_OF[n - 1];

// The files that decide what the painting page draws, besides the version's own code: the page, the engine scripts,
// the two libraries it loads and the bundled fonts. Hashed by path (relative to root) and content, so the same engine
// in another folder hashes the same. Memoised per root: the engine doesn't change while the studio runs, except
// under --dev, where someone may be working on it: recheck then looks at the files' sizes and modification times on
// every call (a stat each, no reading), and hashes them again when any changed, so frames of the old engine and the
// new one never mix.
const ENGINE_FILES = root => [
  'studio.html', 'node_modules/p5/lib/p5.min.js', 'node_modules/p5.brush/dist/p5.brush.js',
  ...readdirSync(join(root, 'src')).filter(f => f.endsWith('.js')).map(f => `src/${f}`),
  ...readdirSync(join(root, 'assets/fonts')).map(f => `assets/fonts/${f}`),
].sort();
const engineHashes = new Map();   // root -> { hash, stamp }
const stampOf = (root, files) => files.map(p => { const s = statSync(join(root, p)); return `${p}:${s.size}:${s.mtimeMs}`; }).join('|');
export function engineHash(root, { recheck = false } = {}) {
  const known = engineHashes.get(root);
  if (known && !recheck) return known.hash;
  const files = ENGINE_FILES(root), stamp = stampOf(root, files);
  if (known && known.stamp === stamp) return known.hash;
  const h = createHash('sha256');
  for (const p of files) h.update(`${p}\0${createHash('sha256').update(readFileSync(join(root, p))).digest('hex')}\n`);
  engineHashes.set(root, { hash: h.digest('hex'), stamp });
  return engineHashes.get(root).hash;
}

export const segmentKey = ({ engine, options, sharedSha, chapterSha }) =>
  sha256([engine, canonicalJson(options), sharedSha || '-', chapterSha].join('\n'));

// A version's files for chapter n (ch/c0<n>.js or ch/c0<n>_<name>.js; normally exactly one).
export const chapterPaths = (files, n) => Object.keys(files).filter(p => new RegExp(`^ch/c0${n}(_|\\.)`).test(p)).sort();

// One chapter's content hash: its file's, or for the odd chapter split over several files, a hash over all of them.
function chapterSha(files, n) {
  const paths = chapterPaths(files, n);
  if (paths.length <= 1) return paths.length ? files[paths[0]] : null;
  return sha256(paths.map(p => `${p} ${files[p]}`).join('\n'));
}

// { 1..9: segment key, or null for a chapter the version doesn't have (yet) }, for a snapshot (studio/snapshot.js).
export function segmentKeys(snapshot, engine) {
  const keys = {};
  for (let n = 1; n <= 9; n++) {
    const ch = chapterSha(snapshot.files, n);
    keys[n] = ch && segmentKey({ engine, options: snapshot.options, sharedSha: snapshot.files['shared.js'], chapterSha: ch });
  }
  return keys;
}

// What a cached frame's dependencies are checked against: every file's content hash, plus '*', a hash over the whole
// set of chapters — which a frame depends on when it read a CAST entry no chapter had defined (any chapter added or
// changed could define it).
export function currentShas(snapshot) {
  const chapters = Object.keys(snapshot.files).filter(p => p.startsWith('ch/')).sort();
  return { ...snapshot.files, '*': sha256(chapters.map(p => `${p} ${snapshot.files[p]}`).join('\n')) };
}

// The dependencies of a frame of chapter n: { path: content hash } for each other chapter whose CAST entries it read,
// '*' (see currentShas) if it read one no chapter defined. castReads are what the frame read while painting
// ({ key, path: the script that defined it, or null }, as the painting page reports them); loadReads, what each script
// read while it loaded ({ path: [read, ...] }). The frame's own chapter's load-time reads count as the frame's, and
// so, for each chapter it takes an entry from, do that chapter's (an entry can wrap another chapter's). Entries from
// shared.js or the frame's own chapter need nothing: both are part of its segment key already.
export function depsOf(castReads, snapshot, n, loadReads = {}) {
  const own = chapterPaths(snapshot.files, n), deps = {}, folded = new Set(own);
  const todo = [...castReads, ...own.flatMap(p => loadReads[p] || [])];
  while (todo.length) {
    const { path } = todo.pop();
    if (path === 'shared.js') continue;
    if (!(path && path.startsWith('ch/') && snapshot.files[path])) { deps['*'] = currentShas(snapshot)['*']; continue; }
    if (!own.includes(path)) deps[path] = snapshot.files[path];
    if (!folded.has(path)) { folded.add(path); todo.push(...(loadReads[path] || [])); }
  }
  return deps;
}

// Names one set of dependencies: '-' for none, else a hash of them. A frame is cached once per set it was painted
// with (see studio/frames/cache.js).
export const depsHash = deps => deps && Object.keys(deps).length ? sha256(canonicalJson(deps)) : '-';
