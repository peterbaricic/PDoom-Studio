import { test, expect } from 'bun:test';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { openDb } from '../studio/db.js';
import { migrateLegacyDb, cleanLegacyOriginal } from '../studio/migrate.js';

const tempRoot = () => mkdtempSync(join(tmpdir(), 'migrate-'));
const quiet = () => {};   // what it says it did isn't what these check (the "prints what it did" tests collect it)

test('renames studio.db to user.db, drops the Original, and keeps everything else intact', () => {
  const root = tempRoot(), userPath = join(root, 'user.db'), legacyPath = join(root, 'studio.db');

  const legacy = openDb(legacyPath);
  legacy.createVersion({ id: 'original', title: 'Orig', logline: 'L', concept: 'the original' });
  legacy.writeFiles('original', [{ path: 'STORYBOARD.md', content: 'orig storyboard' }, { path: 'ch/c01.js', content: '// original ch1' }],
    { source: 'import', note: 'imported from the repository' });
  legacy.updateVersion('original', { status: 'ready' });

  legacy.createVersion({ id: 'space-opera', title: 'Space Opera', logline: 'In space, everyone can hear you sing.' });
  legacy.writeFiles('space-opera', [{ path: 'STORYBOARD.md', content: 'space opera storyboard' }], { source: 'manual', note: 'first draft' });
  const jid = legacy.addJob({ kind: 'chapter', versionId: 'space-opera', params: { chapter: 1 } });
  legacy.updateJob(jid, { status: 'done', cost_usd: 0.42 });
  const rid = legacy.addRender({ versionId: 'space-opera', file: 'space-opera-1.mp4', revisionIds: [1], durationS: 10, renderS: 20, sizeBytes: 5, poster: 'space-opera-1.jpg' });
  legacy.close();
  // Where SQLite keeps the WAL on close (macOS's system SQLite does; the one Bun bundles on Linux checkpoints and
  // removes it), it still holds every write above — migrateLegacyDb must checkpoint it itself before renaming, or
  // all of this would be silently left behind at the old path. Either way, everything must arrive below.
  if (process.platform === 'darwin') expect(existsSync(`${legacyPath}-wal`)).toBe(true);

  const result = migrateLegacyDb(root, { userPath, log: quiet });
  expect(result).toBe(true);
  expect(existsSync(userPath)).toBe(true);
  expect(existsSync(legacyPath)).toBe(false);

  const migrated = openDb(userPath);
  // the Original is gone: it comes from studio/default.db now, not from the migrated user.db
  expect(migrated.getVersion('original')).toBeNull();
  expect(migrated.listFiles('original')).toEqual([]);
  expect(migrated.history('original', null)).toEqual([]);

  // everything else survived, unchanged
  const opera = migrated.getVersion('space-opera');
  expect(opera).toMatchObject({ id: 'space-opera', title: 'Space Opera', logline: 'In space, everyone can hear you sing.' });
  expect(migrated.listFiles('space-opera').map(f => f.path)).toEqual(['STORYBOARD.md']);
  expect(migrated.getFile('space-opera', 'STORYBOARD.md').content).toBe('space opera storyboard');

  const job = migrated.getJob(jid);
  expect(job).toMatchObject({ kind: 'chapter', version_id: 'space-opera', status: 'done', cost_usd: 0.42 });

  const render = migrated.getRender(rid);
  expect(render).toMatchObject({ id: rid, version_id: 'space-opera', file: 'space-opera-1.mp4' });
  migrated.close();
});

test('an interruption between cleaning the Original out and the rename is recovered on the next call', () => {
  // Simulates a process killed after the Original was stripped out of studio.db but before migrateLegacyDb got to
  // rename it to user.db: studio.db is left behind, already cleaned, and user.db doesn't exist yet. The next
  // server start (another migrateLegacyDb call) must finish the job — nothing lost, nothing duplicated — rather
  // than treating studio.db's continued presence as untouched work still to do from scratch, or treating the
  // half-done state as nothing to do at all.
  const root = tempRoot(), userPath = join(root, 'user.db'), legacyPath = join(root, 'studio.db');

  const legacy = openDb(legacyPath);
  legacy.createVersion({ id: 'original', title: 'Orig' });
  legacy.writeFiles('original', [{ path: 'STORYBOARD.md', content: 'orig storyboard' }], { source: 'import' });
  legacy.createVersion({ id: 'space-opera', title: 'Space Opera' });
  legacy.writeFiles('space-opera', [{ path: 'STORYBOARD.md', content: 'space opera storyboard' }], { source: 'manual' });
  const jid = legacy.addJob({ kind: 'chapter', versionId: 'space-opera', params: { chapter: 1 } });
  legacy.close();

  // The crash point: cleanLegacyOriginal ran (and committed) but migrateLegacyDb never got to rename.
  cleanLegacyOriginal(legacyPath);
  expect(existsSync(legacyPath)).toBe(true);
  expect(existsSync(userPath)).toBe(false);
  const partial = openDb(legacyPath);
  expect(partial.getVersion('original')).toBeNull();
  expect(partial.getVersion('space-opera')).toMatchObject({ id: 'space-opera', title: 'Space Opera' });
  partial.close();

  // The next start: migrateLegacyDb sees studio.db still there (now already cleaned) and user.db still missing,
  // and finishes the migration.
  const result = migrateLegacyDb(root, { userPath, log: quiet });
  expect(result).toBe(true);
  expect(existsSync(userPath)).toBe(true);
  expect(existsSync(legacyPath)).toBe(false);

  const migrated = openDb(userPath);
  expect(migrated.getVersion('original')).toBeNull();
  expect(migrated.listVersions().filter(v => v.id === 'original')).toHaveLength(0);   // no duplicate
  expect(migrated.getVersion('space-opera')).toMatchObject({ id: 'space-opera', title: 'Space Opera' });
  expect(migrated.getFile('space-opera', 'STORYBOARD.md').content).toBe('space opera storyboard');
  expect(migrated.getJob(jid)).toMatchObject({ kind: 'chapter', version_id: 'space-opera' });
  migrated.close();
});

