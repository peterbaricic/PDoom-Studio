import { test, expect } from 'bun:test';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../studio/db.js';
import { migrateLegacyDb, cleanLegacyOriginal } from '../studio/migrate.js';

const tempRoot = () => mkdtempSync(join(tmpdir(), 'migrate-'));

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
  // The WAL beside studio.db still holds every write above (SQLite only checkpoints it into the main file
  // automatically every ~1000 pages, far more than this fixture writes) — migrateLegacyDb must checkpoint it
  // itself before renaming, or all of this would be silently left behind at the old path.
  expect(existsSync(`${legacyPath}-wal`)).toBe(true);

  const result = migrateLegacyDb(root, { userPath });
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
  const result = migrateLegacyDb(root, { userPath });
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

test('prints what it did', () => {
  const root = tempRoot(), userPath = join(root, 'user.db');
  openDb(join(root, 'studio.db')).close();
  const logs = [], orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try { migrateLegacyDb(root, { userPath }); } finally { console.log = orig; }
  expect(logs).toContain('Moved studio.db to user.db (the Original now comes from studio/default.db).');
});

test('does nothing when studio.db does not exist', () => {
  const root = tempRoot(), userPath = join(root, 'user.db');
  expect(migrateLegacyDb(root, { userPath })).toBe(false);
  expect(existsSync(userPath)).toBe(false);
});

test('does nothing when user.db already exists, and leaves studio.db untouched', () => {
  const root = tempRoot(), userPath = join(root, 'user.db'), legacyPath = join(root, 'studio.db');
  openDb(legacyPath).close();
  openDb(userPath).close();

  expect(migrateLegacyDb(root, { userPath })).toBe(false);
  expect(existsSync(legacyPath)).toBe(true);
});
