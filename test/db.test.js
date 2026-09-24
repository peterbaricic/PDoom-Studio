import { test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, isValidPath, EXAMPLE_REVISION_FLOOR } from '../studio/db.js';
import { buildDefault } from '../studio/build-default.js';

const root = process.cwd();

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
  expect('log' in db.listJobs()[0]).toBe(false);
});

test('findJobs picks jobs by version, kind and status, newest first', () => {
  db.createVersion({ id: 'a' }); db.createVersion({ id: 'b' });
  const [s1, c1, s2, s3] = ['shared', 'chapter', 'shared', 'shared'].map(kind => db.addJob({ kind, versionId: 'a' }));
  db.addJob({ kind: 'shared', versionId: 'b' });
  db.updateJob(s1, { status: 'done' }); db.updateJob(s3, { status: 'failed' });
  expect(db.findJobs({ versionId: 'a', kinds: ['shared'], statuses: ['queued', 'running', 'done'] }).map(j => j.id)).toEqual([s2, s1]);
  expect(db.findJobs({ versionId: 'a', kinds: ['shared', 'chapter'], statuses: ['queued'] }).map(j => j.id)).toEqual([s2, c1]);
  expect(db.findJobs({ versionId: 'a', kinds: ['render'], statuses: ['queued'] })).toEqual([]);
});

test('renders: add, list with version info, delete', () => {
  db.createVersion({ id: 'a', title: 'A', logline: 'L' });
  const id = db.addRender({ versionId: 'a', file: 'a-1.mp4', revisionIds: [1, 2], durationS: 156.6, renderS: 900, sizeBytes: 10, poster: 'a-1.jpg' });
  expect(db.listRenders()[0]).toMatchObject({ id, version_id: 'a', title: 'A', logline: 'L', revision_ids: [1, 2] });
  db.deleteRender(id);
  expect(db.listRenders()).toEqual([]);
});

test('a plain database (no defaultPath) marks every version as not an example', () => {
  db.createVersion({ id: 'a' });
  expect(db.getVersion('a').example).toBe(false);
  expect(db.listVersions()[0].example).toBe(false);
});

// ---------- two databases: user.db + studio/default.db attached read-only as "def" ----------

const tempDbPath = prefix => join(mkdtempSync(join(tmpdir(), prefix)), 'db.sqlite');
// A fresh default.db (copied, via buildDefault, from the repo's own committed studio/default.db) that this test is
// free to mutate (e.g. via promoteVersion) without touching the repo's own copy.
const freshDefaultPath = () => { const p = tempDbPath('default-'); buildDefault(join(root, 'studio/default.db'), p); return p; };

test('openDb with defaultPath lists examples first, then the user\'s own versions', () => {
  const defaultPath = freshDefaultPath();
  const udb = openDb(tempDbPath('user-'), { defaultPath });
  udb.createVersion({ id: 'mine', title: 'Mine' });
  const list = udb.listVersions();
  expect(list.map(v => v.id)).toEqual(['original', 'mine']);
  expect(list.map(v => v.example)).toEqual([true, false]);
  expect(udb.getVersion('original')).toMatchObject({ id: 'original', example: true, status: 'ready' });
  expect(udb.getVersion('mine')).toMatchObject({ id: 'mine', example: false });
  expect(udb.listFiles('original').map(f => f.path)).toContain('STORYBOARD.md');
  udb.close();
});

test('examples are read-only: writeFiles, updateVersion and restore all refuse', () => {
  const defaultPath = freshDefaultPath();
  const udb = openDb(tempDbPath('user-'), { defaultPath });
  expect(() => udb.writeFiles('original', [{ path: 'STORYBOARD.md', content: 'x' }], { source: 'manual' })).toThrow('examples are read-only');
  expect(() => udb.updateVersion('original', { title: 'x' })).toThrow('examples are read-only');
  const [rev] = udb.history('original', 'STORYBOARD.md');
  expect(() => udb.restore(rev.id)).toThrow('examples are read-only');
  udb.close();
});

test('createVersion refuses an id that exists in either database', () => {
  const defaultPath = freshDefaultPath();
  const udb = openDb(tempDbPath('user-'), { defaultPath });
  expect(() => udb.createVersion({ id: 'original' })).toThrow('version id already exists: original');
  udb.createVersion({ id: 'mine' });
  expect(() => udb.createVersion({ id: 'mine' })).toThrow('version id already exists: mine');
  udb.close();
});

