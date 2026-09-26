import { test, expect } from 'bun:test';
import { cpSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FPS, N, DURATION, frameRange, chapterOfFrame, framesOfChapter, engineHash, segmentKey, segmentKeys, currentShas, depsOf, depsHash } from '../studio/frames/keys.js';
import { CHAPTER_WINDOWS } from '../studio/storyboard.js';
import { sha256 } from '../studio/snapshot.js';
import { tempDir } from './helpers.js';

const root = process.cwd();

test('the song is 3759 frames at 24 fps', () => {
  expect(FPS).toBe(24);
  expect(N).toBe(3759);
});

test('frameRange turns a range in seconds into the frames whose times fall in it, the song\'s last partial frame included', () => {
  expect(frameRange(0, DURATION)).toEqual({ first: 0, last: N - 1 });   // 0..3758: t = 156.583 is in the song
  expect(frameRange(0, 999)).toEqual({ first: 0, last: N - 1 });
  expect(frameRange(0, .25)).toEqual({ first: 0, last: 5 });
  // Exact at frame boundaries, whatever the floating point does to first / FPS and (last + 1) / FPS.
  for (const [f, l] of [[200, 223], [96, 105], [532, 571], [1, 1], [3700, 3758]]) expect(frameRange(f / FPS, (l + 1) / FPS)).toEqual({ first: f, last: l });
  expect(frameRange(40, 40.5)).toEqual({ first: 960, last: 971 });
  // Another frame rate, and its own frame count (render.mjs --fps).
  expect(frameRange(0, DURATION, 30, Math.ceil(DURATION * 30))).toEqual({ first: 0, last: 4697 });
  expect(frameRange(5, 5).last).toBeLessThan(frameRange(5, 5).first);   // empty
});

test('chapterOfFrame follows the chapter windows, boundaries included', () => {
  expect(chapterOfFrame(0)).toBe(1);
  expect(chapterOfFrame(551)).toBe(1);   // 22.958 s
  expect(chapterOfFrame(552)).toBe(2);   // 23.0 s exactly
  expect(chapterOfFrame(2289)).toBe(5);  // 95.375 s (chapter 6 starts at 95.4)
  expect(chapterOfFrame(2290)).toBe(6);
  expect(chapterOfFrame(3758)).toBe(9);  // the last frame
  expect(() => chapterOfFrame(3759)).toThrow();
  expect(() => chapterOfFrame(-1)).toThrow();
});

test('framesOfChapter agrees with chapterOfFrame and covers every frame exactly once', () => {
  let next = 0;
  for (let n = 1; n <= 9; n++) {
    const [first, last] = framesOfChapter(n);
    expect(first).toBe(next);
    expect(chapterOfFrame(first)).toBe(n);
    expect(chapterOfFrame(last)).toBe(n);
    if (n < 9) expect(chapterOfFrame(last + 1)).toBe(n + 1);
    // the window as the engine sees it: first frame at or after its start, last before its end
    expect(first / FPS).toBeGreaterThanOrEqual(CHAPTER_WINDOWS[n - 1][0]);
    expect(last / FPS).toBeLessThan(CHAPTER_WINDOWS[n - 1][1]);
    next = last + 1;
  }
  expect(next).toBe(N);
  expect(framesOfChapter(2)).toEqual([552, 923]);
});

test('segmentKey changes with each input and is stable otherwise', () => {
  const base = { engine: sha256('engine'), options: { wipes: true, cornerMeter: true }, sharedSha: sha256('shared'), chapterSha: sha256('chapter') };
  const k = segmentKey(base);
  expect(k).toMatch(/^[0-9a-f]{64}$/);
  expect(segmentKey({ ...base })).toBe(k);
  // options are compared by value, whatever their key order
  expect(segmentKey({ ...base, options: { cornerMeter: true, wipes: true } })).toBe(k);
  const variants = [
    { engine: sha256('engine 2') },
    { options: { wipes: false, cornerMeter: true } },
    { sharedSha: sha256('shared 2') },
    { sharedSha: null },
    { chapterSha: sha256('chapter 2') },
  ].map(v => segmentKey({ ...base, ...v }));
  expect(new Set([k, ...variants]).size).toBe(variants.length + 1);
});

