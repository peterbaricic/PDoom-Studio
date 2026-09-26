// test/claude-job.test.js
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../studio/db.js';
import { createClaudeRunner, chapterPath, permissionSettings, checkWithRenderer } from '../studio/claude-job.js';
import { serve } from '../studio/serve.js';
import { createEvents } from '../studio/events.js';
import { CHAPTER_WINDOWS } from '../studio/storyboard.js';
import { goodStoryboard, tempDefaultDb, slowTest } from './helpers.js';

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
  // The documented check command is exactly the form Claude's Bash rule allows.
  expect(brief).toContain(`bun --no-env-file --config=${root}/studio/sandbox.bunfig.toml ${root}/render.mjs --work=${j.id} --base=http://localhost:1 --sheet=`);
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
  expect(logs.join('')).toContain('Reverted changes outside ch/c03.js before the check: ch/c04.js, shared.js');
  expect(db.getVersion('v').status).toBe('chapters');
});

test('the work folder gets a read-only reference/original/ copy of the Original\'s storyboard and chapters', async () => {
  db.createVersion({ id: 'original', title: 'Original' });
  db.writeFiles('original', [
    { path: 'STORYBOARD.md', content: '# original storyboard' },
    { path: 'ch/c01_lab.js', content: '// original chapter 1' },
    { path: 'walkthrough.json', content: '[]' },
  ], { source: 'import' });
  const j = job('chapter', { chapter: 3 });
  let seen;
  await runner([{ files: { 'ch/c03.js': '// three' } }], async () => {
    const dir = join(data, '.studio/work', String(j.id));
    seen = {
      storyboard: readFileSync(join(dir, 'reference/original/STORYBOARD.md'), 'utf8'),
      ch1: readFileSync(join(dir, 'reference/original/ch/c01_lab.js'), 'utf8'),
      walkthrough: existsSync(join(dir, 'reference/original/walkthrough.json')),
    };
    return [];
  })(j, ctx());
  expect(seen).toEqual({ storyboard: '# original storyboard', ch1: '// original chapter 1', walkthrough: false });
});

test('no reference/ folder is written when there is no Original version', async () => {
  const j = job('chapter', { chapter: 1 });
  let hadReference;
  await runner([{ files: { 'ch/c01.js': '// one' } }], async () => {
    hadReference = existsSync(join(data, '.studio/work', String(j.id), 'reference'));
    return [];
  })(j, ctx());
  expect(hadReference).toBe(false);
});

test('editing a reference file leaves no trace: not reverted, not logged, not imported', async () => {
  db.createVersion({ id: 'original', title: 'Original' });
  db.writeFiles('original', [{ path: 'ch/c01_lab.js', content: '// original chapter 1' }], { source: 'import' });
  const j = job('chapter', { chapter: 3 });
  await runner([{ files: { 'ch/c03.js': '// three', 'reference/original/ch/c01_lab.js': '// sneaky edit' } }])(j, ctx());
  expect(db.getFile('v', 'ch/c03.js').content).toBe('// three');
  expect(db.listFiles('v').some(f => f.path.includes('reference'))).toBe(false);
  // The reference/ edit is invisible to readWorkFiles, so it's never a candidate for reverting or importing: it
  // doesn't show up in the "Reverted changes outside ..." line (unlike ch/c04.js or shared.js in the test above).
  expect(logs.join('')).not.toContain('Reverted changes');
});

