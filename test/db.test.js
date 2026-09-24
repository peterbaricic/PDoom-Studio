import { test, expect, beforeEach } from 'bun:test';
import { openDb, isValidPath } from '../studio/db.js';

let db;
beforeEach(() => { db = openDb(':memory:'); });

test('creates and lists versions', () => {
  const v = db.createVersion({ id: 'cooking-show', title: 'Bake-Off', concept: 'a cooking show', options: { wipes: false } });
  expect(v).toMatchObject({ id: 'cooking-show', title: 'Bake-Off', status: 'concept', options: { wipes: false } });
  expect(db.listVersions().map(v => v.id)).toEqual(['cooking-show']);
  expect(() => db.createVersion({ id: 'Bad Id' })).toThrow('bad version id');
});

test('updates version fields', () => {
  db.createVersion({ id: 'a' });
  const v = db.updateVersion('a', { status: 'storyboard', title: 'T', options: { cornerMeter: false } });
  expect(v).toMatchObject({ status: 'storyboard', title: 'T', options: { cornerMeter: false } });
});

test('writeFiles records revisions and skips unchanged content', () => {
  db.createVersion({ id: 'a' });
  const [r1] = db.writeFiles('a', [{ path: 'STORYBOARD.md', content: 'one' }], { source: 'claude', note: 'first' });
  expect(db.writeFiles('a', [{ path: 'STORYBOARD.md', content: 'one' }], { source: 'manual' })).toEqual([]);
  const [r2] = db.writeFiles('a', [{ path: 'STORYBOARD.md', content: 'two' }], { source: 'manual', note: 'edit' });
  expect(db.getFile('a', 'STORYBOARD.md')).toMatchObject({ content: 'two', revision_id: r2 });
  expect(db.history('a', 'STORYBOARD.md').map(r => [r.id, r.source, r.note])).toEqual([[r2, 'manual', 'edit'], [r1, 'claude', 'first']]);
});

test('restore writes a new revision with the old content', () => {
  db.createVersion({ id: 'a' });
  const [r1] = db.writeFiles('a', [{ path: 'ch/c01.js', content: 'old' }], { source: 'claude' });
  db.writeFiles('a', [{ path: 'ch/c01.js', content: 'new' }], { source: 'claude' });
  const r3 = db.restore(r1);
  expect(db.getFile('a', 'ch/c01.js')).toMatchObject({ content: 'old', revision_id: r3 });
  expect(db.getRevision(r3)).toMatchObject({ source: 'restore', note: `restored revision ${r1}` });
});

test('only allowed paths can be written', () => {
  for (const p of ['STORYBOARD.md', 'shared.js', 'walkthrough.json', 'ch/c01.js', 'ch/c09_finale.js']) expect(isValidPath(p)).toBe(true);
  for (const p of ['../x.js', 'ch/c10.js', 'src/core.js', 'ch/c01.JS', 'notes.txt']) expect(isValidPath(p)).toBe(false);
  db.createVersion({ id: 'a' });
  expect(() => db.writeFiles('a', [{ path: 'src/core.js', content: '' }], { source: 'claude' })).toThrow('not an allowed version file');
});

test('listFiles is sorted by path', () => {
  db.createVersion({ id: 'a' });
  db.writeFiles('a', [{ path: 'ch/c02.js', content: '2' }, { path: 'ch/c01.js', content: '1' }, { path: 'STORYBOARD.md', content: 's' }], { source: 'claude' });
  expect(db.listFiles('a').map(f => f.path)).toEqual(['STORYBOARD.md', 'ch/c01.js', 'ch/c02.js']);
});

test('jobs: add, update, log, interrupt', () => {
  db.createVersion({ id: 'a' });
  const id = db.addJob({ kind: 'chapter', versionId: 'a', params: { chapter: 3 }, model: 'opus' });
  expect(db.getJob(id)).toMatchObject({ kind: 'chapter', status: 'queued', params: { chapter: 3 }, model: 'opus', log: '' });
  db.updateJob(id, { status: 'running', started_at: 5 });
  db.appendLog(id, 'hello\n'); db.appendLog(id, 'world\n');
  expect(db.getJob(id).log).toBe('hello\nworld\n');
  expect(db.markInterrupted()).toBe(1);
  expect(db.getJob(id).status).toBe('interrupted');
  expect(db.listJobs({ versionId: 'a' }).map(j => j.id)).toEqual([id]);
});

test('renders: add, list with version info, delete', () => {
  db.createVersion({ id: 'a', title: 'A', logline: 'L' });
  const id = db.addRender({ versionId: 'a', file: 'a-1.mp4', revisionIds: [1, 2], durationS: 156.6, renderS: 900, sizeBytes: 10, poster: 'a-1.jpg' });
  expect(db.listRenders()[0]).toMatchObject({ id, version_id: 'a', title: 'A', logline: 'L', revision_ids: [1, 2] });
  db.deleteRender(id);
  expect(db.listRenders()).toEqual([]);
});
