// keys.js: what a cached frame is keyed by. A frame at time t is fully determined by the engine, the version's options,
// its shared.js and the chapter covering t, so frames are cached per chapter segment under
// segment key = SHA-256(engineHash, options with sorted keys, shared.js's content hash or '-', the chapter's content hash).
// The one exception, CAST entries another chapter defined (the Original's curtain call), is tracked per frame as
// dependencies (depsOf) next to the frame itself — see studio/frames/cache.js.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CHAPTER_WINDOWS } from '../storyboard.js';
import { sha256, canonicalJson } from '../snapshot.js';

export const FPS = 24, DURATION = 156.6, N = Math.ceil(DURATION * FPS);

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
// in another folder hashes the same. Memoised per root: the engine doesn't change while the studio runs.
const ENGINE_FILES = root => [
  'studio.html', 'node_modules/p5/lib/p5.min.js', 'node_modules/p5.brush/dist/p5.brush.js',
  ...readdirSync(join(root, 'src')).filter(f => f.endsWith('.js')).map(f => `src/${f}`),
  ...readdirSync(join(root, 'assets/fonts')).map(f => `assets/fonts/${f}`),
].sort();
const engineHashes = new Map();
export function engineHash(root) {
  if (!engineHashes.has(root)) {
    const h = createHash('sha256');
    for (const p of ENGINE_FILES(root)) h.update(`${p}\0${createHash('sha256').update(readFileSync(join(root, p))).digest('hex')}\n`);
    engineHashes.set(root, h.digest('hex'));
  }
  return engineHashes.get(root);
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

// The dependencies of a frame of chapter n that read these CAST entries ({ key, path: the script that defined it, or
// null }, as the painting page reports them): { path: content hash } for each other chapter whose entries it read.
// Entries from shared.js or the frame's own chapter need nothing: both are part of its segment key already.
export function depsOf(castReads, snapshot, n) {
  const own = new Set(chapterPaths(snapshot.files, n)), deps = {};
  for (const { path } of castReads) {
    if (path === 'shared.js' || own.has(path)) continue;
    if (path && path.startsWith('ch/') && snapshot.files[path]) deps[path] = snapshot.files[path];
    else deps['*'] = currentShas(snapshot)['*'];
  }
  return deps;
}
