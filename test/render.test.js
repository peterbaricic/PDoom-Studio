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
