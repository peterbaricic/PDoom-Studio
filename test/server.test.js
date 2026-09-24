import { test, expect } from 'bun:test';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, EXAMPLE_REVISION_FLOOR } from '../studio/db.js';
import { isolatedEnv, tempDefaultDb } from './helpers.js';

const defaultDbPath = tempDefaultDb();   // once per file: a private copy, never written by these tests
const envFor = (userPath, extra = {}) => isolatedEnv(undefined, { USER_DB: userPath, DEFAULT_DB: defaultDbPath, ...extra });
async function startWith(env) {
  const p = Bun.spawn(['bun', 'studio/server.js', '--port=0'], { env, stdout: 'pipe', stderr: 'pipe' });
  const reader = p.stdout.getReader(), dec = new TextDecoder();
  let out = '';
  while (!/Studio: (http:\/\/localhost:\d+)\//.test(out)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the server exited: ${out}${await new Response(p.stderr).text()}`);
    out += dec.decode(value);
  }
  return { p, out, url: /Studio: (http:\/\/localhost:\d+)\//.exec(out)[1] };
}
const start = (userPath, extra = {}) => startWith(envFor(userPath, extra));

test('starts, serves the examples database and marks unfinished jobs as interrupted', async () => {
  const userPath = join(mkdtempSync(join(tmpdir(), 'srv-')), 'user.db');
  const db = openDb(userPath);
  db.createVersion({ id: 'x' });
  const jid = db.addJob({ kind: 'chapter', versionId: 'x', params: { chapter: 1 } });
  db.updateJob(jid, { status: 'running' });
  db.close();

  const { p, out, url } = await start(userPath);
  try {
    expect(out).toContain('1 unfinished job marked as interrupted');
    const page = await (await fetch(url + '/')).text();
    expect(page).toMatch(/name="studio-token" content="[0-9a-f]{48}"/);
    const versions = await (await fetch(url + '/api/versions')).json();
    expect(versions.map(v => v.id)).toEqual(expect.arrayContaining(['original', 'x']));
    expect(versions.find(v => v.id === 'original').example).toBe(true);
    expect(versions.find(v => v.id === 'x').example).toBe(false);
    const job = (await (await fetch(url + '/api/jobs')).json()).find(j => j.id === jid);
    expect(job.status).toBe('interrupted');
  } finally { p.kill(); }
}, { timeout: 30000 });

test('refuses to start when DEFAULT_DB does not exist', async () => {
  const userPath = join(mkdtempSync(join(tmpdir(), 'srv-')), 'user.db');
  const p = Bun.spawn(['bun', 'studio/server.js', '--port=0'],
    { env: envFor(userPath, { DEFAULT_DB: join(tmpdir(), 'nope-' + Date.now(), 'default.db') }), stdout: 'ignore', stderr: 'pipe' });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(1);
  expect(err).toContain('no examples database');
}, { timeout: 30000 });

test('a second server on the same USER_DB refuses to start', async () => {
  const userPath = join(mkdtempSync(join(tmpdir(), 'srv-')), 'user.db');
  const first = await start(userPath);
  try {
    const second = Bun.spawn(['bun', 'studio/server.js', '--port=0'], { env: envFor(userPath), stdout: 'ignore', stderr: 'pipe' });
    const [err, code] = await Promise.all([new Response(second.stderr).text(), second.exited]);
    expect(code).toBe(1);
    expect(err).toContain('another studio is already running');
  } finally { first.p.kill(); }
}, { timeout: 30000 });

test('on start, migrates a studio.db in the data folder to user.db, and serves its versions beside the examples', async () => {
  // Without USER_DB (or STUDIO_DB), the user database is user.db in STUDIO_DATA, and the old studio.db is looked for
  // there too; with USER_DB pointing into that folder, the same happens.
  for (const pinUserDb of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'srv-migrate-'));
    const legacy = openDb(join(dir, 'studio.db'));
    legacy.createVersion({ id: 'original', title: 'Orig' });
    legacy.writeFiles('original', [{ path: 'STORYBOARD.md', content: 'orig storyboard' }], { source: 'import' });
    legacy.createVersion({ id: 'space-opera', title: 'Space Opera' });
    legacy.writeFiles('space-opera', [{ path: 'STORYBOARD.md', content: 'space opera storyboard' }], { source: 'manual' });
    const jid = legacy.addJob({ kind: 'storyboard', versionId: 'space-opera' });
    legacy.updateJob(jid, { status: 'done', cost_usd: 0.42 });
    legacy.close();

    const { USER_DB, STUDIO_DB, ...env } = isolatedEnv(dir, { DEFAULT_DB: defaultDbPath });
    const { p, out, url } = await startWith(pinUserDb ? { ...env, USER_DB: join(dir, 'user.db') } : env);
    try {
      expect(out).toContain('Moved studio.db to user.db (the Original now comes from studio/default.db).');
      expect(existsSync(join(dir, 'user.db'))).toBe(true);
      expect(existsSync(join(dir, 'studio.db'))).toBe(false);
      const versions = await (await fetch(url + '/api/versions')).json();
      expect(versions.map(v => [v.id, v.example])).toEqual([['original', true], ['space-opera', false]]);
      expect(versions[0]).toMatchObject({ title: "I'm Upping My P(doom)", chapters: 9 });   // default.db's, not the old copy
      expect(versions[1]).toMatchObject({ title: 'Space Opera' });
      const history = await (await fetch(url + '/api/versions/original/history')).json();
      expect(history.length).toBeGreaterThan(0);
      for (const r of history) expect(r.id).toBeGreaterThanOrEqual(EXAMPLE_REVISION_FLOOR);
      const jobs = await (await fetch(url + '/api/jobs')).json();
      expect(jobs).toEqual([expect.objectContaining({ id: jid, kind: 'storyboard', version_id: 'space-opera', status: 'done', cost_usd: 0.42 })]);
    } finally { p.kill(); await p.exited; }
  }
}, { timeout: 60000 });