test('segmentKeys gives each chapter its own key, null where a chapter is missing', () => {
  const snap = { options: { wipes: true, cornerMeter: true }, files: { 'shared.js': sha256('s'), 'ch/c01_lab.js': sha256('1'), 'ch/c02.js': sha256('2'), 'STORYBOARD.md': sha256('sb') } };
  const keys = segmentKeys(snap, sha256('engine'));
  expect(Object.keys(keys).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(keys[1]).toMatch(/^[0-9a-f]{64}$/);
  expect(keys[2]).not.toBe(keys[1]);
  for (let n = 3; n <= 9; n++) expect(keys[n]).toBeNull();
  // the storyboard doesn't paint anything, so it isn't part of any key
  const edited = segmentKeys({ ...snap, files: { ...snap.files, 'STORYBOARD.md': sha256('sb 2') } }, sha256('engine'));
  expect(edited).toEqual(keys);
  // a changed chapter changes only its own key; shared.js changes all of them
  const c2 = segmentKeys({ ...snap, files: { ...snap.files, 'ch/c02.js': sha256('2b') } }, sha256('engine'));
  expect(c2[1]).toBe(keys[1]);
  expect(c2[2]).not.toBe(keys[2]);
  const shared = segmentKeys({ ...snap, files: { ...snap.files, 'shared.js': sha256('s2') } }, sha256('engine'));
  expect(shared[1]).not.toBe(keys[1]);
  expect(shared[2]).not.toBe(keys[2]);
});

test('depsOf maps CAST reads to the other chapters that defined them', () => {
  const snap = { options: {}, files: { 'shared.js': sha256('s'), 'ch/c03_takeoff.js': sha256('3'), 'ch/c04.js': sha256('4'), 'ch/c09_finale.js': sha256('9') } };
  // an entry of another chapter's is a dependency; one of shared.js's or the frame's own chapter's isn't (both are in its key)
  expect(depsOf([{ key: 'sydney', path: 'ch/c03_takeoff.js' }, { key: 'helper', path: 'shared.js' }, { key: 'mine', path: 'ch/c09_finale.js' }], snap, 9))
    .toEqual({ 'ch/c03_takeoff.js': sha256('3') });
  expect(depsOf([], snap, 9)).toEqual({});
  // reading an entry nobody defined depends on which chapters exist at all: adding one could define it
  const missing = depsOf([{ key: 'gato', path: null }], snap, 9);
  expect(Object.keys(missing)).toEqual(['*']);
  expect(missing['*']).toBe(currentShas(snap)['*']);
  const withNewChapter = { ...snap, files: { ...snap.files, 'ch/c05.js': sha256('5') } };
  expect(currentShas(withNewChapter)['*']).not.toBe(missing['*']);
});

test('depsOf folds in what the frame\'s chapter, and every chapter it takes an entry from, read while loading', () => {
  const files = { 'shared.js': sha256('s'), 'ch/c02.js': sha256('2'), 'ch/c05.js': sha256('5'), 'ch/c07.js': sha256('7'), 'ch/c09.js': sha256('9') };
  const snap = { options: {}, files };
  const loadReads = {
    'ch/c09.js': [{ key: 'guest', path: 'ch/c02.js' }],        // const { guest } = CAST, at load
    'ch/c05.js': [{ key: 'inner', path: 'ch/c07.js' }],        // chapter 5's wrapper took chapter 7's entry at load
    'ch/c07.js': [],
    'shared.js': [{ key: 'early', path: null }],               // shared.js loads first and is in every key anyway
  };
  expect(depsOf([], snap, 9, loadReads)).toEqual({ 'ch/c02.js': files['ch/c02.js'] });
  expect(depsOf([{ key: 'wrapper', path: 'ch/c05.js' }], snap, 9, loadReads))
    .toEqual({ 'ch/c02.js': files['ch/c02.js'], 'ch/c05.js': files['ch/c05.js'], 'ch/c07.js': files['ch/c07.js'] });
  // another chapter's load-time reads don't concern a frame that takes nothing from it
  expect(depsOf([], snap, 3, loadReads)).toEqual({});
});

test('depsHash names a set of dependencies, whatever its key order, and "-" for none', () => {
  expect(depsHash({})).toBe('-');
  expect(depsHash(null)).toBe('-');
  const a = depsHash({ 'ch/c02.js': sha256('2'), 'ch/c03.js': sha256('3') });
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(depsHash({ 'ch/c03.js': sha256('3'), 'ch/c02.js': sha256('2') })).toBe(a);
  expect(depsHash({ 'ch/c02.js': sha256('2') })).not.toBe(a);
});

// A copy of the files engineHash covers, so one byte can be changed without touching the repo.
function copyEngine() {
  const dir = tempDir('engine-');
  for (const p of ['studio.html', 'src', 'node_modules/p5/lib/p5.min.js', 'node_modules/p5.brush/dist/p5.brush.js', 'assets/fonts']) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    cpSync(join(root, p), join(dir, p), { recursive: true });
  }
  return dir;
}

test('engineHash covers the engine files, whatever folder they are in, and changes when one byte does', () => {
  const a = copyEngine(), b = copyEngine();
  expect(engineHash(root)).toMatch(/^[0-9a-f]{64}$/);
  expect(engineHash(a)).toBe(engineHash(root));
  appendFileSync(join(b, 'src/core.js'), ' ');
  expect(engineHash(b)).not.toBe(engineHash(a));
  const c = copyEngine();
  appendFileSync(join(c, 'assets/fonts/fonts.css'), ' ');
  expect(engineHash(c)).not.toBe(engineHash(a));
});

test('engineHash is worked out once per folder, unless asked to recheck (the server\'s --dev): then an engine edit changes it', () => {
  const a = copyEngine(), before = engineHash(a);
  appendFileSync(join(a, 'src/core.js'), ' ');
  expect(engineHash(a)).toBe(before);   // memoised: outside --dev the engine doesn't change while the studio runs
  const edited = engineHash(a, { recheck: true });
  expect(edited).not.toBe(before);
  expect(engineHash(a, { recheck: true })).toBe(edited);   // nothing changed since
  expect(engineHash(a)).toBe(edited);
  writeFileSync(join(a, 'src/extra.js'), '// a new engine script');
  expect(engineHash(a, { recheck: true })).not.toBe(edited);
});
