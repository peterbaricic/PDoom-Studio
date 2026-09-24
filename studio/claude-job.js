// claude-job.js: storyboard, shared-setup and chapter jobs. Each runs Claude Code headless in a throwaway work folder
// that holds the version's current files and a TASK.md brief; Claude may only write there. The result is checked,
// sent back once for a fix if it fails, and imported as a new revision of the job's one target file.
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readWorkFiles } from './versions.js';
import { parseStoryboard, CHAPTER_WINDOWS } from './storyboard.js';
import { taskBrief } from './prompts.js';

export function chapterPath(db, versionId, n) {
  const re = new RegExp(`^ch/c0${n}(_[a-z0-9_]+)?\\.js$`);
  return db.listFiles(versionId).find(f => re.test(f.path))?.path ?? `ch/c0${n}.js`;
}

// Claude Code runs with --permission-mode dontAsk, so only what's allowed here can happen: reading the project,
// writing in the work folder (its working directory), and rendering contact sheets of this job's work folder.
// Claude may not touch .claude/ in its own work folder either, so it can't plant settings for its own fix attempt.
export function permissionSettings({ root, jobId }) {
  return { permissions: {
    allow: [`Read(/${root}/**)`, 'Glob', 'Grep', 'Edit(./**)', 'Write(./**)', `Bash(bun ${root}/render.mjs --work=${jobId} *)`],
    deny: ['WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit', 'Edit(./.claude/**)', 'Write(./.claude/**)'],
  } };
}

export async function checkWithRenderer({ root, baseUrl, jobId, kind, versionId, chapter, signal }) {
  let times = 'load', thumb = null;
  if (kind === 'chapter') {
    const [a, b] = CHAPTER_WINDOWS[chapter - 1];
    times = [a + .3, (a + b) / 2, b - .3].map(t => t.toFixed(2)).join(',');
    thumb = join(root, '.studio/thumbs', versionId, `c0${chapter}.jpg`);
  }
  const argv = ['bun', join(root, 'render.mjs'), `--work=${jobId}`, `--check=${times}`, ...(baseUrl ? [`--base=${baseUrl}`] : []),
    ...(thumb ? [`--out=${thumb}`, '--cols=3', '--w=320'] : [])];
  const p = Bun.spawn(argv, { cwd: root, stdout: 'ignore', stderr: 'pipe' });
  const kill = () => p.kill();
  signal?.addEventListener('abort', kill);
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  signal?.removeEventListener('abort', kill);
  if (signal?.aborted) throw new Error('cancelled');
  return code === 0 ? [] : err.split('\n').map(l => l.trim()).filter(l => l && l !== 'CHECK FAILED').slice(0, 20);
}

const short = input => JSON.stringify(input ?? {}).slice(0, 160);

