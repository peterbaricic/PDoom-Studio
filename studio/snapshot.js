// snapshot.js: a version's current files, content-addressed. A snapshot is { options, files: { path: sha256 } },
// computed on demand from either database and identified by the SHA-256 of its own canonical JSON — so two
// versions (or the same version before and after a no-op edit) with identical effective content share the same id,
// whatever their version ids or file histories. Snapshots are kept in a small in-memory LRU so the renderer-host
// routes in studio/app.js can serve them by id: GET /api/snapshot/<id> (the manifest src/loader.js expects) and
// GET /api/blob/<sha256>, which studio.html?render&snapshot=<id> loads through.
import { createHash } from 'node:crypto';
import { DEFAULT_OPTIONS } from './versions.js';

export const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

// Canonical JSON: object keys sorted (recursively), so the same logical value serializes identically regardless of
// insertion order — this is what makes a version's options order-independent for the snapshot id. Arrays keep their
// given order (files is a plain object here, not an array, so this only ever matters for options).
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// db is a studio/db.js StudioDb (either the user's own or one with an example attached). Returns null for a
// versionId that doesn't exist. options is the version's own options merged over the engine defaults — the same
// merge buildManifest does — so a snapshot's options are exactly what the loader should apply, whether the page got
// there via ?v=<id> or ?snapshot=<id>.
export function snapshotOf(db, versionId) {
  const version = db.getVersion(versionId);
  if (!version) return null;
  const options = { ...DEFAULT_OPTIONS, ...version.options };
  const files = {};
  for (const f of db.listFiles(versionId)) files[f.path] = db.fileSha(versionId, f.path);
  const id = sha256(canonicalJson({ options, files }));
  return { id, options, files };
}

const MAX_SNAPSHOTS = 500;
const snapshots = new Map();   // id -> snapshot, oldest (least recently used) first

export function rememberSnapshot(snap) {
  snapshots.delete(snap.id);
  snapshots.set(snap.id, snap);
  if (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value);
  return snap;
}

export function getSnapshot(id) {
  const snap = snapshots.get(id);
  if (!snap) return null;
  snapshots.delete(id); snapshots.set(id, snap);   // touch: most recently used
  return snap;
}

// A file's content by hash, searching the revisions of both databases. The user's own are indexed (sha256 is
// filled on write and backfilled at open); an example's may not have the column filled, or at all, so default.db's
// rows are hashed in memory instead, once: into a sha -> revision id map, kept per database and read again only when
// a miss finds default.db holding other revisions than it was built from (a promote adds some).
const defIndexes = new WeakMap();   // db -> { stamp, ids: Map<sha, revision id> }
export function blobBySha(db, sha) {
  const own = db.db.query('SELECT content FROM revisions WHERE sha256 = $sha LIMIT 1').get({ sha });
  if (own) return own.content;
  if (!db.hasDef) return null;
  const fromDef = index => {
    const id = index?.ids.get(sha);
    return id == null ? null : db.db.query('SELECT content FROM def.revisions WHERE id = $id').get({ id })?.content ?? null;
  };
  let index = defIndexes.get(db);
  const hit = fromDef(index);
  if (hit != null) return hit;
  const { n, m } = db.db.query('SELECT count(*) AS n, max(id) AS m FROM def.revisions').get(), stamp = `${n}:${m}`;
  if (index?.stamp === stamp) return null;
  index = { stamp, ids: new Map() };
  for (const { id, content } of db.db.query('SELECT id, content FROM def.revisions').all()) index.ids.set(sha256(content), id);
  defIndexes.set(db, index);
  return fromDef(index);
}
