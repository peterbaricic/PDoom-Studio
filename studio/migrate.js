// migrate.js: the one-time move from the old single-database layout (studio.db) to the split layout the examples
// database introduces (user.db, git-ignored, plus studio/default.db, tracked in git). Runs automatically on server
// start, before the server takes its lock.
import { existsSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

// Does nothing (and returns false) unless root/studio.db exists and userPath doesn't yet. Otherwise: checkpoints
// studio.db's WAL into the main file (so nothing recently committed is left behind), removes the now-empty
// -wal/-shm, renames studio.db to userPath, then drops the Original's files, revisions and version row from it — it
// now comes from studio/default.db instead. Its jobs and renders rows stay: neither table has a foreign key to
// versions, so they keep resolving through "original" once that id names the example.
export function migrateLegacyDb(root, { userPath }) {
  const legacyPath = join(root, 'studio.db');
  if (existsSync(userPath) || !existsSync(legacyPath)) return false;

  const legacy = new Database(legacyPath, { strict: true });
  legacy.exec('PRAGMA journal_mode = WAL;');
  legacy.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  legacy.close();
  for (const ext of ['-wal', '-shm']) { const p = `${legacyPath}${ext}`; if (existsSync(p)) unlinkSync(p); }

  renameSync(legacyPath, userPath);

  const user = new Database(userPath, { strict: true });
  user.exec('PRAGMA foreign_keys = ON;');
  user.transaction(() => {
    user.query("DELETE FROM files WHERE version_id = 'original'").run();
    user.query("DELETE FROM revisions WHERE version_id = 'original'").run();
    user.query("DELETE FROM versions WHERE id = 'original'").run();
  })();
  user.close();

  console.log('Moved studio.db to user.db (the Original now comes from studio/default.db).');
  return true;
}