async function runClaude({ cmd, prompt, dir, settings, root, model, env, ctx, timeoutMs }) {
  if (ctx.signal.aborted) throw new Error('cancelled');
  const argv = [...cmd, '-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
    '--settings', settings, '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence',
    '--add-dir', root, ...(model ? ['--model', model] : [])];
  // STUDIO_SANDBOX lets render.mjs restrict itself when Claude's own Bash tool runs it (see render.mjs); this is
  // the job's work folder, not the project root, so a render call can only touch this job's own files.
  const proc = Bun.spawn(argv, { cwd: dir, env: { ...process.env, ...env, STUDIO_SANDBOX: dir }, stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false, escalateTimer = null;
  const kill = () => {
    proc.kill();
    escalateTimer = setTimeout(() => { if (proc.exitCode === null) proc.kill(9); }, 5000);
  };
  ctx.signal.addEventListener('abort', kill);
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  const stderr = new Response(proc.stderr).text();
  let result = null, tools = 0, buf = '';
  const dec = new TextDecoder();
  const handle = line => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'assistant') for (const c of m.message?.content || []) {
      if (c.type === 'text' && c.text.trim()) ctx.log(c.text.trim() + '\n');
      if (c.type === 'tool_use') { tools++; ctx.log(`→ ${c.name} ${short(c.input)}\n`); ctx.progress(Math.min(.9, tools / 40)); }
    }
    if (m.type === 'result') result = m;
  };
  for await (const chunk of proc.stdout) {
    buf += dec.decode(chunk, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  if (buf.trim()) handle(buf);
  const code = await proc.exited;
  clearTimeout(timer); if (escalateTimer) clearTimeout(escalateTimer);
  ctx.signal.removeEventListener('abort', kill);
  if (ctx.signal.aborted) throw new Error('cancelled');
  if (timedOut) throw new Error(`Claude did not finish within ${Math.round(timeoutMs / 60000)} minutes`);
  if (code !== 0 || !result || result.is_error) {
    const tail = (await stderr).trim().split('\n').slice(-3).join(' ');
    throw new Error(result?.result || tail || `claude exited with code ${code}`);
  }
  return { cost: result.total_cost_usd || 0 };
}

export function createClaudeRunner({ db, root, baseUrl, events = null, claudeCmd = (process.env.CLAUDE_BIN || 'claude').split(' '),
  env = {}, validate = checkWithRenderer, timeoutMs = 30 * 60 * 1000 }) {
  return async (job, ctx) => {
    const { kind, version_id: vid, params } = job, version = db.getVersion(vid);
    const dir = join(root, '.studio/work', String(job.id)), settings = join(root, '.studio/settings', `${job.id}.json`);
    const target = kind === 'storyboard' ? 'STORYBOARD.md' : kind === 'shared' ? 'shared.js' : chapterPath(db, vid, params.chapter);

    // The work folder: the version's current files, plus the brief.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'ch'), { recursive: true });
    const before = new Map();
    for (const f of db.listFiles(vid)) {
      const content = db.getFile(vid, f.path).content;
      before.set(f.path, content);
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), content);
    }
    writeFileSync(join(dir, 'TASK.md'), taskBrief({ kind, version, params, target, root, jobId: job.id, baseUrl, exists: before.has(target) }));
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify(permissionSettings({ root, jobId: job.id }), null, 2));

    let spent = 0;
    const attempt = async prompt => {
      // A previous attempt could have planted its own .claude/settings.json; remove it before every attempt so a
      // fix attempt can't load permissions Claude wrote for itself (--setting-sources project reads the cwd).
      rmSync(join(dir, '.claude'), { recursive: true, force: true });
      const r = await runClaude({ cmd: claudeCmd, prompt, dir, settings, root, model: job.model, env, ctx, timeoutMs });
      spent += r.cost; ctx.cost(spent);
    };
    const check = async () => {
      const file = join(dir, target);
      if (!existsSync(file)) return [`${target} was not written`];
      if (kind === 'storyboard') return parseStoryboard(readFileSync(file, 'utf8')).errors;
      return validate({ root, baseUrl, jobId: job.id, kind, versionId: vid, chapter: params.chapter, signal: ctx.signal });
    };

    await attempt('Read TASK.md in the current folder and do what it says.');
    let errors = await check();
    if (ctx.signal.aborted) throw new Error('cancelled');
    if (errors.length) {
      ctx.log(`\nThe check failed, asking Claude for a fix:\n${errors.join('\n')}\n`);
      await attempt(`Your work does not pass the studio's check yet:\n${errors.join('\n')}\n\nFix ${target}. TASK.md still applies.`);
      errors = await check();
      if (ctx.signal.aborted) throw new Error('cancelled');
      if (errors.length) throw new Error('validation failed: ' + errors.join('; '));
    }

    const after = readWorkFiles(dir);
    const ignored = [...after.keys()].filter(p => p !== target && after.get(p) !== before.get(p)).sort();
    if (ignored.length) ctx.log(`\nIgnored changes outside ${target}: ${ignored.join(', ')}\n`);
    if (ctx.signal.aborted) throw new Error('cancelled');
    db.writeFiles(vid, [{ path: target, content: after.get(target) }], { source: 'claude', note: params.feedback || `${kind} job`, jobId: job.id });

    if (kind === 'storyboard') {
      const sb = parseStoryboard(after.get(target));
      db.updateVersion(vid, { title: sb.title, logline: sb.logline, ...(version.status === 'concept' ? { status: 'storyboard' } : {}) });
    } else if (kind === 'chapter') {
      const n = db.listFiles(vid).filter(f => f.path.startsWith('ch/')).length;
      db.updateVersion(vid, { status: n >= 9 ? 'ready' : 'chapters' });
    }
    events?.publish('version', { id: vid });
    rmSync(dir, { recursive: true, force: true });
    rmSync(settings, { force: true });
  };
}
