// db.js: the studio's SQLite store. Versions and their files (current content plus every past revision), jobs, and
// the library of finished renders.
//
// Two databases: user.db (git-ignored, read-write) holds the user's own versions plus all jobs, logs and renders.
// studio/default.db (tracked in git, read-only) holds example versions — at first just the Original. openDb attaches
// it, when given and present, as the read-only schema "def"; StudioDb then reads across both and keeps every write
// (other than Promote) on user.db, refusing to touch an example.
import { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

// A revision's content hash, stored in revisions.sha256 (filled on write, backfilled below for a database created
// before that column existed). Deliberately the same one-line computation as studio/snapshot.js's sha256, kept as
// its own copy here rather than an import: db.js has no dependency on the rest of studio/, and the tables it keeps
// content-addressed are hashed the same way regardless of who's asking.
const contentHash = text => createHash('sha256').update(text, 'utf8').digest('hex');

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', logline TEXT NOT NULL DEFAULT '', concept TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'concept', created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY, version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE, path TEXT NOT NULL,
  content TEXT NOT NULL, job_id INTEGER, source TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', sha256 TEXT, created_at INTEGER);
CREATE INDEX IF NOT EXISTS revisions_by_file ON revisions (version_id, path, id);
CREATE TABLE IF NOT EXISTS files (
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE, path TEXT NOT NULL, content TEXT NOT NULL,
  revision_id INTEGER NOT NULL, PRIMARY KEY (version_id, path));
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, version_id TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued', progress REAL NOT NULL DEFAULT 0, log TEXT NOT NULL DEFAULT '',
  cost_usd REAL NOT NULL DEFAULT 0, model TEXT, error TEXT, created_at INTEGER, started_at INTEGER, finished_at INTEGER);
CREATE TABLE IF NOT EXISTS renders (
  id INTEGER PRIMARY KEY, version_id TEXT NOT NULL, file TEXT NOT NULL, revision_ids TEXT NOT NULL DEFAULT '[]',
  snapshot_id TEXT, title TEXT NOT NULL DEFAULT '', logline TEXT NOT NULL DEFAULT '',
  duration_s REAL, render_s REAL, size_bytes INTEGER, poster TEXT, created_at INTEGER);