test('the check sees exactly what will be imported: other files are put back first', async () => {
  db.writeFiles('v', [{ path: 'shared.js', content: 'const SET = { real: 1 };' }, { path: 'ch/c01.js', content: '// one' }], { source: 'manual' });
  const j = job('chapter', { chapter: 3 }), dir = join(data, '.studio/work', String(j.id)), seen = [];
  const validate = async () => {
    seen.push({ shared: readFileSync(join(dir, 'shared.js'), 'utf8'), c01: existsSync(join(dir, 'ch/c01.js')) && readFileSync(join(dir, 'ch/c01.js'), 'utf8'),
      c05: existsSync(join(dir, 'ch/c05.js')), c03: readFileSync(join(dir, 'ch/c03.js'), 'utf8') });
    return seen.length === 1 ? ['SET.oven is not a function'] : [];
  };
  // Both attempts also rewrite shared.js, delete chapter 1 and add a chapter 5 of their own.
  const sneaky = { 'shared.js': 'const SET = { oven() {} };', 'ch/c05.js': '// five' };
  await runner([{ files: { ...sneaky, 'ch/c03.js': '// three' }, remove: ['ch/c01.js'] }, { files: { ...sneaky, 'ch/c03.js': '// three, fixed' }, remove: ['ch/c01.js'] }], validate)(j, ctx());
  const original = { shared: 'const SET = { real: 1 };', c01: '// one', c05: false };
  expect(seen).toEqual([{ ...original, c03: '// three' }, { ...original, c03: '// three, fixed' }]);
  expect(db.getFile('v', 'ch/c03.js').content).toBe('// three, fixed');
  expect(db.getFile('v', 'shared.js').content).toBe('const SET = { real: 1 };');
  expect(logs.join('')).toContain('Reverted changes outside ch/c03.js before the check: ch/c01.js, ch/c05.js, shared.js');
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

test("a failed attempt's cost counts too", async () => {
  const j = job('chapter', { chapter: 1 });
  await expect(runner([{ files: { 'ch/c01.js': 'broken' }, cost: .1 }, { isError: true, result: 'Overloaded', exit: 1, cost: .25 }],
    async () => ['still broken'])(j, ctx())).rejects.toThrow('Overloaded');
  expect(costs.at(-1)).toBeCloseTo(.35);
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
  expect(s.permissions.allow).toEqual(['Read(//p/**)', 'Glob', 'Grep', 'Edit(//p/.studio/work/7/**)', 'Write(//p/.studio/work/7/**)',
    'Bash(bun --no-env-file --config=/p/studio/sandbox.bunfig.toml /p/render.mjs --work=7 *)']);
  expect(s.permissions.deny).toEqual(['WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit',
    'Edit(//p/.studio/work/7/.claude/**)', 'Write(//p/.studio/work/7/.claude/**)',
    'Edit(//p/.studio/work/7/**/bunfig.toml)', 'Write(//p/.studio/work/7/**/bunfig.toml)',
    'Edit(//p/.studio/work/7/**/.env*)', 'Write(//p/.studio/work/7/**/.env*)']);
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

test('a job on an example is refused before any work folder or Claude run', async () => {
  // e.g. a job queued (or retried) on a version that has since been promoted: it must never spend money on Claude
  // only to fail at the import.
  db = openDb(':memory:', { defaultPath: tempDefaultDb() });
  const log = join(mkdtempSync(join(tmpdir(), 'fc-')), 'argv.jsonl');
  for (const [kind, params] of [['storyboard', {}], ['shared', {}], ['chapter', { chapter: 1 }]]) {
    const j = db.getJob(db.addJob({ kind, versionId: 'original', params }));
    await expect(runner([{ files: { 'STORYBOARD.md': goodStoryboard() } }], async () => [], { env: { FAKE_CLAUDE_LOG: log } })(j, ctx()))
      .rejects.toThrow('examples are read-only — remix it first');
  }
  expect(existsSync(log)).toBe(false);
  expect(existsSync(join(data, '.studio')) ? readdirSync(join(data, '.studio'), { recursive: true }) : []).toEqual([]);
  expect(costs).toEqual([]);
});

// (Real seconds: skipped by test:fast with the Chrome tests.)
slowTest('a cancelled job\'s process gets more than render.mjs\'s own 5 s to wind down before it is killed', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'term-')), 'wound-down');
  const ctrl = new AbortController();
  const p = runner([{ sleep: 60000, termGraceMs: 6000, termMarker: marker }])(job('storyboard'), ctx(ctrl.signal));
  await Bun.sleep(500);
  ctrl.abort();
  await expect(p).rejects.toThrow('cancelled');
  expect(existsSync(marker)).toBe(true);   // it finished its 6 s of cleanup: no SIGKILL at 5 s
}, 30000);

test('an already-cancelled signal fails fast without running the CLI', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const p = runner([{ files: { 'STORYBOARD.md': goodStoryboard() } }])(job('storyboard'), ctx(ctrl.signal));
  await expect(p).rejects.toThrow('cancelled');
  expect(db.getFile('v', 'STORYBOARD.md')).toBeNull();
});

