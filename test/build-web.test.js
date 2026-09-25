import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWebIfStale } from '../studio/build-web.js';
import { tempDir } from './helpers.js';

// A throwaway "repo" with a studio/web source file, and a stub build that only writes dist/index.html and counts its
// runs, so the staleness rules are tested without running vite.
function fakeRepo() {
  const root = tempDir('build-web-'), web = join(root, 'studio/web');
  mkdirSync(join(web, 'src'), { recursive: true });
  writeFileSync(join(web, 'src/main.tsx'), '// source');
  const builds = [];
  const build = (r, webDir) => {
    builds.push(r);
    mkdirSync(join(webDir, 'dist'), { recursive: true });
    writeFileSync(join(webDir, 'dist/index.html'), '<!doctype html>');
  };
  const touch = (rel, seconds) => utimesSync(join(web, rel), seconds, seconds);
  return { root, web, builds, build, touch };
}

test('builds when there is no build yet, then skips while nothing changed', () => {
  const r = fakeRepo();
  expect(buildWebIfStale(r.root, { build: r.build })).toBe(true);
  expect(buildWebIfStale(r.root, { build: r.build })).toBe(false);
  expect(r.builds).toHaveLength(1);
});

test('rebuilds when a source file is newer than the build', () => {
  const r = fakeRepo();
  buildWebIfStale(r.root, { build: r.build });
  r.touch('dist/index.html', 1000);
  r.touch('src/main.tsx', 2000);
  expect(buildWebIfStale(r.root, { build: r.build })).toBe(true);
  expect(r.builds).toHaveLength(2);
});

test('rebuilds when the build stamp is missing or names another mode', () => {
  const r = fakeRepo();
  buildWebIfStale(r.root, { build: r.build });
  rmSync(join(r.web, 'dist/.build-stamp'));
  expect(buildWebIfStale(r.root, { build: r.build })).toBe(true);
  writeFileSync(join(r.web, 'dist/.build-stamp'), 'development\n');
  expect(buildWebIfStale(r.root, { build: r.build })).toBe(true);
  expect(buildWebIfStale(r.root, { build: r.build })).toBe(false);
  expect(r.builds).toHaveLength(3);
});

test('a failed build leaves no stamp behind, so the next start tries again', () => {
  const r = fakeRepo();
  expect(() => buildWebIfStale(r.root, { build: () => { throw new Error('vite failed'); } })).toThrow('vite failed');
  expect(buildWebIfStale(r.root, { build: r.build })).toBe(true);
});

test('progress and the build\'s own report go to log, and nowhere without one', () => {
  const r = fakeRepo(), logs = [];
  const build = (root, webDir, log) => { r.build(root, webDir); log('vite: built'); };
  expect(buildWebIfStale(r.root, { build, log: m => logs.push(m) })).toBe(true);
  expect(logs).toEqual(['Building studio/web (there is no build yet)…', 'vite: built']);
  rmSync(join(r.web, 'dist'), { recursive: true });
  expect(buildWebIfStale(r.root, { build })).toBe(true);   // the default log takes it silently
});