`;

const PATH_RE = /^(STORYBOARD\.md|shared\.js|walkthrough\.json|ch\/c0[1-9](_[a-z0-9_]+)?\.js)$/;
export const isValidPath = p => PATH_RE.test(p);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// Example revisions (built by build-default.js, or written by promoteVersion) use ids from here up, so a revision id
// alone says which database it lives in and GET /api/revisions/<id> and restore are never ambiguous.
export const EXAMPLE_REVISION_FLOOR = 1_000_000_000;

// The versions columns, by name: the reads that span both databases can't use SELECT *, which would pair up columns
// by position across two files whose tables needn't declare them in the same order.
const VERSION_COLUMNS = 'id, title, logline, concept, options, status, created_at, updated_at';

// Job lists leave out the log, which can be long; getJob has it.
const JOB_LIST_COLUMNS = 'id, kind, version_id, params, status, progress, cost_usd, model, error, created_at, started_at, finished_at';

const parseVersion = r => r && { ...r, options: JSON.parse(r.options), example: !!r.example };
const parseJob = r => r && { ...r, params: JSON.parse(r.params) };
const parseRender = r => r && { ...r, revision_ids: JSON.parse(r.revision_ids) };

// SQLite reads the attached name as a URI (for its ?mode=ro), so a %, ? or # in the path itself is percent-encoded:
// otherwise it would be taken as an escape, the query or a fragment, and SQLite would quietly open (and create)
// some other file instead.
const readOnlyUri = path => `file:${path.replace(/[%?#]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}?mode=ro`;

// path = user.db. { defaultPath } = studio/default.db: attached read-only as schema "def" when given and present.
// Without defaultPath (or when the file doesn't exist yet), behavior is exactly the single-database store this was.
export function openDb(path = 'studio.db', { defaultPath } = {}) {
  const hasDef = !!(defaultPath && existsSync(defaultPath));
  const db = new Database(path, { create: true, strict: true });
  // Before the first write this connection makes (the WAL pragma right below, unconditionally): refuse a path
  // that would make defaultPath unsafe to treat as read-only. This can't use a separate `{ readonly: true }`
  // connection — a plain, already-checkpointed WAL-mode database with no -wal/-shm beside it (exactly the state
  // migrate.js leaves the freshly renamed user.db in, and the ordinary state of any user.db between clean
  // restarts) fails to open read-only in this SQLite build (SQLITE_CANTOPEN), even though the very same file opens
  // fine the normal way, which is what every write path here already does. So the checks below run as read-only
  // queries on this same connection instead: opening a file that already exists doesn't write anything by itself,
  // so as long as nothing here issues a write before either check has passed, this is exactly as safe as a
  // separate read-only connection would have been, without that failure mode.
  if (hasDef) {
    try { assertSafeUserDb(db, path, defaultPath); }
    catch (e) { db.close(); throw e; }
  }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrateShaColumn(db);
  migrateRenderColumns(db);
  if (hasDef) db.query('ATTACH DATABASE ? AS def').run(readOnlyUri(defaultPath));
  return new StudioDb(db, { defaultPath, hasDef });
}

// Whether a and b are the same file on disk, however each path is spelled (relative, via a symlink, a hardlink, …):
// same device and inode, which is what "the same file" means regardless of the path strings used to reach it.
const sameFile = (a, b) => {
  try { const [x, y] = [statSync(a), statSync(b)]; return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
};

// Refuses db (path's connection, defaultPath already confirmed to exist) when defaultPath would be misused this
// way: the same file as path — attaching it later would alias the very database this connection is about to put
// into WAL mode and migrate, so the "read-only examples" file would in fact be the one live, mutable database — or
// path itself already looks like an examples database (any revision id >= EXAMPLE_REVISION_FLOOR, the range
// build-default.js and promoteVersion use), which would mean treating an examples database as the user's own,
// migrating and checkpointing it in place.
function assertSafeUserDb(db, path, defaultPath) {
  if (path !== ':memory:' && sameFile(path, defaultPath)) {
    throw new Error(`${path} and ${defaultPath} are the same file — refusing to open it as both the user database and the attached examples database`);
  }
  const hasRevisions = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'revisions'").get();
  const bad = hasRevisions && db.query('SELECT id FROM revisions WHERE id >= $floor LIMIT 1').get({ floor: EXAMPLE_REVISION_FLOOR });
  if (bad) {
    throw new Error(`${path} looks like an examples database (it has revision id ${bad.id} >= ${EXAMPLE_REVISION_FLOOR}) — refusing to open it as the user database`);
  }
}

// Adds revisions.sha256 to a database created before this column existed (CREATE TABLE IF NOT EXISTS above is a
// no-op for a table that already exists), then fills it, once, for every row still missing it. A fresh database
// already has the column from SCHEMA and no rows, so both steps are no-ops for it. Runs on the main schema only,
// before def (default.db, read-only, never migrated) is attached.
function migrateShaColumn(db) {
  const hasColumn = db.query('PRAGMA table_info(revisions)').all().some(c => c.name === 'sha256');
  if (!hasColumn) db.exec('ALTER TABLE revisions ADD COLUMN sha256 TEXT');
  // Not in SCHEMA above: SCHEMA runs before this point, so on a database migrated just now by the ALTER above, the
  // column (and so this index) wouldn't exist yet when SCHEMA ran — CREATE INDEX IF NOT EXISTS still errors on a
  // missing column, that clause only covers the index's own name. Idempotent, so safe to run on every open.
  db.exec('CREATE INDEX IF NOT EXISTS revisions_by_sha ON revisions (sha256)');
  const missing = db.query('SELECT id, content FROM revisions WHERE sha256 IS NULL').all();
  if (missing.length) {
    db.transaction(() => {
      for (const r of missing) db.query('UPDATE revisions SET sha256 = $sha256 WHERE id = $id').run({ id: r.id, sha256: contentHash(r.content) });
    })();
  }
}

// Adds renders.snapshot_id/title/logline to a database created before they existed (as migrateShaColumn does for
// revisions.sha256). A render's title and logline are its own stored copy — the version's own, as of when it was
// rendered — so a render still lists correctly once its version is gone (listRenders falls back to these when the
// join finds no version). No backfill needed: an old render's stored copy is blank, and until its version is
// actually deleted, listRenders keeps reading the version's current title and logline instead, exactly as before
// this column existed.
function migrateRenderColumns(db) {
  const columns = db.query('PRAGMA table_info(renders)').all().map(c => c.name);
  if (!columns.includes('snapshot_id')) db.exec('ALTER TABLE renders ADD COLUMN snapshot_id TEXT');
  if (!columns.includes('title')) db.exec("ALTER TABLE renders ADD COLUMN title TEXT NOT NULL DEFAULT ''");
  if (!columns.includes('logline')) db.exec("ALTER TABLE renders ADD COLUMN logline TEXT NOT NULL DEFAULT ''");
}

// Builds "a = $a, b = $b" from the allowed keys present in patch; objects are stored as JSON.
function setClause(patch, allowed) {
  const keys = Object.keys(patch).filter(k => allowed.includes(k));
  if (!keys.length) throw new Error('nothing to update');
  const values = Object.fromEntries(keys.map(k => [k, typeof patch[k] === 'object' && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]]));
  return { sql: keys.map(k => `${k} = $${k}`).join(', '), values };
}

class StudioDb {
  constructor(db, { defaultPath = null, hasDef = false } = {}) { this.db = db; this.defaultPath = defaultPath; this.hasDef = hasDef; }
  close() { this.db.close(); }

  // Whether versionId names an example (lives in def). False whenever def isn't attached. An id in both databases
  // (promoteVersion interrupted between its two steps) is an example: every read and write treats it as one.
  _isExample(versionId) {
    return this.hasDef && !!this.db.query('SELECT 1 FROM def.versions WHERE id = $id').get({ id: versionId });
  }
  // '' for a user version (or one that doesn't exist), 'def.' for an example: which schema holds versionId's rows.
  _schema(versionId) { return this._isExample(versionId) ? 'def.' : ''; }

  // ---------- versions ----------
  createVersion({ id, title = '', logline = '', concept = '', options = {} }) {
    if (!ID_RE.test(id)) throw new Error(`bad version id: ${id}`);
    if (this.getVersion(id)) throw new Error(`version id already exists: ${id}`);
    const t = Date.now();
    this.db.query(`INSERT INTO versions (id, title, logline, concept, options, status, created_at, updated_at)
      VALUES ($id, $title, $logline, $concept, $options, 'concept', $t, $t)`).run({ id, title, logline, concept, options: JSON.stringify(options), t });
    return this.getVersion(id);
  }
  getVersion(id) {
    const example = this.hasDef && this.db.query(`SELECT ${VERSION_COLUMNS}, 1 AS example FROM def.versions WHERE id = $id`).get({ id });
    return parseVersion(example || this.db.query(`SELECT ${VERSION_COLUMNS}, 0 AS example FROM versions WHERE id = $id`).get({ id }));
  }
  // Every version once, as getVersion sees it: the examples plus the user's own versions (minus any id default.db
  // also has), as rows with the same named columns.
  _versionsSql() {
    return this.hasDef
      ? `SELECT ${VERSION_COLUMNS}, 1 AS example FROM def.versions
         UNION ALL SELECT ${VERSION_COLUMNS}, 0 AS example FROM versions WHERE id NOT IN (SELECT id FROM def.versions)`
      : `SELECT ${VERSION_COLUMNS}, 0 AS example FROM versions`;
  }
  // Examples first (there's normally just a handful), then the user's own versions by created_at.
  listVersions() {
    return this.db.query(`${this._versionsSql()} ORDER BY example DESC, created_at, id`).all().map(parseVersion);
  }
  updateVersion(id, patch) {
    if (this._isExample(id)) throw new Error('examples are read-only');
    const { sql, values } = setClause(patch, ['title', 'logline', 'concept', 'status', 'options']);
    this.db.query(`UPDATE versions SET ${sql}, updated_at = $t WHERE id = $id`).run({ ...values, t: Date.now(), id });
    return this.getVersion(id);
  }

  // ---------- files and revisions ----------
  writeFiles(versionId, files, { source, note = '', jobId = null }) {
    if (this._isExample(versionId)) throw new Error('examples are read-only');
    const ids = [];
    this.db.transaction(() => {
      for (const { path, content } of files) {
        if (!isValidPath(path)) throw new Error(`not an allowed version file: ${path}`);
        if (this.getFile(versionId, path)?.content === content) continue;
        const { lastInsertRowid } = this.db.query(`INSERT INTO revisions (version_id, path, content, job_id, source, note, sha256, created_at)
          VALUES ($versionId, $path, $content, $jobId, $source, $note, $sha256, $t)`)
          .run({ versionId, path, content, jobId, source, note, sha256: contentHash(content), t: Date.now() });
        const rid = Number(lastInsertRowid);
        this.db.query(`INSERT INTO files (version_id, path, content, revision_id) VALUES ($versionId, $path, $content, $rid)
          ON CONFLICT (version_id, path) DO UPDATE SET content = excluded.content, revision_id = excluded.revision_id`).run({ versionId, path, content, rid });
        ids.push(rid);
      }
      if (ids.length) this.db.query('UPDATE versions SET updated_at = $t WHERE id = $versionId').run({ t: Date.now(), versionId });
    })();
    return ids;
  }
  getFile(versionId, path) {
    const schema = this._schema(versionId);
    return this.db.query(`SELECT path, content, revision_id FROM ${schema}files WHERE version_id = $versionId AND path = $path`).get({ versionId, path }) ?? null;
  }
  listFiles(versionId) {
    const schema = this._schema(versionId);
    return this.db.query(`SELECT path, revision_id FROM ${schema}files WHERE version_id = $versionId ORDER BY path`).all({ versionId });
  }
  // A file's current content hash. For the user's own versions, the stored column (filled on write, backfilled at
  // open) is authoritative. For an example, default.db is read-only at runtime and may not have the column filled —
  // or, for a database built before this column existed, at all — so it's computed here instead and cached in
  // memory per revision id (default.db's own content never changes once the server is running).
  fileSha(versionId, path) {
    const f = this.getFile(versionId, path);
    if (!f) return null;
    if (!this._isExample(versionId)) {
      const row = this.db.query('SELECT sha256 FROM revisions WHERE id = $id').get({ id: f.revision_id });
      return row?.sha256 ?? contentHash(f.content);
    }
    this._exampleShaCache ??= new Map();
    if (!this._exampleShaCache.has(f.revision_id)) this._exampleShaCache.set(f.revision_id, contentHash(f.content));
    return this._exampleShaCache.get(f.revision_id);
  }
  history(versionId, path) {
    const schema = this._schema(versionId);
    return path == null
      ? this.db.query(`SELECT * FROM ${schema}revisions WHERE version_id = $versionId ORDER BY id DESC`).all({ versionId })
      : this.db.query(`SELECT * FROM ${schema}revisions WHERE version_id = $versionId AND path = $path ORDER BY id DESC`).all({ versionId, path });
  }
  getRevision(id) {
    const schema = id >= EXAMPLE_REVISION_FLOOR ? 'def.' : '';
    if (schema && !this.hasDef) return null;
    return this.db.query(`SELECT * FROM ${schema}revisions WHERE id = $id`).get({ id }) ?? null;
  }
  restore(id) {
    const r = this.getRevision(id);
    if (!r) throw new Error(`no revision ${id}`);
    return this.writeFiles(r.version_id, [{ path: r.path, content: r.content }], { source: 'restore', note: `restored revision ${id}` })[0] ?? null;
  }

  // Copies fromId's current files and metadata into user.db as a new version (never an example, whatever fromId is),
  // all in one transaction: a remix that fails part way leaves nothing behind. Its revisions are source 'remix'; its
  // status is 'ready' once it already has all 9 chapters, else fromId's status.
  remixVersion(fromId, { id, title }) {
    const src = this.getVersion(fromId);
    if (!src) throw new Error(`no such version: ${fromId}`);
    return this.db.transaction(() => {
      this.createVersion({ id, title: title ?? src.title, logline: src.logline, concept: src.concept, options: src.options });
      const files = this.listFiles(fromId).map(f => this.getFile(fromId, f.path));
      this.writeFiles(id, files, { source: 'remix', note: `remixed from ${fromId}` });
      const chapters = files.filter(f => f.path.startsWith('ch/')).length;
      return this.updateVersion(id, { status: chapters >= 9 ? 'ready' : src.status });
    })();
  }

  // Moves a user version into default.db: its metadata, current files and one revision per file (source 'promote',
  // ids >= EXAMPLE_REVISION_FLOOR), in one transaction on a separate writable connection. Then deletes the version
  // (and its files and revisions) from user.db, in one transaction. Jobs and renders keep their version_id: it now
  // resolves to the example.
  //
  // Should the process die between those two transactions, the id is left in both databases (where it reads as the
  // example). Promoting it again then finishes the move: when default.db's copy has exactly these current files, it
  // only deletes the user.db copy. A different version that merely shares the id is refused.
  promoteVersion(id) {
    const own = this.db.query(`SELECT ${VERSION_COLUMNS} FROM versions WHERE id = $id`).get({ id });
    if (!own) throw new Error(this._isExample(id) ? `already an example: ${id}` : `no such version: ${id}`);
    if (!this.defaultPath || !existsSync(this.defaultPath)) throw new Error('default.db does not exist');
    const v = parseVersion(own);
    const files = this.db.query('SELECT path, content FROM files WHERE version_id = $id ORDER BY path').all({ id });

    if (this._isExample(id)) {
      const theirs = this.db.query('SELECT path, content FROM def.files WHERE version_id = $id ORDER BY path').all({ id });
      const same = theirs.length === files.length && theirs.every((f, i) => f.path === files[i].path && f.content === files[i].content);
      if (!same) throw new Error(`default.db already has a different version with the id ${id}`);
    } else {
      this._writeExample(v, files);
    }

    this.db.transaction(() => {
      this.db.query('DELETE FROM files WHERE version_id = $id').run({ id });
      this.db.query('DELETE FROM revisions WHERE version_id = $id').run({ id });
      this.db.query('DELETE FROM versions WHERE id = $id').run({ id });
    })();

    return this.getVersion(id);
  }
  // Deletes one of the user's own versions: the version, its files, its revisions and its jobs (logs included), in one
  // transaction. Its renders are deleted too only when `videos` is set; otherwise they stay in the library, listed
  // under the title and logline stored with each (see listRenders). Refuses an example, and a version with a job
  // still queued or running (that job would go on writing to, or rendering, a version that's gone). Returns the
  // library files (videos and posters) of the renders it deleted, for the caller to remove from disk.
  deleteVersion(id, { videos = false } = {}) {
    if (this._isExample(id)) throw new Error('examples are read-only');
    if (!this.getVersion(id)) throw new Error(`no such version: ${id}`);
    const [busy] = this.findJobs({ versionId: id, kinds: ['storyboard', 'shared', 'chapter', 'render', 'thumbs'], statuses: ['queued', 'running'] });
    if (busy) throw new Error(`a ${busy.kind} job for this version is still ${busy.status} — let it finish or cancel it first`);
    return this.db.transaction(() => {
      const renders = videos ? this.db.query('SELECT file, poster FROM renders WHERE version_id = $id ORDER BY id').all({ id }) : [];
      if (videos) this.db.query('DELETE FROM renders WHERE version_id = $id').run({ id });
      this.db.query('DELETE FROM jobs WHERE version_id = $id').run({ id });
      this.db.query('DELETE FROM files WHERE version_id = $id').run({ id });
      this.db.query('DELETE FROM revisions WHERE version_id = $id').run({ id });
      this.db.query('DELETE FROM versions WHERE id = $id').run({ id });
      return { deletedRenders: renders.flatMap(r => [r.file, r.poster]).filter(Boolean) };
    })();
  }

  // promoteVersion's first step: v and its current files into default.db, on a separate writable connection.
  _writeExample(v, files) {
    const defDb = new Database(this.defaultPath, { strict: true });
    defDb.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    try {
      defDb.transaction(() => {
        defDb.query(`INSERT INTO versions (id, title, logline, concept, options, status, created_at, updated_at)
          VALUES ($id, $title, $logline, $concept, $options, $status, $createdAt, $updatedAt)`).run({
          id: v.id, title: v.title, logline: v.logline, concept: v.concept, options: JSON.stringify(v.options),
          status: v.status, createdAt: v.created_at, updatedAt: Date.now(),
        });
        let rid = defDb.query(`SELECT COALESCE(MAX(id) + 1, ${EXAMPLE_REVISION_FLOOR}) AS n FROM revisions`).get().n;
        if (rid < EXAMPLE_REVISION_FLOOR) rid = EXAMPLE_REVISION_FLOOR;
        for (const f of files) {
          defDb.query(`INSERT INTO revisions (id, version_id, path, content, job_id, source, note, created_at)
            VALUES ($id, $versionId, $path, $content, NULL, 'promote', '', $t)`).run({ id: rid, versionId: v.id, path: f.path, content: f.content, t: Date.now() });
          defDb.query(`INSERT INTO files (version_id, path, content, revision_id) VALUES ($versionId, $path, $content, $rid)`)
            .run({ versionId: v.id, path: f.path, content: f.content, rid });
          rid++;
        }
      })();
    } finally {
      defDb.close();
    }
  }

  // ---------- jobs ----------
  addJob({ kind, versionId, params = {}, model = null }) {
    const { lastInsertRowid } = this.db.query(`INSERT INTO jobs (kind, version_id, params, model, created_at)
      VALUES ($kind, $versionId, $params, $model, $t)`).run({ kind, versionId, params: JSON.stringify(params), model, t: Date.now() });
    return Number(lastInsertRowid);
  }
  getJob(id) { return parseJob(this.db.query('SELECT * FROM jobs WHERE id = $id').get({ id })); }
  listJobs({ versionId = null, limit = 100 } = {}) {
    const rows = versionId
      ? this.db.query(`SELECT ${JOB_LIST_COLUMNS} FROM jobs WHERE version_id = $versionId ORDER BY id DESC LIMIT $limit`).all({ versionId, limit })
      : this.db.query(`SELECT ${JOB_LIST_COLUMNS} FROM jobs ORDER BY id DESC LIMIT $limit`).all({ limit });
    return rows.map(parseJob);
  }
  // A version's jobs of some kinds in some statuses, newest first (without logs).
  findJobs({ versionId, kinds, statuses }) {
    const list = (name, values) => values.map((_, i) => `$${name}${i}`).join(', ');
    const bind = (name, values) => Object.fromEntries(values.map((v, i) => [`${name}${i}`, v]));
    return this.db.query(`SELECT ${JOB_LIST_COLUMNS} FROM jobs WHERE version_id = $versionId AND kind IN (${list('k', kinds)})
      AND status IN (${list('s', statuses)}) ORDER BY id DESC`).all({ versionId, ...bind('k', kinds), ...bind('s', statuses) }).map(parseJob);
  }
  updateJob(id, patch) {
    const { sql, values } = setClause(patch, ['status', 'progress', 'cost_usd', 'error', 'started_at', 'finished_at', 'params']);
    this.db.query(`UPDATE jobs SET ${sql} WHERE id = $id`).run({ ...values, id });
    return this.getJob(id);
  }
  appendLog(id, text) { this.db.query('UPDATE jobs SET log = log || $text WHERE id = $id').run({ id, text }); }
  queuedJobs() { return this.db.query(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY id`).all().map(parseJob); }
  repointDependents(oldId, newId) {
    let n = 0;
    for (const j of this.queuedJobs()) if (j.params.after === oldId) { this.updateJob(j.id, { params: { ...j.params, after: newId } }); n++; }
    return n;
  }
  markInterrupted() {
    return this.db.query(`UPDATE jobs SET status = 'interrupted', finished_at = $t WHERE status = 'running'`).run({ t: Date.now() }).changes;
  }

  // ---------- renders ----------
  // title/logline are the version's own, captured at render time — see migrateRenderColumns.
  addRender({ versionId, file, revisionIds = [], snapshotId = null, title = '', logline = '', durationS, renderS, sizeBytes, poster }) {
    const { lastInsertRowid } = this.db.query(`INSERT INTO renders (version_id, file, revision_ids, snapshot_id, title, logline, duration_s, render_s, size_bytes, poster, created_at)
      VALUES ($versionId, $file, $revisionIds, $snapshotId, $title, $logline, $durationS, $renderS, $sizeBytes, $poster, $t)`)
      .run({ versionId, file, revisionIds: JSON.stringify(revisionIds), snapshotId, title, logline, durationS, renderS, sizeBytes, poster, t: Date.now() });
    return Number(lastInsertRowid);
  }
  // Named after the version currently holding version_id when there is one (v.title/v.logline via the LEFT JOIN);
  // once that version is gone (deleted, or never existed), the render's own stored title/logline stand in instead.
  listRenders() {
    return this.db.query(`SELECT r.id, r.version_id, r.file, r.revision_ids, r.snapshot_id, r.duration_s, r.render_s, r.size_bytes, r.poster, r.created_at,
        COALESCE(v.title, r.title) AS title, COALESCE(v.logline, r.logline) AS logline
      FROM renders r LEFT JOIN (${this._versionsSql()}) v ON v.id = r.version_id
      ORDER BY r.created_at DESC, r.id DESC`).all().map(parseRender);
  }
  getRender(id) { return parseRender(this.db.query('SELECT * FROM renders WHERE id = $id').get({ id })); }
  deleteRender(id) { this.db.query('DELETE FROM renders WHERE id = $id').run({ id }); }
}
