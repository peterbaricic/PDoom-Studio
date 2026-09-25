import { test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { openDb } from '../studio/db.js';
import { createApp } from '../studio/app.js';
import { createEvents } from '../studio/events.js';
import { serve } from '../studio/serve.js';
import { sha256, snapshotOf, rememberSnapshot, getSnapshot, blobBySha } from '../studio/snapshot.js';
import { tempDir, tempDefaultDb, expectPixelsMatch } from './helpers.js';

const root = process.cwd(), T = { timeout: 300000 };
const defaultDbPath = tempDefaultDb();   // once per file: a private copy, examples are read from it, never written
const fakeQueue = { enqueue: () => 1, approve: () => [], cancel: () => true, retry: () => 1 };

let db;
beforeEach(() => { db = openDb(':memory:', { defaultPath: defaultDbPath }); });

test('sha256 hashes text to hex', () => {
  expect(sha256('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  expect(sha256('hello')).toMatch(/^[0-9a-f]{64}$/);
});

test('two versions with identical files and options get the same snapshot id', () => {
  const files = [{ path: 'shared.js', content: '// shared' }, { path: 'ch/c01.js', content: '// one' }];
  db.createVersion({ id: 'a', options: { wipes: false } });
  db.writeFiles('a', files, { source: 'manual' });
  db.createVersion({ id: 'b', options: { wipes: false } });
  db.writeFiles('b', files, { source: 'manual' });
  const sa = snapshotOf(db, 'a'), sb = snapshotOf(db, 'b');
  expect(sa.id).toMatch(/^[0-9a-f]{64}$/);
  expect(sa.id).toBe(sb.id);
  expect(sa.files).toEqual(sb.files);
});

test('changing one chapter changes the snapshot id and only that chapter\'s hash', () => {
  db.createVersion({ id: 'a' });
  db.writeFiles('a', [{ path: 'ch/c01.js', content: '// one' }, { path: 'ch/c02.js', content: '// two' }], { source: 'manual' });
  const before = snapshotOf(db, 'a');
  db.writeFiles('a', [{ path: 'ch/c01.js', content: '// one, revised' }], { source: 'manual' });
  const after = snapshotOf(db, 'a');
  expect(after.id).not.toBe(before.id);
  expect(after.files['ch/c01.js']).not.toBe(before.files['ch/c01.js']);
  expect(after.files['ch/c02.js']).toBe(before.files['ch/c02.js']);
});

test('an unknown version has no snapshot', () => {
  expect(snapshotOf(db, 'does-not-exist')).toBeNull();
});

test('options key order does not change the snapshot id', () => {
  db.createVersion({ id: 'a', options: { wipes: false, cornerMeter: true } });
  db.writeFiles('a', [{ path: 'ch/c01.js', content: '// one' }], { source: 'manual' });
  const s1 = snapshotOf(db, 'a');
  db.updateVersion('a', { options: { cornerMeter: true, wipes: false } });
  const s2 = snapshotOf(db, 'a');
  expect(s2.id).toBe(s1.id);
  expect(s2.options).toEqual(s1.options);
});

test('blobBySha finds content in the user database and in an attached example database', () => {
  db.createVersion({ id: 'a' });
  db.writeFiles('a', [{ path: 'ch/c01.js', content: '// mine, not in default.db' }], { source: 'manual' });
  expect(blobBySha(db, db.fileSha('a', 'ch/c01.js'))).toBe('// mine, not in default.db');

  const origSha = db.fileSha('original', 'ch/c01_lab.js');
  expect(blobBySha(db, origSha)).toBe(db.getFile('original', 'ch/c01_lab.js').content);

  expect(blobBySha(db, sha256('never written anywhere'))).toBeNull();
});

test('opening an older database backfills sha256 for its existing revisions', () => {
  // A user.db from before this column existed: same shape as db.js's SCHEMA, minus sha256.
  const path = join(tempDir(), 'old.db');
  const legacy = new Database(path, { create: true, strict: true });
  legacy.exec(`CREATE TABLE versions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', logline TEXT NOT NULL DEFAULT '', concept TEXT NOT NULL DEFAULT '',
    options TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'concept', created_at INTEGER, updated_at INTEGER);
    CREATE TABLE revisions (id INTEGER PRIMARY KEY, version_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL,
      job_id INTEGER, source TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER);
    CREATE TABLE files (version_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, revision_id INTEGER NOT NULL, PRIMARY KEY (version_id, path));`);
  legacy.query(`INSERT INTO versions (id, title, created_at, updated_at) VALUES ('old', 'Old', 1, 1)`).run();
  legacy.query(`INSERT INTO revisions (id, version_id, path, content, source, created_at) VALUES (1, 'old', 'ch/c01.js', 'legacy content', 'manual', 1)`).run();
  legacy.query(`INSERT INTO files (version_id, path, content, revision_id) VALUES ('old', 'ch/c01.js', 'legacy content', 1)`).run();
  legacy.close();

  const opened = openDb(path);
  // Read straight off the stored column (not through fileSha's in-memory fallback), so this actually proves the
  // migration wrote it, rather than merely that fileSha can still compute it on the fly.
  expect(opened.getRevision(1).sha256).toBe(sha256('legacy content'));
  expect(opened.fileSha('old', 'ch/c01.js')).toBe(sha256('legacy content'));
  // the sha256 index is added along with the column, for a database that only gets it through this migration
  const indexes = opened.db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'revisions'").all().map(r => r.name);
  expect(indexes).toContain('revisions_by_sha');
});

test('remembers at most 500 snapshots, evicting the least recently used', () => {
  const ids = Array.from({ length: 501 }, (_, i) => rememberSnapshot({ id: sha256(`lru-test-${i}`), options: {}, files: {} }).id);
  expect(getSnapshot(ids[0])).toBeNull();
  expect(getSnapshot(ids[1])).not.toBeNull();
  expect(getSnapshot(ids[500])).not.toBeNull();
});

test('the snapshot and blob routes serve only on renderer hosts', async () => {
  db.createVersion({ id: 'a' });
  db.writeFiles('a', [{ path: 'shared.js', content: '// shared' }, { path: 'ch/c01.js', content: '// c1' }], { source: 'manual' });
  const snap = rememberSnapshot(snapshotOf(db, 'a'));
  const sharedSha = snap.files['shared.js'], chapterSha = snap.files['ch/c01.js'];
  const app = createApp({ db, root, data: tempDir(), token: 'tok', queue: fakeQueue, events: createEvents(), port: 8080 });
  const at = (host, p) => app.fetch(new Request(`http://${host}${p}`, { headers: { host } }));

  for (const host of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080']) {
    expect((await at(host, `/api/snapshot/${snap.id}`)).status).toBe(404);
    expect((await at(host, `/api/blob/${chapterSha}`)).status).toBe(404);
  }
  for (const host of ['w0.localhost:8080', 'w2.localhost:8080']) {
    const manifest = await at(host, `/api/snapshot/${snap.id}`);
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toEqual({
      id: snap.id, options: snap.options, scripts: [`/api/blob/${sharedSha}`, `/api/blob/${chapterSha}`], files: ['ch/c01.js', 'shared.js'],
    });
    const blob = await at(host, `/api/blob/${chapterSha}`);
    expect(blob.status).toBe(200);
    expect(await blob.text()).toBe('// c1');
    expect(blob.headers.get('content-type')).toContain('text/javascript');
    expect(blob.headers.get('x-content-type-options')).toBe('nosniff');
  }
});

test('an unknown snapshot or blob 404s on a renderer host', async () => {
  const app = createApp({ db, root, data: tempDir(), token: 'tok', queue: fakeQueue, events: createEvents(), port: 8080 });
  const at = p => app.fetch(new Request(`http://w0.localhost:8080${p}`, { headers: { host: 'w0.localhost:8080' } }));
  expect((await at(`/api/snapshot/${sha256('nope')}`)).status).toBe(404);
  expect((await at(`/api/blob/${sha256('nope, never written')}`)).status).toBe(404);
});

test('a painting page loaded by snapshot draws the same pixels as loading the same version by id', async () => {
  const snap = rememberSnapshot(snapshotOf(db, 'original'));
  const srv = serve({ db, root, data: tempDir(), token: 't', events: createEvents(), port: 0 });
  const spawnRender = async argv => {
    const p = Bun.spawn(['bun', 'render.mjs', ...argv], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };
  try {
    const times = [5, 40, 90], bySnapshot = mkdtempSync(join(tmpdir(), 'by-snapshot-')), byVersion = mkdtempSync(join(tmpdir(), 'by-version-'));
    const [a, b] = await Promise.all([
      spawnRender([`--stills=${times.join(',')}`, `--base=${srv.url}`, `--snapshot=${snap.id}`, `--out=${bySnapshot}`]),
      spawnRender([`--stills=${times.join(',')}`, `--base=${srv.url}`, `--v=original`, `--out=${byVersion}`]),
    ]);
    expect(a.err).toBe(''); expect(a.code).toBe(0);
    expect(b.err).toBe(''); expect(b.code).toBe(0);
    for (const t of times) {
      const name = `t${t.toFixed(2).replace('.', '_')}.png`;
      const [snapBuf, verBuf] = await Promise.all([Bun.file(join(bySnapshot, name)).arrayBuffer(), Bun.file(join(byVersion, name)).arrayBuffer()]);
      expect(snapBuf.byteLength).toBeGreaterThan(1000);
      // Pixels, not raw bytes: two separate renders of the same deterministic scene can differ by a sliver of GPU
      // rasterization noise (see PIXEL_TOLERANCE in test/helpers.js) even when every input is identical.
      expectPixelsMatch(Buffer.from(snapBuf), Buffer.from(verBuf), `t=${t}`);
    }
  } finally {
    srv.stop();
  }
}, T);
