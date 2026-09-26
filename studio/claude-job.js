// claude-job.js: storyboard, shared-setup and chapter jobs. Each runs Claude Code headless in a throwaway work folder
// (<data>/.studio/work/<job id>) that holds the version's current files and a TASK.md brief; Claude may only write
// there. The result is checked, sent back once for a fix if it fails, and imported as a new revision of the job's one
// target file. Only the target is imported, so before every check the other version files are put back as they
// were: the check then sees exactly what the version will be.
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readWorkFiles } from './versions.js';
import { parseStoryboard, CHAPTER_WINDOWS } from './storyboard.js';
import { taskBrief, renderCommand } from './prompts.js';
import { PAINTER_SECRET } from './frames/page.js';
import { chapterKey, filesKey, stampThumb, thumbPath } from './thumbs.js';

// Where a chapter job's check paints the chapter's strip: its work folder, not the version's thumbs, so a draft that's
// never imported can't replace a good strip. The runner moves it into place after the import (see createClaudeRunner).
export const workStrip = (data, jobId) => join(data, '.studio/work', String(jobId), 'strip.jpg');

export function chapterPath(db, versionId, n) {
  const re = new RegExp(`^ch/c0${n}(_[a-z0-9_]+)?\\.js$`);
  return db.listFiles(versionId).find(f => re.test(f.path))?.path ?? `ch/c0${n}.js`;
}

// Claude Code runs with --permission-mode dontAsk, so only what's allowed here can happen: reading the project,
// writing in the work folder, and rendering contact sheets of this job's work folder. Rules use absolute paths
// (not './...') because Claude's own Bash tool can `cd` elsewhere during the run, after which a rule relative to
// its *original* working directory would no longer cover the work folder. Claude may not touch .claude/ in its
// own work folder either, so it can't plant settings for its own fix attempt, nor bunfig.toml or .env files, which
// Bun would read from the work folder (the render command ignores them anyway; see renderCommand).
export function permissionSettings({ root, jobId, dir }) {
  const denyFiles = ['.claude/**', '**/bunfig.toml', '**/.env*'].flatMap(p => [`Edit(/${dir}/${p})`, `Write(/${dir}/${p})`]);
  return { permissions: {
    allow: [`Read(/${root}/**)`, 'Glob', 'Grep', `Edit(/${dir}/**)`, `Write(/${dir}/**)`, `Bash(${renderCommand(root, jobId)} *)`],
    deny: ['WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit', ...denyFiles],
  } };
}

// How long a cancelled job's process gets to stop by itself after SIGTERM before it's killed: longer than render.mjs's
// own up to 5 s wait for its browser to close (and Claude's for its own children), so neither is cut off mid-cleanup
// and leaves a browser behind.
export const KILL_AFTER_MS = 8000;

