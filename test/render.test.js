import { test, expect } from 'bun:test';
import { mkdtempSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const T = { timeout: 300000 };
const run = async (...a) => {
  const p = Bun.spawn(['bun', 'render.mjs', ...a], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

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
