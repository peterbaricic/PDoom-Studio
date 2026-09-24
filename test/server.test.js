import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../studio/db.js';
import { isolatedEnv, tempDefaultDb } from './helpers.js';

const defaultDbPath = tempDefaultDb();   // once per file: a private copy, never written by these tests
const envFor = (userPath, extra = {}) => isolatedEnv(undefined, { USER_DB: userPath, DEFAULT_DB: defaultDbPath, ...extra });
async function start(userPath, extra = {}) {
  const p = Bun.spawn(['bun', 'studio/server.js', '--port=0'], { env: envFor(userPath, extra), stdout: 'pipe' });
  const reader = p.stdout.getReader(), dec = new TextDecoder();
  let out = '';
  while (!/Studio: (http:\/\/localhost:\d+)\//.test(out)) out += dec.decode((await reader.read()).value);
  return { p, out, url: /Studio: (http:\/\/localhost:\d+)\//.exec(out)[1] };
}

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
