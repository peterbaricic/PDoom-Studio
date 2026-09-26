// thumbs.js: the chapters' thumbnail strips (<data>/.studio/thumbs/<version>/c0N.jpg: three frames side by side),
// written by a chapter job's check (render.mjs --out, from Claude's draft) and by the thumbs job (from the frame
// cache), and the stamp beside each (c0N.json: { key, mtime }): the segment key the strip shows the chapter under
// (studio/frames/keys.js: its code, shared.js, the options, the engine) and the strip file's mtime when stamped. A
// strip is shown only while both still hold, so a chapter whose code changed since (a revision, a restore to older
// code) or a strip rewritten since (a check whose draft then failed) shows no strip rather than a wrong one.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { snapshotOf } from './snapshot.js';
import { chapterPaths, engineHash, segmentKeys } from './frames/keys.js';

export const thumbPath = (data, versionId, n) => join(data, '.studio/thumbs', versionId, `c0${n}.jpg`);
const stampPath = (data, versionId, n) => join(data, '.studio/thumbs', versionId, `c0${n}.json`);
const mtimeOf = p => { try { return Math.floor(statSync(p).mtimeMs); } catch { return null; } };
export const thumbMtime = (data, versionId, n) => mtimeOf(thumbPath(data, versionId, n));

// Chapter n's segment key now (null: not written, or no such version).
export function chapterKey(db, root, versionId, n, { dev = false } = {}) {
  const snap = snapshotOf(db, versionId);
  return snap ? segmentKeys(snap, engineHash(root, { recheck: dev }))[n] : null;
}

// Records that the strip on disk shows chapter n as painted under `key`.
export function stampThumb(data, versionId, n, key) {
  const mtime = thumbMtime(data, versionId, n);
  if (mtime == null || !key) return;
  mkdirSync(dirname(stampPath(data, versionId, n)), { recursive: true });
  writeFileSync(stampPath(data, versionId, n), JSON.stringify({ key, mtime }));
}

// { n: { mtime, revision } }: the chapters whose strip shows their current code, each with the strip's mtime and the
// chapter file's revision id (for the UI's URLs, which change when either does).
export function currentThumbs(db, root, data, versionId, { dev = false } = {}) {
  const snap = snapshotOf(db, versionId);
  if (!snap) return {};
  const keys = segmentKeys(snap, engineHash(root, { recheck: dev }));
  const revisions = Object.fromEntries(db.listFiles(versionId).map(f => [f.path, f.revision_id]));
  const out = {};
  for (let n = 1; n <= 9; n++) {
    const mtime = keys[n] && thumbMtime(data, versionId, n);
    if (mtime == null || !keys[n]) continue;
    let stamp;
    try { stamp = JSON.parse(readFileSync(stampPath(data, versionId, n), 'utf8')); } catch { continue; }
    if (stamp?.key !== keys[n] || stamp.mtime !== mtime) continue;
    out[n] = { mtime, revision: revisions[chapterPaths(snap.files, n)[0]] };
  }
  return out;
}
