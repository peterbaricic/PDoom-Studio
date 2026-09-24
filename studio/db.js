// db.js: the studio's SQLite store. Versions and their files (current content plus every past revision), jobs, and
// the library of finished renders. One file, studio.db, next to the project.
import { Database } from 'bun:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', logline TEXT NOT NULL DEFAULT '', concept TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'concept', created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY, version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE, path TEXT NOT NULL,
  content TEXT NOT NULL, job_id INTEGER, source TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER);
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
  duration_s REAL, render_s REAL, size_bytes INTEGER, poster TEXT, created_at INTEGER);
`;

const PATH_RE = /^(STORYBOARD\.md|shared\.js|walkthrough\.json|ch\/c0[1-9](_[a-z0-9_]+)?\.js)$/;
export const isValidPath = p => PATH_RE.test(p);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

const parseVersion = r => r && { ...r, options: JSON.parse(r.options) };
const parseJob = r => r && { ...r, params: JSON.parse(r.params) };
const parseRender = r => r && { ...r, revision_ids: JSON.parse(r.revision_ids) };

export function openDb(path = 'studio.db') {
  const db = new Database(path, { create: true, strict: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return new StudioDb(db);
}

// Builds "a = $a, b = $b" from the allowed keys present in patch; objects are stored as JSON.
function setClause(patch, allowed) {
  const keys = Object.keys(patch).filter(k => allowed.includes(k));
  if (!keys.length) throw new Error('nothing to update');
  const values = Object.fromEntries(keys.map(k => [k, typeof patch[k] === 'object' && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]]));
  return { sql: keys.map(k => `${k} = $${k}`).join(', '), values };
}

class StudioDb {
  constructor(db) { this.db = db; }
  close() { this.db.close(); }

  // ---------- versions ----------
  createVersion({ id, title = '', logline = '', concept = '', options = {} }) {
    if (!ID_RE.test(id)) throw new Error(`bad version id: ${id}`);
    const t = Date.now();
    this.db.query(`INSERT INTO versions (id, title, logline, concept, options, status, created_at, updated_at)
      VALUES ($id, $title, $logline, $concept, $options, 'concept', $t, $t)`).run({ id, title, logline, concept, options: JSON.stringify(options), t });
    return this.getVersion(id);
  }
  getVersion(id) { return parseVersion(this.db.query('SELECT * FROM versions WHERE id = $id').get({ id })); }
  listVersions() { return this.db.query('SELECT * FROM versions ORDER BY created_at, id').all().map(parseVersion); }
  updateVersion(id, patch) {
    const { sql, values } = setClause(patch, ['title', 'logline', 'concept', 'status', 'options']);
    this.db.query(`UPDATE versions SET ${sql}, updated_at = $t WHERE id = $id`).run({ ...values, t: Date.now(), id });
    return this.getVersion(id);
  }

  // ---------- files and revisions ----------
  writeFiles(versionId, files, { source, note = '', jobId = null }) {
    const ids = [];
    this.db.transaction(() => {
      for (const { path, content } of files) {
        if (!isValidPath(path)) throw new Error(`not an allowed version file: ${path}`);
        if (this.getFile(versionId, path)?.content === content) continue;
        const { lastInsertRowid } = this.db.query(`INSERT INTO revisions (version_id, path, content, job_id, source, note, created_at)
          VALUES ($versionId, $path, $content, $jobId, $source, $note, $t)`).run({ versionId, path, content, jobId, source, note, t: Date.now() });
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
    return this.db.query('SELECT path, content, revision_id FROM files WHERE version_id = $versionId AND path = $path').get({ versionId, path }) ?? null;
  }
  listFiles(versionId) {
    return this.db.query('SELECT path, revision_id FROM files WHERE version_id = $versionId ORDER BY path').all({ versionId });
  }
  history(versionId, path) {
    return this.db.query('SELECT * FROM revisions WHERE version_id = $versionId AND path = $path ORDER BY id DESC').all({ versionId, path });
  }
  getRevision(id) { return this.db.query('SELECT * FROM revisions WHERE id = $id').get({ id }) ?? null; }
  restore(id) {
    const r = this.getRevision(id);
    if (!r) throw new Error(`no revision ${id}`);
    return this.writeFiles(r.version_id, [{ path: r.path, content: r.content }], { source: 'restore', note: `restored revision ${id}` })[0] ?? null;
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
      ? this.db.query('SELECT * FROM jobs WHERE version_id = $versionId ORDER BY id DESC LIMIT $limit').all({ versionId, limit })
      : this.db.query('SELECT * FROM jobs ORDER BY id DESC LIMIT $limit').all({ limit });
    return rows.map(parseJob);
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
  addRender({ versionId, file, revisionIds, durationS, renderS, sizeBytes, poster }) {
    const { lastInsertRowid } = this.db.query(`INSERT INTO renders (version_id, file, revision_ids, duration_s, render_s, size_bytes, poster, created_at)
      VALUES ($versionId, $file, $revisionIds, $durationS, $renderS, $sizeBytes, $poster, $t)`)
      .run({ versionId, file, revisionIds: JSON.stringify(revisionIds), durationS, renderS, sizeBytes, poster, t: Date.now() });
    return Number(lastInsertRowid);
  }
  listRenders() {
    return this.db.query(`SELECT r.*, v.title, v.logline FROM renders r JOIN versions v ON v.id = r.version_id
      ORDER BY r.created_at DESC, r.id DESC`).all().map(parseRender);
  }
  getRender(id) { return parseRender(this.db.query('SELECT * FROM renders WHERE id = $id').get({ id })); }
  deleteRender(id) { this.db.query('DELETE FROM renders WHERE id = $id').run({ id }); }
}