test('remixVersion carries over the source status when not all chapters exist yet', () => {
  const defaultPath = freshDefaultPath();
  const udb = openDb(tempDbPath('user-'), { defaultPath });
  udb.createVersion({ id: 'partial' });
  udb.writeFiles('partial', [{ path: 'ch/c01.js', content: '1' }], { source: 'claude' });
  udb.updateVersion('partial', { status: 'chapters' });
  const remix = udb.remixVersion('partial', { id: 'partial-remix', title: 'Partial Remix' });
  expect(remix).toMatchObject({ status: 'chapters', example: false });
  udb.close();
});

test('remixVersion copies an example into user.db; promoteVersion moves it back', () => {
  const defaultPath = freshDefaultPath();
  const udb = openDb(tempDbPath('user-'), { defaultPath });

  const remix = udb.remixVersion('original', { id: 'my-remix', title: 'My Remix' });
  expect(remix).toMatchObject({ id: 'my-remix', title: 'My Remix', example: false, status: 'ready' });
  expect(udb.listFiles('my-remix').map(f => f.path)).toEqual(udb.listFiles('original').map(f => f.path));
  const [rev] = udb.history('my-remix', 'STORYBOARD.md');
  expect(rev).toMatchObject({ source: 'remix', note: 'remixed from original' });
  expect(rev.id).toBeLessThan(EXAMPLE_REVISION_FLOOR);

  const promoted = udb.promoteVersion('my-remix');
  expect(promoted).toMatchObject({ id: 'my-remix', title: 'My Remix', example: true });
  expect(udb.listVersions().map(v => v.id).sort()).toEqual(['my-remix', 'original']);
  expect(udb.getFile('my-remix', 'STORYBOARD.md')).not.toBeNull();

  const [promotedRev] = udb.history('my-remix', 'STORYBOARD.md');
  expect(promotedRev.id).toBeGreaterThanOrEqual(EXAMPLE_REVISION_FLOOR);
  expect(promotedRev.source).toBe('promote');
  expect(udb.getRevision(promotedRev.id)).toMatchObject({ source: 'promote', version_id: 'my-remix' });

  // it's an example now: read-only, same as any other
  expect(() => udb.writeFiles('my-remix', [{ path: 'STORYBOARD.md', content: 'x' }], { source: 'manual' })).toThrow('examples are read-only');
  udb.close();
});

test('promoteVersion refuses examples, and refuses when there is no default.db', () => {
  const defaultPath = freshDefaultPath();
  const udb = openDb(tempDbPath('user-'), { defaultPath });
  expect(() => udb.promoteVersion('original')).toThrow('already an example');
  udb.close();

  const plain = openDb(tempDbPath('user-'));
  plain.createVersion({ id: 'solo' });
  expect(() => plain.promoteVersion('solo')).toThrow('default.db does not exist');
  plain.close();
});

test('example revision ids are >= EXAMPLE_REVISION_FLOOR and getRevision resolves them', () => {
  const defaultPath = freshDefaultPath();
  const udb = openDb(tempDbPath('user-'), { defaultPath });
  const revs = udb.history('original', null);
  expect(revs.length).toBeGreaterThan(0);
  for (const r of revs) expect(r.id).toBeGreaterThanOrEqual(EXAMPLE_REVISION_FLOOR);
  const sample = revs[0];
  expect(udb.getRevision(sample.id)).toMatchObject({ id: sample.id, version_id: 'original', path: sample.path });
  udb.close();
});

test('opening with defaultPath never modifies studio/default.db, and creates no -wal/-shm', () => {
  const defaultPath = join(root, 'studio/default.db');
  const before = statSync(defaultPath);
  const beforeBytes = readFileSync(defaultPath);

  const udb = openDb(tempDbPath('user-'), { defaultPath });
  // exercise every read path that touches "def"
  udb.listVersions();
  udb.getVersion('original');
  udb.getFile('original', 'STORYBOARD.md');
  udb.listFiles('original');
  udb.history('original', null);
  const [rev] = udb.history('original', 'STORYBOARD.md');
  udb.getRevision(rev.id);
  udb.listRenders();
  udb.close();

  const after = statSync(defaultPath);
  const afterBytes = readFileSync(defaultPath);
  expect(afterBytes.equals(beforeBytes)).toBe(true);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(existsSync(`${defaultPath}-wal`)).toBe(false);
  expect(existsSync(`${defaultPath}-shm`)).toBe(false);
  expect(existsSync(`${defaultPath}-journal`)).toBe(false);
});
