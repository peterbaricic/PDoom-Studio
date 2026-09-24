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

test('a storyboard that parses clean wins over walkthrough.json; walkthrough.json stands in for one that does not', () => {
  // e.g. a remix of the Original (which carries its legacy walkthrough.json along) given a new storyboard
  const wt = JSON.stringify([{ n: 1, name: 'Lab', text: 'Night lab.' }]);
  const clean = buildManifest({ id: 'a', options: {} }, new Map([['walkthrough.json', wt], ['STORYBOARD.md', goodStoryboard()]]));
  expect(clean.walkthrough).toHaveLength(9);
  expect(clean.walkthrough[0]).toEqual({ n: 1, name: 'Chapter 1', start: 0, end: 23, text: 'What happens in chapter 1.' });
  const legacy = buildManifest({ id: 'a', options: {} }, new Map([['walkthrough.json', wt], ['STORYBOARD.md', '# an older, freer format']]));
  expect(legacy.walkthrough).toEqual([{ n: 1, name: 'Lab', start: 0, end: 23, text: 'Night lab.' }]);
  expect(buildManifest({ id: 'a', options: {} }, new Map([['walkthrough.json', wt]])).walkthrough).toEqual(legacy.walkthrough);
});

test('a remix of the Original shows its own storyboard\'s walkthrough once it has one', () => {
  const udb = openDb(':memory:', { defaultPath: tempDefaultDb() });
  udb.remixVersion('original', { id: 'mine', title: 'Mine' });
  expect(udb.getFile('mine', 'walkthrough.json')).not.toBeNull();
  expect(versionManifest(udb, 'mine').walkthrough).toEqual(versionManifest(udb, 'original').walkthrough);
  udb.writeFiles('mine', [{ path: 'STORYBOARD.md', content: goodStoryboard() }], { source: 'manual' });
  expect(versionManifest(udb, 'mine').walkthrough.map(c => c.text)).toEqual(Array.from({ length: 9 }, (_, i) => `What happens in chapter ${i + 1}.`));
  udb.close();
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
  expect(m.walkthrough[0]).toMatchObject({ n: 1, name: 'The Lab', start: 0, end: 23 });   // from its walkthrough.json
  expect(udb.history('original', 'ch/c01_lab.js')[0].source).toBe('import');
  udb.close();
});
