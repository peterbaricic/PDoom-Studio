// test/claude-job.test.js
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../studio/db.js';
import { createClaudeRunner, chapterPath, permissionSettings } from '../studio/claude-job.js';
import { goodStoryboard } from './helpers.js';

// root is the real repo (the fake CLI script, the brief's paths); data is a throwaway data root for the runner's
// .studio/work and .studio/settings folders, so a runner test can never touch, let alone delete, a real studio
// job's work folder.
const root = process.cwd();
let db, logs, costs, data;
const ctx = (signal = new AbortController().signal) => ({ signal, log: t => logs.push(t), progress: () => {}, cost: c => costs.push(c) });
const runner = (runs, validate = async () => [], extra = {}) => createClaudeRunner({
  db, root, data, baseUrl: 'http://localhost:1', claudeCmd: ['bun', join(root, 'test/fake-claude.js')],
  validate, ...extra, env: { FAKE_CLAUDE_PLAN: JSON.stringify({ runs }), ...extra.env },
});
const job = (kind, params = {}, model = null) => db.getJob(db.addJob({ kind, versionId: 'v', params, model }));

beforeEach(() => {
  db = openDb(':memory:'); logs = []; costs = [];
  data = mkdtempSync(join(tmpdir(), 'studio-data-'));
  db.createVersion({ id: 'v', concept: 'A cooking show where Clawd is dough that rises.' });
});

afterEach(() => { rmSync(data, { recursive: true, force: true }); });

test('a storyboard job writes the brief, imports the storyboard and updates the version', async () => {
  const j = job('storyboard', {}, 'opus');
  await runner([{ files: { 'STORYBOARD.md': goodStoryboard() }, cost: .42 }])(j, ctx());
  expect(db.getFile('v', 'STORYBOARD.md').content).toBe(goodStoryboard());
  expect(db.getVersion('v')).toMatchObject({ title: 'The P(doom) Bake-Off', status: 'storyboard' });
  expect(db.history('v', 'STORYBOARD.md')[0]).toMatchObject({ source: 'claude', job_id: j.id });
  expect(costs.at(-1)).toBe(.42);
  expect(existsSync(join(data, '.studio/work', String(j.id)))).toBe(false);
});

test('the brief and the CLI arguments', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'fc-')), 'argv.jsonl');
  const j = job('chapter', { chapter: 3, feedback: 'make the oven bigger' }, 'sonnet');
  let brief = '';
  await runner([{ files: { 'ch/c03.js': "chapter('c3', 38.5, 59, []);" } }], async () => {
    brief = readFileSync(join(data, '.studio/work', String(j.id), 'TASK.md'), 'utf8'); return [];
  }, { env: { FAKE_CLAUDE_LOG: log } })(j, ctx());
  expect(brief).toContain('ch/c03.js');
  expect(brief).toContain('38.5–59');
  expect(brief).toContain('make the oven bigger');
  const argv = JSON.parse(readFileSync(log, 'utf8').trim());
  expect(argv).toContain('--permission-mode'); expect(argv).toContain('dontAsk');
  expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', 'sonnet']);
  expect(argv.slice(argv.indexOf('--add-dir'), argv.indexOf('--add-dir') + 2)).toEqual(['--add-dir', root]);
  expect(argv).toContain('--strict-mcp-config');
});

test('a chapter job imports only its own file', async () => {
  const j = job('chapter', { chapter: 3 });
  await runner([{ files: { 'ch/c03.js': '// three', 'ch/c04.js': '// sneaky', 'shared.js': '// sneaky' } }])(j, ctx());
  expect(db.getFile('v', 'ch/c03.js').content).toBe('// three');
  expect(db.getFile('v', 'ch/c04.js')).toBeNull();
  expect(db.getFile('v', 'shared.js')).toBeNull();
  expect(logs.join('')).toContain('Ignored changes outside ch/c03.js: ch/c04.js, shared.js');
  expect(db.getVersion('v').status).toBe('chapters');
});

