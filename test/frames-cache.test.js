import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCache } from '../studio/frames/cache.js';
import { framesOfChapter } from '../studio/frames/keys.js';
import { sha256 } from '../studio/snapshot.js';
import { tempDir } from './helpers.js';

const key = name => sha256(`segment ${name}`);
const jpeg = (size, fill = 1) => new Uint8Array(size).fill(fill);
const noKeys = () => Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => [n, null]));

test('put, has and path; a frame lives at <dir>/<key>/f<i>.jpg', () => {
  const dir = tempDir('cache-'), cache = createCache({ dir, capBytes: 1e9 });
  expect(cache.has(key('a'), 3, {})).toBe(false);
  cache.put(key('a'), 3, jpeg(100), {});
  expect(cache.has(key('a'), 3, {})).toBe(true);
  expect(cache.has(key('a'), 4, {})).toBe(false);
  expect(cache.has(key('b'), 3, {})).toBe(false);
  expect(cache.path(key('a'), 3)).toBe(join(dir, key('a'), 'f3.jpg'));
  expect(readFileSync(cache.path(key('a'), 3))).toEqual(Buffer.from(jpeg(100)));
  // no dependencies, no sidecar
  expect(existsSync(join(dir, key('a'), 'f3.deps.json'))).toBe(false);
  expect(cache.usedBytes()).toBe(100);
  // replacing a frame doesn't count it twice
  cache.put(key('a'), 3, jpeg(150), {});
  expect(cache.usedBytes()).toBe(150);
});

test('a frame with dependencies counts as cached only while every listed chapter still has that content', () => {
  const dir = tempDir('cache-'), cache = createCache({ dir, capBytes: 1e9 });
  const deps = { 'ch/c03_takeoff.js': sha256('three') };
  cache.put(key('nine'), 3600, jpeg(10), deps);
  expect(JSON.parse(readFileSync(join(dir, key('nine'), 'f3600.deps.json'), 'utf8'))).toEqual(deps);
  expect(cache.has(key('nine'), 3600, { 'ch/c03_takeoff.js': sha256('three'), 'ch/c09.js': sha256('nine') })).toBe(true);
  expect(cache.has(key('nine'), 3600, { 'ch/c03_takeoff.js': sha256('three, revised') })).toBe(false);
  expect(cache.has(key('nine'), 3600, {})).toBe(false);
  // repainted without dependencies: the old sidecar goes
  cache.put(key('nine'), 3600, jpeg(10), {});
  expect(existsSync(join(dir, key('nine'), 'f3600.deps.json'))).toBe(false);
  expect(cache.has(key('nine'), 3600, {})).toBe(true);
});

test('coverage merges cached frames of the current keys into ranges', () => {
  const dir = tempDir('cache-'), cache = createCache({ dir, capBytes: 1e9 });
  const [c2first] = framesOfChapter(2);
  for (const i of [0, 1, 2, 5]) cache.put(key('one'), i, jpeg(10), {});
  for (const i of [c2first, c2first + 1]) cache.put(key('two'), i, jpeg(10), {});
  cache.put(key('two'), c2first + 2, jpeg(10), { 'ch/c01.js': sha256('old') });
  // a frame cached under a key that is no longer current doesn't count
  cache.put(key('old two'), c2first + 5, jpeg(10), {});
  const keys = { ...noKeys(), 1: key('one'), 2: key('two') };
  expect(cache.coverage(keys, {})).toEqual([[0, 2], [5, 5], [c2first, c2first + 1]]);
  expect(cache.coverage(keys, { 'ch/c01.js': sha256('old') })).toEqual([[0, 2], [5, 5], [c2first, c2first + 2]]);
  // ranges run on across a chapter boundary
  const [, c1last] = framesOfChapter(1);
  cache.put(key('one'), c1last, jpeg(10), {});
  expect(cache.coverage(keys, {})).toEqual([[0, 2], [5, 5], [c1last, c2first + 1]]);
  expect(cache.coverage(noKeys(), {})).toEqual([]);
});

