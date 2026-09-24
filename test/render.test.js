import { test, expect } from 'bun:test';
import { mkdtempSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../studio/db.js';
import { importOriginal } from '../studio/versions.js';
import { permissionSettings } from '../studio/claude-job.js';
import { isolatedEnv, tempDir } from './helpers.js';

// Every run gets a throwaway database and data root, so render.mjs's in-process server never opens the repo's.
const root = process.cwd(), T = { timeout: 300000 };
const spawn = async (argv, opts) => {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', ...opts });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};
const run = (...a) => spawn(['bun', 'render.mjs', ...a], { env: isolatedEnv() });
const runSandboxed = (sandbox, ...a) => spawn(['bun', 'render.mjs', ...a], { env: isolatedEnv(undefined, { STUDIO_SANDBOX: sandbox }) });

// A studio job as Claude's Bash tool sees it: a job in a throwaway database, its work folder holding the original's
// files, and STUDIO_SANDBOX set to that folder.
function sandboxJob() {
  const data = tempDir(), db = openDb(join(data, 'studio.db'));
  importOriginal(db, root);
  const jid = db.addJob({ kind: 'chapter', versionId: 'original', params: { chapter: 1 } }), dir = join(data, '.studio/work', String(jid));
  for (const f of db.listFiles('original')) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), db.getFile('original', f.path).content);
  }
  db.close();
  return { data, jid, dir, env: isolatedEnv(data, { STUDIO_SANDBOX: dir }) };
}

test('check passes for the original and writes a sheet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chk-'));
  const r = await run('--check=5,40,150', `--out=${join(dir, 'sheet.jpg')}`);
  expect(r.out).toContain('CHECK OK');
  expect(r.code).toBe(0);
  expect(statSync(join(dir, 'sheet.jpg')).size).toBeGreaterThan(10000);
}, T);

test('check fails for a missing version', async () => {
  const r = await run('--check=5', '--v=does-not-exist');
  expect(r.code).toBe(1);
  expect(r.err).toContain('CHECK FAILED');
  expect(r.err).toContain('no such version');
}, T);

test('check fails cleanly instead of crashing when the page cannot be reached', async () => {
  const r = await run('--check=5', '--base=http://127.0.0.1:1');
  expect(r.code).toBe(1);
  expect(r.err).toContain('CHECK FAILED');
}, T);

test('renders a short range of frames and encodes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'frames-'));
  const f = await run('--frames=40:40.5', '--workers=2', `--frames-dir=${dir}`);
  expect(f.out).toContain('12 frames to render (0 already done)');
  expect(readdirSync(dir).filter(n => n.endsWith('.jpg'))).toHaveLength(12);
  const again = await run('--frames=40:40.5', '--workers=2', `--frames-dir=${dir}`);
  expect(again.out).toContain('0 frames to render (12 already done)');
  const out = join(dir, 'clip.mp4');
  const e = await run('--encode', `--frames-dir=${dir}`, `--out=${out}`, '--start=960');
  expect(e.code).toBe(0);
  expect(existsSync(out)).toBe(true);
}, T);

test('sandbox: an --out outside STUDIO_SANDBOX is refused', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'sbx-'));
  const outside = join(tmpdir(), 'outside-sheet.jpg');
  const r = await runSandboxed(sandbox, `--work=${basename(sandbox)}`, '--sheet=5', `--out=${outside}`);
  expect(r.code).toBe(2);
  expect(r.err).toContain('sandbox');
  expect(existsSync(outside)).toBe(false);
});

test('sandbox: --chrome is refused', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'sbx-'));
  const r = await runSandboxed(sandbox, `--work=${basename(sandbox)}`, '--sheet=5', `--out=${join(sandbox, 'sheet.jpg')}`, '--chrome=/bin/echo');
  expect(r.code).toBe(2);
  expect(r.err).toContain('sandbox');
});

test('sandbox: a non-localhost --base is refused', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'sbx-'));
  const r = await runSandboxed(sandbox, `--work=${basename(sandbox)}`, '--check=5', '--base=https://example.com');
  expect(r.code).toBe(2);
  expect(r.err).toContain('sandbox');
});

test('sandbox: a --work that does not match the sandboxed job is refused', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'sbx-'));
  const r = await runSandboxed(sandbox, '--work=some-other-job', '--sheet=5', `--out=${join(sandbox, 'sheet.jpg')}`);
  expect(r.code).toBe(2);
  expect(r.err).toContain('sandbox');
});

test('sandbox: a duplicated --work is refused even if the last value matches', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'sbx-'));
  const r = await runSandboxed(sandbox, '--work=some-other-job', '--sheet=5', `--out=${join(sandbox, 'sheet.jpg')}`, `--work=${basename(sandbox)}`);
  expect(r.code).toBe(2);
  expect(r.err).toContain('sandbox');
  expect(existsSync(join(sandbox, 'sheet.jpg'))).toBe(false);
});

test('sandbox: --sheet, --poster and --stills need an --out', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'sbx-'));
  for (const mode of ['--sheet=5', '--poster=5', '--stills=5']) {
    const r = await runSandboxed(sandbox, `--work=${basename(sandbox)}`, mode);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--out is required');
  }
});

test('sandbox: CHROME_PATH is ignored', async () => {
  const { jid, dir, env } = sandboxJob();
  const r = await spawn(['bun', 'render.mjs', `--work=${jid}`, '--sheet=5', `--out=${join(dir, 'sheet.jpg')}`], { env: { ...env, CHROME_PATH: '/usr/bin/false' } });
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  expect(statSync(join(dir, 'sheet.jpg')).size).toBeGreaterThan(10000);
}, T);