test('validation errors get one fix attempt', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'fc-')), 'argv.jsonl');
  const j = job('chapter', { chapter: 1 });
  let calls = 0;
  await runner([{ files: { 'ch/c01.js': 'broken' } }, { files: { 'ch/c01.js': 'fixed' } }],
    async () => ++calls === 1 ? ['ReferenceError: oven is not defined'] : [], { env: { FAKE_CLAUDE_LOG: log } })(j, ctx());
  expect(db.getFile('v', 'ch/c01.js').content).toBe('fixed');
  const prompts = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)[1]);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain('ReferenceError: oven is not defined');
});

test('a second validation failure fails the job and keeps the work folder', async () => {
  const j = job('chapter', { chapter: 1 });
  await expect(runner([{ files: { 'ch/c01.js': 'broken' } }], async () => ['still broken'])(j, ctx())).rejects.toThrow('validation failed: still broken');
  expect(db.getFile('v', 'ch/c01.js')).toBeNull();
  expect(existsSync(join(data, '.studio/work', String(j.id)))).toBe(true);
});

test('an invalid storyboard is sent back for a fix', async () => {
  const j = job('storyboard');
  await runner([{ files: { 'STORYBOARD.md': 'no front matter' } }, { files: { 'STORYBOARD.md': goodStoryboard() } }])(j, ctx());
  expect(db.getFile('v', 'STORYBOARD.md').content).toBe(goodStoryboard());
});

test('a CLI error fails the job with its message', async () => {
  await expect(runner([{ isError: true, result: 'Not logged in', exit: 1 }])(job('storyboard'), ctx())).rejects.toThrow('Not logged in');
});

test('cancelling kills the CLI', async () => {
  const ctrl = new AbortController(), started = Date.now();
  const p = runner([{ sleep: 10000 }])(job('storyboard'), ctx(ctrl.signal));
  setTimeout(() => ctrl.abort(), 300);
  await expect(p).rejects.toThrow('cancelled');
  expect(Date.now() - started).toBeLessThan(5000);
});

test('chapter files keep existing names, and permissions stay in the work folder', () => {
  db.writeFiles('v', [{ path: 'ch/c01_lab.js', content: '' }], { source: 'import' });
  expect(chapterPath(db, 'v', 1)).toBe('ch/c01_lab.js');
  expect(chapterPath(db, 'v', 2)).toBe('ch/c02.js');
  const s = permissionSettings({ root: '/p', jobId: 7, dir: '/p/.studio/work/7' });
  expect(s.permissions.allow).toEqual(['Read(//p/**)', 'Glob', 'Grep', 'Edit(//p/.studio/work/7/**)', 'Write(//p/.studio/work/7/**)', 'Bash(bun /p/render.mjs --work=7 *)']);
  expect(s.permissions.deny).toEqual(['WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit', 'Edit(//p/.studio/work/7/.claude/**)', 'Write(//p/.studio/work/7/.claude/**)']);
});

test('cancelling during a slow check throws and imports nothing', async () => {
  const ctrl = new AbortController();
  const j = job('chapter', { chapter: 1 });
  const validate = async () => { await new Promise(r => setTimeout(r, 500)); return []; };
  const p = runner([{ files: { 'ch/c01.js': 'ok' } }], validate)(j, ctx(ctrl.signal));
  setTimeout(() => ctrl.abort(), 100);
  await expect(p).rejects.toThrow('cancelled');
  expect(db.getFile('v', 'ch/c01.js')).toBeNull();
});

test('an already-cancelled signal fails fast without running the CLI', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const p = runner([{ files: { 'STORYBOARD.md': goodStoryboard() } }])(job('storyboard'), ctx(ctrl.signal));
  await expect(p).rejects.toThrow('cancelled');
  expect(db.getFile('v', 'STORYBOARD.md')).toBeNull();
});
