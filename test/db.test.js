import { test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, cpSync, readdirSync, statSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
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

test('remixVersion is all or nothing', () => {
  const udb = openDb(tempDbPath('user-'), { defaultPath: freshDefaultPath() });
  const revisions = () => udb.db.query('SELECT COUNT(*) AS n FROM revisions').get().n;
  udb.updateVersion = () => { throw new Error('boom'); };   // its last step fails
  expect(() => udb.remixVersion('original', { id: 'half', title: 'Half' })).toThrow('boom');
  expect(udb.getVersion('half')).toBeNull();
  expect(udb.listFiles('half')).toEqual([]);
  expect(revisions()).toBe(0);
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

test('an id in both databases (promote interrupted after writing default.db) resolves to the example, and promoting again finishes the move', () => {
  // The crash state: default.db already has the version, user.db still has it too. Two user databases sharing one
  // default.db make it exactly: both hold an identical "mine", the first promotes it, and the second is left holding
  // its copy of what default.db now has. A third holds a "mine" with other files.
  const defaultPath = freshDefaultPath();
  const mine = (udb, files = [{ path: 'STORYBOARD.md', content: 'sb' }, { path: 'ch/c01.js', content: '// 1' }]) => {
    udb.createVersion({ id: 'mine', title: 'Mine' });
    udb.writeFiles('mine', files, { source: 'manual' });
    udb.addRender({ versionId: 'mine', file: 'mine-1.mp4', revisionIds: [], durationS: 1, renderS: 1, sizeBytes: 1, poster: 'mine-1.jpg' });
    return udb;
  };
  const first = mine(openDb(tempDbPath('user-'), { defaultPath }));
  const crashed = mine(openDb(tempDbPath('user-'), { defaultPath }));
  const other = mine(openDb(tempDbPath('user-'), { defaultPath }), [{ path: 'ch/c01.js', content: '// something else' }]);
  first.promoteVersion('mine');
  first.close();

  crashed.db.query("UPDATE versions SET title = 'Stale' WHERE id = 'mine'").run();   // the user.db row, not the example's
  expect(crashed.getVersion('mine')).toMatchObject({ id: 'mine', title: 'Mine', example: true });
  expect(crashed.listVersions().filter(v => v.id === 'mine')).toEqual([expect.objectContaining({ title: 'Mine', example: true })]);
  expect(crashed.listRenders().map(r => [r.version_id, r.title])).toEqual([['mine', 'Mine']]);
  expect(() => crashed.writeFiles('mine', [{ path: 'ch/c01.js', content: 'x' }], { source: 'manual' })).toThrow('examples are read-only');

  expect(crashed.promoteVersion('mine')).toMatchObject({ id: 'mine', title: 'Mine', example: true });
  expect(crashed.db.query("SELECT COUNT(*) AS n FROM versions WHERE id = 'mine'").get().n).toBe(0);
  expect(crashed.db.query("SELECT COUNT(*) AS n FROM files WHERE version_id = 'mine'").get().n).toBe(0);
  expect(crashed.db.query("SELECT COUNT(*) AS n FROM revisions WHERE version_id = 'mine'").get().n).toBe(0);
  expect(crashed.db.query("SELECT COUNT(*) AS n FROM def.files WHERE version_id = 'mine'").get().n).toBe(2);   // not written twice
  expect(() => crashed.promoteVersion('mine')).toThrow('already an example: mine');
  crashed.close();

  // A user version that only shares the id, with other files, is refused and left alone.
  expect(() => other.promoteVersion('mine')).toThrow('default.db already has a different version with the id mine');
  expect(other.db.query("SELECT content FROM files WHERE version_id = 'mine'").get().content).toBe('// something else');
  other.close();
});

test('listRenders names a render of an example after the example', () => {
  const udb = openDb(tempDbPath('user-'), { defaultPath: freshDefaultPath() });
  const id = udb.addRender({ versionId: 'original', file: 'o-1.mp4', revisionIds: [], durationS: 1, renderS: 1, sizeBytes: 1, poster: 'o-1.jpg' });
  const { title, logline } = udb.getVersion('original');
  expect(title).toBeTruthy();
  expect(udb.listRenders()).toEqual([expect.objectContaining({ id, version_id: 'original', title, logline })]);
  udb.close();
});

test('reads across both databases name their columns, whatever order the examples database declares them in', () => {
  const defaultPath = tempDbPath('reordered-'), d = new Database(defaultPath);
  d.exec(`CREATE TABLE versions (updated_at INTEGER, status TEXT NOT NULL DEFAULT 'concept', options TEXT NOT NULL DEFAULT '{}',
      concept TEXT NOT NULL DEFAULT '', logline TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', id TEXT PRIMARY KEY, created_at INTEGER);
    CREATE TABLE revisions (id INTEGER PRIMARY KEY, version_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, job_id INTEGER,
      source TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER);
    CREATE TABLE files (version_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, revision_id INTEGER NOT NULL, PRIMARY KEY (version_id, path));
    INSERT INTO versions (id, title, logline, concept, options, status, created_at, updated_at) VALUES ('ex', 'Ex', 'L', 'C', '{"wipes":false}', 'ready', 1, 2);`);
  d.close();
  const udb = openDb(tempDbPath('user-'), { defaultPath });
  udb.createVersion({ id: 'mine', title: 'Mine' });
  udb.addRender({ versionId: 'ex', file: 'ex.mp4', revisionIds: [], durationS: 1, renderS: 1, sizeBytes: 1, poster: 'ex.jpg' });
  const ex = { id: 'ex', title: 'Ex', logline: 'L', concept: 'C', options: { wipes: false }, status: 'ready', created_at: 1, updated_at: 2, example: true };
  expect(udb.listVersions()[0]).toEqual(ex);
  expect(udb.getVersion('ex')).toEqual(ex);
  expect(udb.listVersions()[1]).toMatchObject({ id: 'mine', title: 'Mine', example: false });
  expect(udb.listRenders()[0]).toMatchObject({ version_id: 'ex', title: 'Ex', logline: 'L' });
  udb.close();
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

test('a default.db path with URI-special characters (#, ?, %) is attached as is, read-only', () => {
  const parent = mkdtempSync(join(tmpdir(), 'uri-')), dir = join(parent, 'a#b?c%41d'), defaultPath = join(dir, 'default.db');
  mkdirSync(dir);
  cpSync(join(root, 'studio/default.db'), defaultPath);
  const bytes = readFileSync(defaultPath);
  const udb = openDb(join(parent, 'user.db'), { defaultPath });
  expect(udb.getVersion('original')).toMatchObject({ id: 'original', example: true });
  expect(udb.listFiles('original').map(f => f.path)).toContain('STORYBOARD.md');
  udb.close();
  // no stray file at a truncated path (e.g. "a" for "a#b…"), and the examples database itself untouched
  expect(readdirSync(parent).filter(n => !n.startsWith('user.db'))).toEqual(['a#b?c%41d']);
  expect(readdirSync(dir)).toEqual(['default.db']);
  expect(readFileSync(defaultPath).equals(bytes)).toBe(true);
});

test('openDb refuses a userPath that is the same file as defaultPath, and never touches it', () => {
  const defaultPath = freshDefaultPath();   // a private copy: a real WAL switch here would be this test's own fault
  expect(() => openDb(defaultPath, { defaultPath })).toThrow(/same file/);
  expect(existsSync(`${defaultPath}-wal`)).toBe(false);
  expect(existsSync(`${defaultPath}-shm`)).toBe(false);
});

test('openDb refuses a userPath that is the same file as defaultPath by way of a symlink', () => {
  const defaultPath = freshDefaultPath();
  const linked = join(mkdtempSync(join(tmpdir(), 'alias-')), 'user.db');
  symlinkSync(defaultPath, linked);
  expect(() => openDb(linked, { defaultPath })).toThrow(/same file/);
  expect(existsSync(`${defaultPath}-wal`)).toBe(false);
  expect(existsSync(`${defaultPath}-shm`)).toBe(false);
});

test('openDb refuses to open an examples database as the user database', () => {
  // A copy of the examples database, opened here as if it were user.db: same shape default.db itself has (revision
  // ids >= EXAMPLE_REVISION_FLOOR), which is exactly what a stray env-var mix-up (USER_DB pointed at a default.db
  // copy) would look like.
  const asUser = freshDefaultPath(), defaultPath = freshDefaultPath();
  expect(() => openDb(asUser, { defaultPath })).toThrow(/examples database/);
  // never switched to WAL, and never migrated: the sha256 index only exists once migrateShaColumn has run
  expect(existsSync(`${asUser}-wal`)).toBe(false);
  expect(existsSync(`${asUser}-shm`)).toBe(false);
  const untouched = new Database(asUser, { readonly: true });
  const indexes = untouched.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'revisions'").all().map(r => r.name);
  expect(indexes).not.toContain('revisions_by_sha');
  untouched.close();
});

test('a database with no revisions table yet (or none at all) is not mistaken for an examples database', () => {
  // openDb's own SCHEMA creates the table on first use, so a brand-new user.db never has one until then — this
  // proves the probe used to guard against that doesn't itself choke on a table that isn't there yet.
  const empty = tempDbPath('empty-'), d = new Database(empty, { create: true });
  d.close();
  const udb = openDb(empty, { defaultPath: freshDefaultPath() });
  expect(udb.getVersion('original')).toMatchObject({ example: true });
  udb.close();
});

test('revisions.sha256 is indexed', () => {
  const udb = openDb(':memory:');
  const indexes = udb.db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'revisions'").all().map(r => r.name);
  expect(indexes).toContain('revisions_by_sha');
  udb.close();
});

test('opening with defaultPath never modifies the examples database, and creates no -wal/-shm', () => {
  const defaultPath = freshDefaultPath();   // a private copy — never open the repo's own studio/default.db directly
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