// The studio's own check, for real (the runner tests above stand a function in for it; test/ui.test.js's chapter jobs
// skip it, see STUDIO_TEST_SKIP_CHECK there): render.mjs on the job's work folder through the studio server, at three
// times inside the chapter's window, writing the chapter's thumbnail; a failure comes back as the check's own lines.
slowTest('checkWithRenderer checks a chapter job at three times in its window and writes its thumbnail, or returns the errors', async () => {
  const srv = serve({ db, root, data, token: 't', events: createEvents(), port: 0 });
  const workFolder = (jobId, files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(data, '.studio/work', String(jobId), 'ch'), { recursive: true });
      writeFileSync(join(data, '.studio/work', String(jobId), path), content);
    }
  };
  const [a, b] = CHAPTER_WINDOWS[1];
  const good = job('chapter', { chapter: 2 }), bad = job('chapter', { chapter: 2 }), uncovered = job('chapter', { chapter: 2 }), shared = job('shared');
  const overruns = job('chapter', { chapter: 2 }), neighbour = job('chapter', { chapter: 3 }), sharedDraws = job('shared');
  workFolder(good.id, { 'ch/c02.js': `chapter('c2', ${a}, ${b}, [[${a}, t => paint(rectPts(0, 0, W, H), { wash: PAL.sky, ink: null })]]);` });
  workFolder(bad.id, { 'ch/c02.js': `chapter('c2', ${a}, ${b}, [[${a}, t => { throw new Error('chapter two paints nothing'); }]]);` });
  workFolder(uncovered.id, { 'ch/c02.js': `chapter('c2', ${a}, ${a + 1}, [[${a}, t => paint(rectPts(0, 0, W, H), { wash: PAL.sky, ink: null })]]);` });
  workFolder(shared.id, { 'shared.js': "throw new Error('shared.js does not load');" });
  // chapter 2 reaching 1.5 s into chapter 3's window (and so painting frames the cache keys under chapter 3)
  workFolder(overruns.id, { 'ch/c02.js': `chapter('c2', ${a}, ${b + 1.5}, [[${a}, t => paint(rectPts(0, 0, W, H), { wash: PAL.sky, ink: null })]]);` });
  // chapter 3's job on a version whose chapter 2 overruns: not chapter 3's business (nor Claude's to fix there); and a
  // shared.js that registers a chapter of its own (allowed: shared.js is part of every segment key)
  const [c, d] = CHAPTER_WINDOWS[2];
  workFolder(neighbour.id, {
    'ch/c02.js': `chapter('c2', ${a}, ${b + 1.5}, [[${a}, t => paint(rectPts(0, 0, W, H), { wash: PAL.rose, ink: null })]]);`,
    'ch/c03.js': `chapter('c3', ${c}, ${d}, [[${c}, t => paint(rectPts(0, 0, W, H), { wash: PAL.sky, ink: null })]]);`,
  });
  workFolder(sharedDraws.id, { 'shared.js': `chapter('s', 0, 5, [[0, t => paint(rectPts(0, 0, W, H), { wash: PAL.sky, ink: null })]]);` });
  const check = (j, extra = {}) => checkWithRenderer({ root, data, baseUrl: srv.url, jobId: j.id, kind: j.kind, versionId: 'v', chapter: j.params?.chapter, ...extra });
  const thumb = join(data, '.studio/thumbs/v/c02.jpg');
  try {
    const [passed, threw, notCovered, notLoaded, overran, besideOverrun, sharedRegisters] = await Promise.all(
      [check(good), check(bad), check(uncovered), check(shared), check(overruns), check(neighbour), check(sharedDraws)]);
    expect(passed).toEqual([]);
    expect(readFileSync(thumb).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));   // a JPEG
    expect(threw.join('\n')).toContain('chapter two paints nothing');
    expect(threw).not.toContain('CHECK FAILED');
    // the three times are 0.3 s inside each end and the middle: a chapter ending early leaves the last two uncovered
    expect(notCovered).toEqual([(a + b) / 2, b - .3].map(t => `no chapter covers t=${+t.toFixed(2)}`));
    expect(notLoaded.join('\n')).toContain('shared.js does not load');
    expect(overran).toEqual([`ch/c02.js: chapter('c2', ${a}, ${b + 1.5}) reaches outside chapter 2's window (${a}–${b} s)`]);
    expect(besideOverrun).toEqual([]);
    expect(sharedRegisters).toEqual([]);
    // cancelled, the check stops and says so
    const ctrl = new AbortController();
    const cancelled = check(good, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 200);
    await expect(cancelled).rejects.toThrow('cancelled');
  } finally { srv.stop(); }
}, 120000);

// The runner as the studio makes it, with its own check (checkWithRenderer, no validate given): Claude's first chapter
// throws when painted, the check says so, Claude is asked for a fix once, and the fixed chapter is what's imported.
slowTest('with the real check, a chapter that fails it goes back to Claude once, and the fix is imported', async () => {
  const srv = serve({ db, root, data, token: 't', events: createEvents(), port: 0 });
  const log = join(mkdtempSync(join(tmpdir(), 'fc-')), 'argv.jsonl');
  const [a, b] = CHAPTER_WINDOWS[1];
  const broken = `chapter('c2', ${a}, ${b}, [[${a}, t => { throw new Error('the first draft paints nothing'); }]]);`;
  const fixed = `chapter('c2', ${a}, ${b}, [[${a}, t => paint(rectPts(0, 0, W, H), { wash: PAL.sky, ink: null })]]);`;
  try {
    const run = createClaudeRunner({ db, root, data, baseUrl: srv.url, claudeCmd: ['bun', join(root, 'test/fake-claude.js')],
      env: { FAKE_CLAUDE_PLAN: JSON.stringify({ runs: [{ files: { 'ch/c02.js': broken } }, { files: { 'ch/c02.js': fixed } }] }), FAKE_CLAUDE_LOG: log } });
    await run(job('chapter', { chapter: 2 }), ctx());
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(logs.join('')).toContain('The check failed, asking Claude for a fix');
    expect(logs.join('')).toContain('the first draft paints nothing');
    expect(db.getFile('v', 'ch/c02.js').content).toBe(fixed);
    expect(readFileSync(join(data, '.studio/thumbs/v/c02.jpg')).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  } finally { srv.stop(); }
}, 120000);
