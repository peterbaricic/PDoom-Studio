import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../studio/db.js';

async function start(dbPath) {
  const p = Bun.spawn(['bun', 'studio/server.js', '--port=0'], { env: { ...process.env, STUDIO_DB: dbPath }, stdout: 'pipe' });
  const reader = p.stdout.getReader(), dec = new TextDecoder();
  let out = '';
  while (!/Studio: (http:\/\/localhost:\d+)\//.test(out)) out += dec.decode((await reader.read()).value);
  return { p, out, url: /Studio: (http:\/\/localhost:\d+)\//.exec(out)[1] };
}

test('starts, imports the original and marks unfinished jobs as interrupted', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'srv-')), 'studio.db');
  const db = openDb(dbPath);
  db.createVersion({ id: 'x' });
  const jid = db.addJob({ kind: 'chapter', versionId: 'x', params: { chapter: 1 } });
  db.updateJob(jid, { status: 'running' });
  db.close();

  const { p, out, url } = await start(dbPath);
  try {
    expect(out).toContain('1 unfinished job marked as interrupted');
    const page = await (await fetch(url + '/')).text();
    expect(page).toMatch(/name="studio-token" content="[0-9a-f]{48}"/);
    const versions = await (await fetch(url + '/api/versions')).json();
    expect(versions.map(v => v.id)).toContain('original');
    const job = (await (await fetch(url + '/api/jobs')).json()).find(j => j.id === jid);
    expect(job.status).toBe('interrupted');
  } finally { p.kill(); }
}, { timeout: 30000 });