export async function checkWithRenderer({ root, data = root, baseUrl, jobId, kind, versionId, chapter, signal }) {
  let times = 'load', thumb = null;
  if (kind === 'chapter') {
    const [a, b] = CHAPTER_WINDOWS[chapter - 1];
    times = [a + .3, (a + b) / 2, b - .3].map(t => t.toFixed(2)).join(',');
    thumb = workStrip(data, jobId);
  }
  // --target: only the job's own file is held to the chapter-window rule (another file's mistakes aren't Claude's to fix)
  const argv = ['bun', join(root, 'render.mjs'), `--work=${jobId}`, `--check=${times}`, `--target=${kind === 'chapter' ? chapter : 'shared'}`,
    ...(baseUrl ? [`--base=${baseUrl}`] : []),
    ...(thumb ? [`--out=${thumb}`, '--cols=3', '--w=320'] : [])];
  // (--base: through this studio, whose painter secret it needs; see studio/frames/page.js)
  const p = Bun.spawn(argv, { cwd: root, env: { ...process.env, STUDIO_PAINTER_SECRET: PAINTER_SECRET }, stdout: 'ignore', stderr: 'pipe' });
  let escalateTimer = null;
  const kill = () => {
    p.kill();
    escalateTimer = setTimeout(() => { if (p.exitCode === null) p.kill(9); }, KILL_AFTER_MS);
  };
  signal?.addEventListener('abort', kill);
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (escalateTimer) clearTimeout(escalateTimer);
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
  // the job's work folder, not the project root, so a render call can only touch this job's own files. Its render
  // calls paint through this studio (--base), so they get its painter secret (studio/frames/page.js).
  const proc = Bun.spawn(argv, { cwd: dir, env: { ...process.env, ...env, STUDIO_SANDBOX: dir, STUDIO_PAINTER_SECRET: PAINTER_SECRET }, stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false, escalateTimer = null;
  const kill = () => {
    proc.kill();
    escalateTimer = setTimeout(() => { if (proc.exitCode === null) proc.kill(9); }, KILL_AFTER_MS);
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
  // A failed run can still have cost something: the error carries it, so the job's cost includes it.
  const cost = result?.total_cost_usd || 0, fail = message => Object.assign(new Error(message), { cost });
  if (ctx.signal.aborted) throw fail('cancelled');
  if (timedOut) throw fail(`Claude did not finish within ${Math.round(timeoutMs / 60000)} minutes`);
  if (code !== 0 || !result || result.is_error) {
    const tail = (await stderr).trim().split('\n').slice(-3).join(' ');
    throw fail(result?.result || tail || `claude exited with code ${code}`);
  }
  return { cost };
}

// dev: the server's --dev (the engine hash is checked afresh on every use, as the frame service does).
export function createClaudeRunner({ db, root, data = root, baseUrl, events = null, claudeCmd = (process.env.CLAUDE_BIN || 'claude').split(' '),
  env = {}, validate = checkWithRenderer, timeoutMs = 30 * 60 * 1000, dev = false }) {
  return async (job, ctx) => {
    const { kind, version_id: vid, params } = job, version = db.getVersion(vid);
    // The API refuses these jobs for examples, but one queued (or retried) before its version was promoted still
    // reaches here: refuse it before making a work folder or spending anything on Claude, not at the import.
    if (version?.example) throw new Error('examples are read-only — remix it first');
    const dir = join(data, '.studio/work', String(job.id)), settings = join(data, '.studio/settings', `${job.id}.json`);
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
    // reference/original/: a read-only copy of the Original's STORYBOARD.md and chapters, for quality and detail.
    // readWorkFiles never looks inside reference/, so nothing written there can be reverted, checked or imported.
    // Skipped silently if no "original" version exists yet, wherever it lives (default.db or user.db).
    const original = db.getVersion('original');
    if (original) for (const f of db.listFiles('original')) {
      if (f.path !== 'STORYBOARD.md' && !f.path.startsWith('ch/')) continue;
      const dest = join(dir, 'reference/original', f.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, db.getFile('original', f.path).content);
    }
    writeFileSync(join(dir, 'TASK.md'), taskBrief({ kind, version, params, target, root, jobId: job.id, baseUrl, exists: before.has(target) }));
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify(permissionSettings({ root, jobId: job.id, dir }), null, 2));

    let spent = 0, checkedKey = null;
    const attempt = async prompt => {
      // A previous attempt could have planted its own .claude/settings.json; remove it before every attempt so a
      // fix attempt can't load permissions Claude wrote for itself (--setting-sources project reads the cwd).
      rmSync(join(dir, '.claude'), { recursive: true, force: true });
      try { spent += (await runClaude({ cmd: claudeCmd, prompt, dir, settings, root, model: job.model, env, ctx, timeoutMs })).cost; }
      catch (e) { spent += e.cost || 0; throw e; }
      finally { ctx.cost(spent); }
    };
    const revertOthers = () => {
      const now = readWorkFiles(dir), reverted = [];
      for (const [p, content] of now) {
        if (p === target || content === before.get(p)) continue;
        if (before.has(p)) writeFileSync(join(dir, p), before.get(p)); else rmSync(join(dir, p));
        reverted.push(p);
      }
      for (const [p, content] of before) {
        if (p === target || now.has(p)) continue;
        mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), content);
        reverted.push(p);
      }
      if (reverted.length) ctx.log(`\nReverted changes outside ${target} before the check: ${reverted.sort().join(', ')}\n`);
    };
    const check = async () => {
      revertOthers();
      const file = join(dir, target);
      if (!existsSync(file)) return [`${target} was not written`];
      if (kind === 'storyboard') return parseStoryboard(readFileSync(file, 'utf8')).errors;
      if (kind === 'chapter') {
        // What this check paints the chapter under: the job-start files plus the draft (revertOthers put the rest
        // back), with the version's options. Its strip is painted afresh, never left over from Claude or a check before.
        rmSync(workStrip(data, job.id), { force: true });
        checkedKey = filesKey(readWorkFiles(dir), db.getVersion(vid)?.options, root, params.chapter, { dev });
      }
      return validate({ root, data, baseUrl, jobId: job.id, kind, versionId: vid, chapter: params.chapter, signal: ctx.signal });
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

    const result = readFileSync(join(dir, target), 'utf8');
    if (ctx.signal.aborted) throw new Error('cancelled');
    db.writeFiles(vid, [{ path: target, content: result }], { source: 'claude', note: params.feedback || `${kind} job`, jobId: job.id });

    if (kind === 'storyboard') {
      const sb = parseStoryboard(result);
      db.updateVersion(vid, { title: sb.title, logline: sb.logline, ...(version.status === 'concept' ? { status: 'storyboard' } : {}) });
    } else if (kind === 'chapter') {
      const n = db.listFiles(vid).filter(f => f.path.startsWith('ch/')).length;
      db.updateVersion(vid, { status: n >= 9 ? 'ready' : 'chapters' });
      // The check's strip becomes the chapter's only if the chapter is still exactly what the check painted (a
      // shared.js or options change meanwhile would make it another picture); the strip on disk until then (a thumbs
      // job's, say, which runs beside Claude's jobs) keeps its own stamp.
      const strip = workStrip(data, job.id);
      if (existsSync(strip) && checkedKey && checkedKey === chapterKey(db, root, vid, params.chapter, { dev })) {
        mkdirSync(dirname(thumbPath(data, vid, params.chapter)), { recursive: true });
        renameSync(strip, thumbPath(data, vid, params.chapter));
        stampThumb(data, vid, params.chapter, checkedKey);
      }
    }
    events?.publish('version', { id: vid });
    rmSync(dir, { recursive: true, force: true });
    rmSync(settings, { force: true });
  };
}