test('refuses to migrate while a studio server still holds the lock on studio.db', () => {
  // Reflects the real one-time migration: the user's old studio server may still be running against studio.db
  // when they start the new one. Moving the database out from under it would corrupt whatever it writes next, so
  // migration must refuse instead, the same way a second acquireLock() on the same database refuses.
  const root = tempRoot(), legacyPath = join(root, 'studio.db'), userPath = join(root, 'user.db');

  const legacy = openDb(legacyPath);
  legacy.createVersion({ id: 'original', title: 'Orig' });
  legacy.writeFiles('original', [{ path: 'STORYBOARD.md', content: 'orig storyboard' }], { source: 'import' });
  legacy.close();

  writeFileSync(`${legacyPath}.lock`, JSON.stringify({ pid: process.pid, port: 4321 }));   // this test process: alive

  expect(() => migrateLegacyDb(root, { userPath, log: quiet }))
    .toThrow(`stop the running studio first (pid ${process.pid}, http://localhost:4321/) — studio.db is still in use`);

  // nothing touched
  expect(existsSync(legacyPath)).toBe(true);
  expect(existsSync(userPath)).toBe(false);
  const untouched = openDb(legacyPath);
  expect(untouched.getVersion('original')).toMatchObject({ id: 'original', title: 'Orig' });
  expect(untouched.getFile('original', 'STORYBOARD.md').content).toBe('orig storyboard');
  untouched.close();
});

test('a stale lock (a dead pid) does not block migration', async () => {
  const root = tempRoot(), legacyPath = join(root, 'studio.db'), userPath = join(root, 'user.db');
  openDb(legacyPath).close();

  const p = Bun.spawn(['true']);
  await p.exited;   // now definitely dead
  writeFileSync(`${legacyPath}.lock`, JSON.stringify({ pid: p.pid, port: 4321 }));

  expect(migrateLegacyDb(root, { userPath, log: quiet })).toBe(true);
  expect(existsSync(userPath)).toBe(true);
});

test('an incomplete checkpoint (another connection still holding the WAL open) refuses and leaves everything alone', () => {
  const root = tempRoot(), legacyPath = join(root, 'studio.db'), userPath = join(root, 'user.db');

  const legacy = openDb(legacyPath);
  legacy.createVersion({ id: 'original', title: 'Orig' });
  legacy.writeFiles('original', [{ path: 'STORYBOARD.md', content: 'orig storyboard' }], { source: 'import' });
  legacy.close();

  // A second connection with an open read transaction pins the WAL's checkpoint boundary: wal_checkpoint(TRUNCATE)
  // can checkpoint frames written before this transaction started, but not the ones cleanLegacyOriginal's own
  // delete writes afterward — exactly the "busy" case a leftover reader process would also produce.
  const reader = new Database(legacyPath, { strict: true });
  reader.exec('BEGIN');
  reader.query('SELECT 1 FROM versions').all();
  try {
    expect(() => migrateLegacyDb(root, { userPath, log: quiet })).toThrow(/did not fully checkpoint/);

    // nothing deleted or renamed
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(userPath)).toBe(false);
    expect(existsSync(`${legacyPath}-wal`)).toBe(true);
  } finally {
    reader.close();
  }

  // once the blocker is gone, a retry completes cleanly, with nothing lost
  expect(migrateLegacyDb(root, { userPath, log: quiet })).toBe(true);
  const migrated = openDb(userPath);
  expect(migrated.getVersion('original')).toBeNull();
  migrated.close();
});

test('prints what it did', () => {
  const root = tempRoot(), userPath = join(root, 'user.db');
  openDb(join(root, 'studio.db')).close();
  const logs = [];
  migrateLegacyDb(root, { userPath, log: m => logs.push(m) });
  expect(logs).toContain('Moved studio.db to user.db (the Original now comes from studio/default.db).');
});