test('eviction removes whole least-recently-used segments until usage is under the cap', () => {
  const dir = tempDir('cache-'), cache = createCache({ dir, capBytes: 1000 });
  for (const name of ['a', 'b', 'c']) for (let i = 0; i < 3; i++) cache.put(key(name), i, jpeg(100), {});
  expect(cache.usedBytes()).toBe(900);
  cache.touch(key('a'));   // a is now the most recently used, b the least
  cache.put(key('d'), 0, jpeg(300), {});   // 1200 > 1000: b goes, whole
  expect(existsSync(join(dir, key('b')))).toBe(false);
  expect([0, 1, 2].some(i => cache.has(key('b'), i, {}))).toBe(false);
  for (const name of ['a', 'c', 'd']) expect(cache.has(key(name), 0, {})).toBe(true);
  expect(cache.usedBytes()).toBe(900);
  cache.put(key('d'), 1, jpeg(300), {});   // 1200 again: c (least recent now) goes
  expect(existsSync(join(dir, key('c')))).toBe(false);
  expect(cache.has(key('a'), 0, {})).toBe(true);
  expect(cache.usedBytes()).toBe(900);
});

test('a pinned segment survives eviction even when the cap is tiny (Review Focus 5)', () => {
  const dir = tempDir('cache-'), cache = createCache({ dir, capBytes: 1 });
  cache.pin(key('render'));
  for (let i = 0; i < 5; i++) cache.put(key('render'), i, jpeg(100), {});
  cache.put(key('preview'), 0, jpeg(100), {});
  cache.put(key('later'), 0, jpeg(100), {});
  cache.evict();
  for (let i = 0; i < 5; i++) expect(cache.has(key('render'), i, {})).toBe(true);
  // the unpinned, older preview segment was trimmed
  expect(cache.has(key('preview'), 0, {})).toBe(false);
  // the render is done: unpinned, it can go too
  cache.unpin(key('render'));
  cache.touch(key('later'));
  cache.evict();
  expect(cache.has(key('render'), 0, {})).toBe(false);
  // pins are counted: two renders of the same segment, one finishes, the other still holds it
  cache.pin(key('x')); cache.pin(key('x'));
  cache.put(key('x'), 0, jpeg(100), {});
  cache.put(key('y'), 0, jpeg(100), {});
  cache.unpin(key('x'));
  cache.evict();
  expect(cache.has(key('x'), 0, {})).toBe(true);
});

test('clear removes every segment except the pinned ones', () => {
  const dir = tempDir('cache-'), cache = createCache({ dir, capBytes: 1e9 });
  cache.put(key('a'), 0, jpeg(100), {});
  cache.put(key('b'), 0, jpeg(100), {});
  cache.pin(key('b'));
  cache.clear();
  expect(cache.has(key('a'), 0, {})).toBe(false);
  expect(existsSync(join(dir, key('a')))).toBe(false);
  expect(cache.has(key('b'), 0, {})).toBe(true);
  expect(cache.usedBytes()).toBe(100);
});

test('the index in cache.json survives a restart', () => {
  const dir = tempDir('cache-');
  const first = createCache({ dir, capBytes: 1000 });
  first.put(key('a'), 0, jpeg(300), {});
  first.put(key('b'), 0, jpeg(300), { 'ch/c02.js': sha256('two') });
  first.put(key('c'), 0, jpeg(300), {});
  first.touch(key('a'));   // order, least recent first: b, c, a
  expect(existsSync(join(dir, 'cache.json'))).toBe(true);

  const second = createCache({ dir, capBytes: 1000 });
  expect(second.usedBytes()).toBe(first.usedBytes());   // 900, plus b's small dependency sidecar
  expect(second.has(key('b'), 0, { 'ch/c02.js': sha256('two') })).toBe(true);
  expect(second.has(key('b'), 0, { 'ch/c02.js': sha256('two, revised') })).toBe(false);
  second.put(key('d'), 0, jpeg(300), {});   // over the cap: b, the least recently used before the restart, goes
  expect(second.has(key('b'), 0, { 'ch/c02.js': sha256('two') })).toBe(false);
  expect(second.has(key('c'), 0, {})).toBe(true);
  expect(second.has(key('a'), 0, {})).toBe(true);
});
