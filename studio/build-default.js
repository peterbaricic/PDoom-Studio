#!/usr/bin/env bun
// build-default.js --from <source.db> <out.db>: builds a fresh examples database by copying the "original" example
// version — its metadata, every past revision and its current files — out of an existing default database. The
// Original's source (STORYBOARD.md, walkthrough and chapters) no longer lives in the repository's working tree; it
// lives in the committed studio/default.db, and this script is how default.db itself is (re)built, from any other
// database that already has an "original" version (typically the repo's own studio/default.db, or a copy of it).
// Its revision ids are copied verbatim, so they stay >= EXAMPLE_REVISION_FLOOR, same as the source. The database is
// created in rollback-journal mode (not WAL): read-only use (openDb's "def" attachment) then creates no -wal/-shm
// files next to it.
//
// Run as: bun studio/build-default.js --from studio/default.db studio/default.db
import { Database } from 'bun:sqlite';
import { existsSync, unlinkSync } from 'node:fs';
import { SCHEMA } from './db.js';

export function buildDefault(fromPath, outPath) {
  for (const f of [outPath, `${outPath}-wal`, `${outPath}-shm`, `${outPath}-journal`]) if (existsSync(f)) unlinkSync(f);

  const src = new Database(fromPath, { readonly: true, strict: true });
  const version = src.query(`SELECT * FROM versions WHERE id = 'original'`).get();
  if (!version) throw new Error(`no "original" version in ${fromPath}`);
  const revisions = src.query(`SELECT * FROM revisions WHERE version_id = 'original' ORDER BY id`).all();
  const files = src.query(`SELECT * FROM files WHERE version_id = 'original'`).all();
  src.close();

  const db = new Database(outPath, { create: true, strict: true });
  db.exec('PRAGMA journal_mode = DELETE;');
  db.exec(SCHEMA);
  db.transaction(() => {
    db.query(`INSERT INTO versions (id, title, logline, concept, options, status, created_at, updated_at)
      VALUES ($id, $title, $logline, $concept, $options, $status, $created_at, $updated_at)`).run(version);
    for (const r of revisions) {
      db.query(`INSERT INTO revisions (id, version_id, path, content, job_id, source, note, created_at)
        VALUES ($id, $version_id, $path, $content, $job_id, $source, $note, $created_at)`).run(r);
    }
    for (const f of files) {
      db.query(`INSERT INTO files (version_id, path, content, revision_id) VALUES ($version_id, $path, $content, $revision_id)`).run(f);
    }
  })();
  db.close();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const fromIdx = args.indexOf('--from');
  const from = fromIdx >= 0 ? args[fromIdx + 1] : null;
  const out = args.filter((_, i) => i !== fromIdx && i !== fromIdx + 1)[0];
  if (!from || !out) { console.error('usage: bun studio/build-default.js --from <source.db> <out.db>'); process.exit(1); }
  buildDefault(from, out);
  console.log(`Built ${out} from ${from}`);
}
