import { test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../studio/db.js';
import { buildManifest, versionManifest, workManifest, DEFAULT_OPTIONS } from '../studio/versions.js';
import { goodStoryboard, tempDefaultDb } from './helpers.js';

let db;
beforeEach(() => { db = openDb(':memory:'); });

test('manifest orders shared.js before chapters and reads walkthrough from the storyboard', () => {
  const m = buildManifest({ id: 'a', title: 'A', logline: 'L', status: 'chapters', options: { wipes: false } },
    new Map([['ch/c02.js', ''], ['STORYBOARD.md', goodStoryboard()], ['shared.js', ''], ['ch/c01.js', '']]));
  expect(m.scripts).toEqual(['shared.js', 'ch/c01.js', 'ch/c02.js']);
  expect(m.options).toEqual({ ...DEFAULT_OPTIONS, wipes: false });
  expect(m.walkthrough).toHaveLength(9);
  expect(m.walkthrough[0]).toEqual({ n: 1, name: 'Chapter 1', start: 0, end: 23, text: 'What happens in chapter 1.' });
});

test('walkthrough.json wins over the storyboard', () => {
  const wt = JSON.stringify([{ n: 1, name: 'Lab', text: 'Night lab.' }]);
  const m = buildManifest({ id: 'a', options: {} }, new Map([['walkthrough.json', wt], ['STORYBOARD.md', goodStoryboard()]]));
  expect(m.walkthrough).toEqual([{ n: 1, name: 'Lab', start: 0, end: 23, text: 'Night lab.' }]);
});

test('versionManifest reads from the database', () => {
  db.createVersion({ id: 'a', title: 'A' });
  db.writeFiles('a', [{ path: 'ch/c01.js', content: 'x' }], { source: 'claude' });
  expect(versionManifest(db, 'a')).toMatchObject({ id: 'a', title: 'A', scripts: ['ch/c01.js'] });
  expect(versionManifest(db, 'missing')).toBeNull();
});

test('workManifest reads allowed files from a folder and ignores the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'work-'));
  mkdirSync(join(dir, 'ch'));
  writeFileSync(join(dir, 'ch', 'c03.js'), '3'); writeFileSync(join(dir, 'TASK.md'), 'brief'); writeFileSync(join(dir, 'ch', 'notes.txt'), 'n');
  expect(workManifest(dir, { id: 'a', options: {} }).files).toEqual(['ch/c03.js']);
});

test('versionManifest reads the Original example from the attached default database', () => {
  const udb = openDb(':memory:', { defaultPath: tempDefaultDb() });
  const m = versionManifest(udb, 'original');
  expect(m.scripts).toEqual(['ch/c01_lab.js', 'ch/c02_chorus1.js', 'ch/c03_takeoff.js', 'ch/c04_chorus2.js', 'ch/c05_obsolete.js',
    'ch/c06_chorus3.js', 'ch/c07_scale.js', 'ch/c08_chorus4.js', 'ch/c09_finale.js']);
  expect(m.status).toBe('ready');
  expect(m.example).toBe(true);
  expect(m.walkthrough).toHaveLength(9);
  expect(udb.history('original', 'ch/c01_lab.js')[0].source).toBe('import');
  udb.close();
});
