// migrate.js: the one-time move from the old single-database layout (studio.db) to the split layout the examples
// database introduces (user.db, git-ignored, plus studio/default.db, tracked in git). Runs automatically on server
// start, before the server takes its lock.
import { existsSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

// Strips the Original's files, revisions and version row out of a database still named studio.db (not yet
// renamed) — it now comes from studio/default.db instead. Its jobs and renders rows stay: neither table has a
// foreign key to versions, so they keep resolving through "original" once that id names the example. Checkpoints
// the WAL into the main file afterward (so the file alone, without -wal/-shm, holds everything) and removes the
// now-empty -wal/-shm.
//
// Idempotent: run again on a database this has already cleaned, the deletes just affect zero rows. That's what
// makes migrateLegacyDb recoverable from an interruption between this step and the rename that follows it — see
// there.
export function cleanLegacyOriginal(legacyPath) {
  const db = new Database(legacyPath, { strict: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.transaction(() => {
    db.query("DELETE FROM files WHERE version_id = 'original'").run();
    db.query("DELETE FROM revisions WHERE version_id = 'original'").run();
    db.query("DELETE FROM versions WHERE id = 'original'").run();
  })();
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.close();
  for (const ext of ['-wal', '-shm']) { const p = `${legacyPath}${ext}`; if (existsSync(p)) unlinkSync(p); }
}

// Does nothing (and returns false) unless root/studio.db exists and userPath doesn't yet. Otherwise: cleans the
// Original out of studio.db (see cleanLegacyOriginal above) and only then renames studio.db to userPath — a single
// atomic filesystem operation, done last, so there's no window where userPath exists but is only half migrated.
// If the process dies before the rename, studio.db (perhaps already cleaned) is still there for the next call to
// pick back up; a database killed mid-clean rolls back to before that transaction, and gets cleaned again on
// retry. Once the rename has happened, userPath exists and every later call is a no-op.
export function migrateLegacyDb(root, { userPath }) {
  const legacyPath = join(root, 'studio.db');
  if (existsSync(userPath) || !existsSync(legacyPath)) return false;

  cleanLegacyOriginal(legacyPath);
  renameSync(legacyPath, userPath);

  console.log('Moved studio.db to user.db (the Original now comes from studio/default.db).');
  return true;
}
