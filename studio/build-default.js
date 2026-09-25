#!/usr/bin/env bun
// build-default.js --from <examples.db> <out.db>: builds a fresh examples database by copying every version out of
// an existing one — each version's metadata, every past revision and its current files. The Original's source
// (STORYBOARD.md, walkthrough and chapters) no longer lives in the repository's working tree; it lives in the
// committed studio/default.db, alongside any versions promoted since, and this script is how default.db itself is
// (re)built: from studio/default.db, or a copy of it. Revision ids are copied verbatim, so they stay >=
// EXAMPLE_REVISION_FLOOR, same as the source; a source with any below that (a user.db) is not an examples database
// and is refused, as is one without an "original" version.
//
// <out.db> must be a different file from the source. The new database is built in a temporary file beside it and
// renamed over it only once complete, so a failed build leaves an existing <out.db> as it was. It is created in
// rollback-journal mode (not WAL): read-only use (openDb's "def" attachment) then creates no -wal/-shm files next to it.
//
// To rebuild studio/default.db:
//   bun studio/build-default.js --from studio/default.db out/default.db && mv out/default.db studio/default.db
import { Database } from 'bun:sqlite';
import { existsSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { SCHEMA, EXAMPLE_REVISION_FLOOR } from './db.js';

const VERSIONS = 'id, title, logline, concept, options, status, created_at, updated_at';
const REVISIONS = 'id, version_id, path, content, job_id, source, note, created_at';
const FILES = 'version_id, path, content, revision_id';
const params = columns => columns.split(', ').map(c => '$' + c).join(', ');

// Whether a and b are the same file on disk (however each path is spelled: relative, via a symlink, …).
const sameFile = (a, b) => {
  try { const [x, y] = [statSync(a), statSync(b)]; return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
};
const removeWithJournals = p => { for (const f of [p, `${p}-wal`, `${p}-shm`, `${p}-journal`]) if (existsSync(f)) unlinkSync(f); };

export function buildDefault(fromPath, outPath) {
  if (sameFile(fromPath, outPath)) throw new Error(`${outPath} is the source itself: build into another file, then move it into place`);

  const src = new Database(fromPath, { readonly: true, strict: true });
  let versions, revisions, files;
  try {
    versions = src.query(`SELECT ${VERSIONS} FROM versions ORDER BY id`).all();
    revisions = src.query(`SELECT ${REVISIONS} FROM revisions ORDER BY id`).all();
    files = src.query(`SELECT ${FILES} FROM files ORDER BY version_id, path`).all();
  } finally {
    src.close();
  }
  if (!versions.some(v => v.id === 'original')) throw new Error(`no "original" version in ${fromPath}`);
  const low = revisions.find(r => r.id < EXAMPLE_REVISION_FLOOR);
  if (low) throw new Error(`${fromPath} is not an examples database (revision ${low.id} is below ${EXAMPLE_REVISION_FLOOR})`);

  // Beside <out.db>, so the rename is atomic; any leftover of an earlier build that died goes first. (Named so that
  // .gitignore's studio/default.db-* covers it too.)
  const tmpPath = `${outPath}-building`;
  removeWithJournals(tmpPath);
  try {
    const db = new Database(tmpPath, { create: true, strict: true });
    try {
      db.exec('PRAGMA journal_mode = DELETE;');
      db.exec(SCHEMA);
      db.transaction(() => {
        for (const v of versions) db.query(`INSERT INTO versions (${VERSIONS}) VALUES (${params(VERSIONS)})`).run(v);
        for (const r of revisions) db.query(`INSERT INTO revisions (${REVISIONS}) VALUES (${params(REVISIONS)})`).run(r);
        for (const f of files) db.query(`INSERT INTO files (${FILES}) VALUES (${params(FILES)})`).run(f);
      })();
    } finally {
      db.close();
    }
    // Journals left beside an old <out.db> would otherwise be taken for the new file's own and replayed onto it.
    for (const f of [`${outPath}-wal`, `${outPath}-shm`, `${outPath}-journal`]) if (existsSync(f)) unlinkSync(f);
    renameSync(tmpPath, outPath);
  } catch (e) {
    removeWithJournals(tmpPath);
    throw e;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const fromIdx = args.indexOf('--from');
  const from = fromIdx >= 0 ? args[fromIdx + 1] : null;
  const out = fromIdx >= 0 ? args.filter((_, i) => i !== fromIdx && i !== fromIdx + 1)[0] : null;
  if (!from || !out) {
    console.error('usage: bun studio/build-default.js --from <examples.db> <out.db>\n'
      + '  copies every version in <examples.db>, with all its revisions, into a fresh <out.db> (a different file)');
    process.exit(1);
  }
  try { buildDefault(from, out); }
  catch (e) { console.error(e.message); process.exit(1); }
  console.log(`Built ${out} from ${from}`);
}