test('an Original with edits of the user\'s own is kept, renamed to original-edited, with all its history', () => {
  const root = tempRoot(), userPath = join(root, 'user.db'), legacyPath = join(root, 'studio.db');
  const legacy = openDb(legacyPath);
  legacy.createVersion({ id: 'original', title: 'Orig', logline: 'L', concept: 'the original', options: { wipes: false } });
  legacy.writeFiles('original', [{ path: 'STORYBOARD.md', content: 'orig storyboard' }, { path: 'ch/c01.js', content: '// original ch1' }],
    { source: 'import', note: 'imported from the repository' });
  legacy.writeFiles('original', [{ path: 'ch/c01.js', content: '// my better ch1' }], { source: 'claude', note: 'make it pop' });
  legacy.updateVersion('original', { status: 'ready' });
  const history = legacy.history('original', null);
  const jid = legacy.addJob({ kind: 'chapter', versionId: 'original', params: { chapter: 1 } });
  legacy.close();

  const logs = [];
  expect(migrateLegacyDb(root, { userPath, log: m => logs.push(m) })).toBe(true);
  expect(logs).toEqual(['Moved studio.db to user.db (the Original now comes from studio/default.db).',
    'Your edits to the Original were kept, as the version "original-edited".']);

  const migrated = openDb(userPath);
  expect(migrated.getVersion('original')).toBeNull();
  expect(migrated.getVersion('original-edited')).toMatchObject({ title: 'Orig', logline: 'L', concept: 'the original', options: { wipes: false }, status: 'ready' });
  expect(migrated.getFile('original-edited', 'ch/c01.js').content).toBe('// my better ch1');
  expect(migrated.getFile('original-edited', 'STORYBOARD.md').content).toBe('orig storyboard');
  expect(migrated.history('original-edited', null)).toEqual(history.map(r => ({ ...r, version_id: 'original-edited' })));
  expect(migrated.getJob(jid).version_id).toBe('original');   // jobs keep pointing at the Original
  migrated.close();
});

test('the kept Original takes the next free name when original-edited is already taken', () => {
  const root = tempRoot(), userPath = join(root, 'user.db');
  const legacy = openDb(join(root, 'studio.db'));
  legacy.createVersion({ id: 'original' });
  legacy.writeFiles('original', [{ path: 'STORYBOARD.md', content: 'orig' }], { source: 'import' });
  legacy.writeFiles('original', [{ path: 'STORYBOARD.md', content: 'edited' }], { source: 'manual' });
  legacy.createVersion({ id: 'original-edited', title: 'Taken' });
  legacy.close();
  migrateLegacyDb(root, { userPath, log: quiet });
  const migrated = openDb(userPath);
  expect(migrated.getVersion('original-edited').title).toBe('Taken');
  expect(migrated.getFile('original-edited-2', 'STORYBOARD.md').content).toBe('edited');
  migrated.close();
});

test('a user.db-wal or user.db-shm without its user.db is refused, and nothing is touched', () => {
  for (const ext of ['-wal', '-shm']) {
    const root = tempRoot(), userPath = join(root, 'user.db'), legacyPath = join(root, 'studio.db');
    const legacy = openDb(legacyPath);
    legacy.createVersion({ id: 'original', title: 'Orig' });
    legacy.writeFiles('original', [{ path: 'STORYBOARD.md', content: 'orig storyboard' }], { source: 'import' });
    legacy.close();
    writeFileSync(userPath + ext, 'left over from some other database');
    expect(() => migrateLegacyDb(root, { userPath, log: quiet })).toThrow(`${userPath}${ext} exists without ${userPath}`);
    expect(existsSync(userPath)).toBe(false);
    const untouched = openDb(legacyPath);
    expect(untouched.getVersion('original')).toMatchObject({ id: 'original', title: 'Orig' });
    untouched.close();
  }
  // also when there is nothing to migrate: a new user.db would take the stray file for its own just the same
  const root = tempRoot(), userPath = join(root, 'user.db');
  writeFileSync(userPath + '-wal', 'stray');
  expect(() => migrateLegacyDb(root, { userPath, log: quiet })).toThrow('exists without');
});

test('does nothing when studio.db does not exist', () => {
  const root = tempRoot(), userPath = join(root, 'user.db');
  expect(migrateLegacyDb(root, { userPath, log: quiet })).toBe(false);
  expect(existsSync(userPath)).toBe(false);
});

test('does nothing when user.db already exists, and leaves studio.db untouched', () => {
  const root = tempRoot(), userPath = join(root, 'user.db'), legacyPath = join(root, 'studio.db');
  openDb(legacyPath).close();
  openDb(userPath).close();

  expect(migrateLegacyDb(root, { userPath, log: quiet })).toBe(false);
  expect(existsSync(legacyPath)).toBe(true);
});
