// migrate.js: the one-time move from the old single-database layout (studio.db) to the split layout the examples
// database introduces (user.db, git-ignored, plus studio/default.db, tracked in git). Runs automatically on server
// start, before the server takes its lock.
import { existsSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { liveLockHolder } from './lock.js';

// Takes the Original out of a database still named studio.db (not yet renamed) — it now comes from
// studio/default.db instead. As imported, it is simply dropped (files, revisions and version row). But if it has
// any revision of the user's own (any source other than 'import': a Claude job, a hand edit, a restore), it is kept
// instead, renamed to "original-edited" (or original-edited-2, … if that is taken) with all its files and revisions;
// the returned id says so (null when it was dropped). Either way its jobs and renders rows stay as they are: neither
// table has a foreign key to versions, so they keep resolving through "original" once that id names the example.
//
// Checkpoints the WAL into the main file afterward, so the file alone (without -wal/-shm) holds everything, and
// only then removes the now-empty -wal/-shm. TRUNCATE mode reports whether it actually managed that: busy != 0, or
// fewer frames checkpointed than the WAL held, means some other connection (a stale reader, most likely) kept it
// from completing — some committed data could still exist only in the WAL, so deleting it would lose that data.
// In that case this throws instead, leaving studio.db (and its WAL) exactly as they were; a later retry, once
// whatever was holding it open is gone, can pick up cleanly since the delete step is idempotent.
export function cleanLegacyOriginal(legacyPath) {
  const db = new Database(legacyPath, { strict: true });
  let checkpoint, keptAs = null;
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    db.transaction(() => {
      if (db.query("SELECT 1 FROM revisions WHERE version_id = 'original' AND source != 'import' LIMIT 1").get()) {
        keptAs = 'original-edited';
        for (let n = 2; db.query('SELECT 1 FROM versions WHERE id = $id').get({ id: keptAs }); n++) keptAs = `original-edited-${n}`;
        db.query(`INSERT INTO versions (id, title, logline, concept, options, status, created_at, updated_at)
          SELECT $id, title, logline, concept, options, status, created_at, updated_at FROM versions WHERE id = 'original'`).run({ id: keptAs });
        db.query("UPDATE files SET version_id = $id WHERE version_id = 'original'").run({ id: keptAs });
        db.query("UPDATE revisions SET version_id = $id WHERE version_id = 'original'").run({ id: keptAs });
      } else {
        db.query("DELETE FROM files WHERE version_id = 'original'").run();
        db.query("DELETE FROM revisions WHERE version_id = 'original'").run();
      }
      db.query("DELETE FROM versions WHERE id = 'original'").run();
    })();
    checkpoint = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
  } finally {
    db.close();
  }
  const { busy, log, checkpointed } = checkpoint;
  if (busy || checkpointed < log) {
    throw new Error(`studio.db's WAL did not fully checkpoint (busy=${busy}, checkpointed ${checkpointed}/${log} frames) — `
      + 'another connection may still have it open; leaving studio.db as is');
  }
  for (const ext of ['-wal', '-shm']) { const p = `${legacyPath}${ext}`; if (existsSync(p)) unlinkSync(p); }
  return keptAs;
}

// Does nothing (and returns false) once userPath exists. Before that, refuses (by throwing) if userPath's -wal or
// -shm is there without it: SQLite would take such a leftover for the database's own as soon as one exists at
// userPath again — the migrated studio.db, or a new one — and replay it onto it. Then does nothing more (and returns
// false) unless root/studio.db exists. Otherwise: refuses if a studio server is still running against studio.db —
// its lock file names a live pid — since moving the database out from under it would corrupt its next write.
// Otherwise takes the Original out of studio.db (see cleanLegacyOriginal above) and only then renames studio.db to
// userPath — a single atomic filesystem operation, done last, so there's no window where userPath exists but is only
// half migrated. If the process dies before the rename, studio.db (perhaps already cleaned) is still there for the
// next call to pick back up; a database killed mid-clean rolls back to before that transaction, and gets cleaned
// again on retry. Once the rename has happened, userPath exists and every later call is a no-op.
export function migrateLegacyDb(root, { userPath }) {
  if (existsSync(userPath)) return false;
  const stray = [`${userPath}-wal`, `${userPath}-shm`].find(p => existsSync(p));
  if (stray) throw new Error(`${stray} exists without ${userPath} — move it out of the way first (SQLite would replay it onto the new database)`);
  const legacyPath = join(root, 'studio.db');
  if (!existsSync(legacyPath)) return false;

  const held = liveLockHolder(legacyPath);
  if (held) throw new Error(`stop the running studio first (pid ${held.pid}, http://localhost:${held.port}/) — studio.db is still in use`);

  const keptAs = cleanLegacyOriginal(legacyPath);
  renameSync(legacyPath, userPath);

  console.log('Moved studio.db to user.db (the Original now comes from studio/default.db).');
  if (keptAs) console.log(`Your edits to the Original were kept, as the version "${keptAs}".`);
  return true;
}