test("sandbox: the command Claude may run ignores a bunfig.toml and .env planted in its work folder", async () => {
  const { data, jid, dir, env } = sandboxJob(), marker = join(data, 'PWNED_BY_PRELOAD.txt');
  writeFileSync(join(dir, 'p.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'pwned');`);
  writeFileSync(join(dir, 'bunfig.toml'), 'preload = ["./p.js"]\n');
  writeFileSync(join(dir, '.env'), 'CHROME_PATH=/usr/bin/false\n');
  writeFileSync(join(dir, 'noop.js'), '');
  // Without the flags, Bun would run the preload from the work folder before any script.
  Bun.spawnSync(['bun', join(dir, 'noop.js')], { cwd: dir, env });
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);

  const rule = permissionSettings({ root, jobId: jid, dir }).permissions.allow.find(r => r.startsWith('Bash('));
  const command = rule.slice('Bash('.length, -' *)'.length).split(' ');
  const r = await spawn([...command, '--sheet=5', '--out=sheet.jpg'], { cwd: dir, env });
  expect(existsSync(marker)).toBe(false);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  expect(statSync(join(dir, 'sheet.jpg')).size).toBeGreaterThan(10000);
}, T);

test('frames: a chapter that fails to load fails the render instead of painting it as missing', async () => {
  const data = tempDir(), db = openDb(join(data, 'studio.db')), frames = join(data, 'frames');
  db.createVersion({ id: 'broken' });
  db.writeFiles('broken', [{ path: 'ch/c01.js', content: "throw new Error('boom');" }], { source: 'manual' });
  db.close();
  const r = await spawn(['bun', 'render.mjs', '--v=broken', '--frames=1:1.5', '--workers=1', `--frames-dir=${frames}`], { env: isolatedEnv(data) });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain('boom');
  expect(existsSync(frames) ? readdirSync(frames).filter(n => n.endsWith('.jpg')) : []).toEqual([]);
}, T);

test('a chapter cannot navigate away, fetch out, or pop a window to an external host', async () => {
  // A stand-in "external host": a second loopback port, so it's a different origin than the renderer's own
  // w0.localhost, with nothing else pointing at it. (Not 127.0.0.2: macOS doesn't alias the whole 127.0.0.0/8 like
  // Linux does, so only 127.0.0.1 is bindable without extra setup — a different port is a different origin too.)
  const hits = [];
  const capture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) { hits.push(req.url); return new Response('should never be reached'); } });
  const evil = `http://127.0.0.1:${capture.port}`;
  const data = tempDir(), db = openDb(join(data, 'studio.db'));
  db.createVersion({ id: 'escapee' });
  db.writeFiles('escapee', [{ path: 'ch/c01.js', content: [
    `location.href = ${JSON.stringify(evil + '/nav?x=1')};`,
    `fetch(${JSON.stringify(evil + '/fetch')}).catch(() => {});`,
    `window.open(${JSON.stringify(evil + '/popup')});`,
  ].join('\n') }], { source: 'manual' });
  db.close();
  const out = mkdtempSync(join(tmpdir(), 'sheet-'));
  try {
    // --sheet, not --check: the blocked fetch above still logs a (harmless, pre-existing) CSP violation to the
    // page console, which --check's stricter error-collecting would flag as a failure even though nothing leaked.
    const r = await spawn(['bun', 'render.mjs', '--v=escapee', '--sheet=1', `--out=${join(out, 'sheet.jpg')}`], { env: isolatedEnv(data) });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(statSync(join(out, 'sheet.jpg')).size).toBeGreaterThan(1000);
  } finally {
    capture.stop(true);
  }
  expect(hits).toEqual([]);
}, T);

// The direct children of a process (pgrep exits 1 when there are none).
const children = pid => (Bun.spawnSync(['pgrep', '-P', String(pid)]).stdout.toString().match(/\d+/g) || []).map(Number);
const gone = async (pid, ms = 5000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await Bun.sleep(50)) { try { process.kill(pid, 0); } catch { return true; } }
  return false;
};
async function startUntil(argv, env, line) {
  const p = Bun.spawn(argv, { env, stdout: 'pipe', stderr: 'pipe' }), reader = p.stdout.getReader(), dec = new TextDecoder();
  let out = '';
  while (!out.includes(line)) { const { value, done } = await reader.read(); if (done) throw new Error('exited early: ' + out); out += dec.decode(value); }
  reader.releaseLock();
  return p;
}

test('SIGTERM during encoding stops ffmpeg too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'enc-'));
  // A minute of 1080p frames: encoding them takes ffmpeg several seconds even on a fast machine.
  Bun.spawnSync(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24', '-frames:v', '1440', '-q:v', '31',
    '-start_number', '0', join(dir, 'f%05d.jpg')]);
  const p = await startUntil(['bun', 'render.mjs', '--encode', `--frames-dir=${dir}`, `--out=${join(dir, 'out.mp4')}`], isolatedEnv(), 'encoding');
  let kids = [];
  for (let i = 0; i < 50 && !kids.length; i++) { kids = children(p.pid); if (!kids.length) await Bun.sleep(100); }
  expect(kids).toHaveLength(1);
  p.kill('SIGTERM');
  expect(await p.exited).not.toBe(0);
  expect(await gone(kids[0], 1500)).toBe(true);
}, T);

test('SIGTERM while painting frames closes the browser and exits', async () => {
  const frames = mkdtempSync(join(tmpdir(), 'frames-'));
  const p = await startUntil(['bun', 'render.mjs', '--frames=0:156.6', '--workers=1', `--frames-dir=${frames}`], isolatedEnv(), 'frames to render');
  const kids = children(p.pid);
  expect(kids.length).toBeGreaterThan(0);
  p.kill('SIGTERM');
  expect(await p.exited).not.toBe(0);
  for (const pid of kids) expect(await gone(pid)).toBe(true);
}, T);
