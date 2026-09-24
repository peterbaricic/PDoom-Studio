// render.mjs: drive studio.html in headless Chromium (Chrome, Edge, Brave or chrome-headless-shell; see studio/browser.js).
//   bun render.mjs --sheet=23,23.5,24 [--cols=3] [--w=640] --out=out/check.jpg   contact sheet (fast visual check)
//   bun render.mjs --stills=0.8,3,23.8 --out=out/test                          full-res PNG stills
//   bun render.mjs --poster=78 --out=out/poster.jpg                            one JPEG frame
//   bun render.mjs --check=1,12,22 [--out=sheet.jpg]                          load and render; exit 1 on any error
//   bun render.mjs --clip=0:6 --fps=24 --out=out/test.mp4                      short clip with audio
//   bun render.mjs --frames=0:156.6 --workers=4 [--frames-dir=out/frames]      full-res JPEG frames (resumable)
//   bun render.mjs --encode [--frames-dir=out/frames] [--start=0] [--out=out/pdoom.mp4]   frames + song → MP4
//   bun render.mjs --loop=recursion [--out=out/loop_recursion]                 one cycle of a standalone loop (PNGs)
// Which version: --v=<id> (default: original) or --work=<jobId> (a studio job's work folder).
// Pages come from a running studio at --base=<url>; without it, an in-process server over studio.db is started
// ($STUDIO_DB picks another database, $STUDIO_DATA another folder for .studio/ and library/, as for the studio).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync, renameSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { launchBrowser } from './studio/browser.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
// Relative paths the caller gives are theirs; everything else is relative to the project.
const CWD = process.cwd(), HERE = import.meta.dir;

// Claude Code's Bash tool runs this with STUDIO_SANDBOX set to its job's work folder (see studio/claude-job.js).
// In that case, before doing anything else: only the read-only check/preview modes are allowed, no alternate
// browser binary (neither --chrome nor $CHROME_PATH), no output outside the work folder (and no default output
// path, which would be out/ in the project), and no --base except the studio's own localhost server.
const SANDBOX = !!process.env.STUDIO_SANDBOX;
if (SANDBOX) {
  const fail = msg => { console.error(`sandbox: ${msg}`); process.exit(2); };
  // Paths are compared with symlinks resolved (the part that exists so far), so a symlinked folder on the way
  // (macOS's /var and /tmp, or a link inside the work folder) can neither wrongly refuse nor let an --out escape.
  const real = p => { const rest = []; while (!existsSync(p) && dirname(p) !== p) { rest.unshift(basename(p)); p = dirname(p); } return join(realpathSync(p), ...rest); };
  const sandbox = real(resolve(process.env.STUDIO_SANDBOX));
  // Object.fromEntries above lets a later --flag=x silently win over an earlier one, so a repeated flag (e.g. a
  // decoy --work=<own job> followed by the real --work=<someone else's job>) could pass every check below while
  // acting on a different value. Reject any flag given more than once before trusting `args` at all.
  const rawKeys = process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')[0]);
  const dup = rawKeys.find((k, i) => rawKeys.indexOf(k) !== i);
  if (dup) fail(`--${dup} is given more than once`);
  for (const f of ['chrome', 'angle', 'frames', 'frames-dir', 'encode', 'loop', 'clip']) {
    if (args[f] !== undefined) fail(`--${f} is not allowed`);
  }
  if (!['sheet', 'check', 'poster', 'stills'].some(m => args[m] !== undefined)) fail('only --sheet, --check, --poster or --stills are allowed');
  if (!args.work) fail('--work is required');
  // The work folder is named after the job id, so --work must name the very job this sandbox belongs to — it
  // can't be used to point render.mjs at (and thus read into this sandbox) a different job's private files.
  if (String(args.work) !== basename(sandbox)) fail('--work must match the sandboxed job');
  if (!args.out && ['sheet', 'poster', 'stills'].some(m => args[m] !== undefined)) fail('--out is required (a path inside the work folder)');
  if (args.out) {
    const out = real(resolve(CWD, args.out));
    if (out !== sandbox && !out.startsWith(sandbox + sep)) fail(`--out must resolve inside ${sandbox}`);
  }
  if (args.base && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+\/?$/.test(args.base)) {
    fail('--base must be http://localhost, http://127.0.0.1 or http://[::1] with a port');
  }
}

process.chdir(HERE);
const outPath = def => args.out ? resolve(CWD, args.out) : resolve(HERE, def);
const DUR = 156.6, fps = +(args.fps || 24);
const FRAMES_DIR = args['frames-dir'] ? resolve(CWD, args['frames-dir']) : resolve(HERE, 'out/frames');
const times = s => String(s).split(',').map(Number);

// Stopped with SIGTERM or SIGINT (e.g. a cancelled studio job), stop ffmpeg and the browser too, so nothing keeps
// running after this process.
const kids = new Set();
let browser = null, stopping = false;
const stop = async code => {
  if (stopping) return;
  stopping = true;
  for (const k of kids) k.kill('SIGKILL');
  await Promise.race([browser?.close(), Bun.sleep(5000)]).catch(() => {});
  process.exit(code);
};
process.on('SIGTERM', () => stop(143));
process.on('SIGINT', () => stop(130));
const child = (cmd, a, opts) => { const p = spawn(cmd, a, opts); kids.add(p); p.on('close', () => kids.delete(p)); return p; };

const run = (cmd, a) => new Promise((ok, bad) => {
  const p = child(cmd, a, { stdio: 'inherit' });
  p.on('close', (c, sig) => c || sig ? bad(new Error(`${cmd} exited ${c ?? sig}`)) : ok());
});

if (args.encode) {
  const out = outPath('out/pdoom.mp4'), start = +(args.start || 0), n = readdirSync(FRAMES_DIR).filter(f => f.endsWith('.jpg')).length;
  mkdirSync(dirname(out), { recursive: true });
  console.log(`encoding ${n} frames → ${out}`);
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-stats', '-framerate', String(fps), '-start_number', String(start), '-i', `${FRAMES_DIR}/f%05d.jpg`,
    '-ss', String(start / fps), '-i', 'assets/pdoom.mp3',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', '-shortest', out]);
  console.log('wrote ' + out);
  process.exit(0);
}

let base = args.base, local = null;
if (!base) {
  const [{ openDb }, { importOriginal }, { serve }, { createEvents }] = await Promise.all(
    ['./studio/db.js', './studio/versions.js', './studio/serve.js', './studio/events.js'].map(m => import(m)));
  const db = openDb(process.env.STUDIO_DB ? resolve(CWD, process.env.STUDIO_DB) : resolve(HERE, 'studio.db'));
  importOriginal(db, HERE);
  const data = process.env.STUDIO_DATA ? resolve(CWD, process.env.STUDIO_DATA) : HERE;
  local = serve({ db, root: HERE, data, token: randomBytes(16).toString('hex'), events: createEvents(), port: 0 });
  base = local.url;
}
// Version code runs only on a renderer origin (w0.localhost), never on the studio's own, which serves the token page.
const pageOrigin = new URL(base); pageOrigin.hostname = 'w0.localhost';
const PAGE = `${pageOrigin.origin}/studio.html?render&` + (args.work ? `work=${args.work}` : `v=${args.v || 'original'}`);

browser = await launchBrowser({ chrome: args.chrome, angle: args.angle, fromEnv: !SANDBOX });
let exitCode = 0;
// errors: collect load and page errors there instead of logging them (--check). strict: an error while the page loads
// (a chapter that throws, a script that can't load) is fatal instead of logged, so it can't be painted as missing.
async function openPage(tag = '', errors = null, { strict = false } = {}) {
  const loadErrors = [];
  let loading = true;
  const page = await browser.newPage();
  page.on('console', m => {
    if (!['error', 'warn'].includes(m.type())) return;
    if (errors && m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
    else console.log(`[page${tag}]`, m.text());
  });
  page.on('pageerror', e => {
    if (errors) return errors.push(e.message);
    console.log(`[page error${tag}]`, e.message);
    if (loading) loadErrors.push(e.message);
  });
  await page.goto(PAGE, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.ready === true', { timeout: 60000 });
  const loadError = await page.evaluate(() => window.loadError || null);
  if (loadError) { if (errors) errors.push(loadError); else throw new Error(loadError); }
  loading = false;
  if (strict && loadErrors.length) throw new Error(`the page did not load cleanly: ${loadErrors.join('; ')}`);
  if (args.loop) await page.evaluate(name => { window.LOOP = LOOPS[name]; }, args.loop);
  return page;
}
const frameOf = async (page, t, type, q) => {
  const url = await page.evaluate((t, type, q) => window.renderAt(t, type, q), t, type, q);
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
};
const writeSheet = async (page, ts, out) => {
  const { url, ms } = await page.evaluate((ts, c, w) => window.renderSheet(ts, c, w), ts, +(args.cols || 3), +(args.w || 640));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  return ms;
};

if (args.check) {
  // Validation for studio jobs: the version must load without errors, and each time must be covered by a chapter and
  // paint within 20 s without throwing.
  // --check=load only loads the version (used for shared.js, which covers no time of its own).
  const errors = [], ts = times(args.check).filter(Number.isFinite);
  const page = await openPage('', errors).catch(e => { errors.push(e.message); return null; });
  for (const t of (page && !errors.length) ? ts : []) {
    const covered = await page.evaluate(t => CH.some(c => t >= c.start && t < c.end), t).catch(e => { errors.push(e.message); return null; });
    if (covered === null) continue;
    if (!covered) { errors.push(`no chapter covers t=${t}`); continue; }
    const slow = new Promise((_, bad) => setTimeout(() => bad(new Error(`painting t=${t} took over 20 s`)), 20000));
    await Promise.race([page.evaluate(t => window.paintAt(t), t), slow]).catch(e => errors.push(e.message));
  }
  if (page && !errors.length && args.out) await writeSheet(page, ts, outPath('sheet.jpg'));
  if (errors.length) { console.error('CHECK FAILED\n' + errors.join('\n')); exitCode = 1; } else console.log('CHECK OK');
} else if (args.sheet) {
  const page = await openPage(), out = outPath('out/sheet.jpg');
  const ms = await writeSheet(page, times(args.sheet), out);
  console.log(`${out}  ms/frame: ${ms.join(' ')}`);
} else if (args.poster) {
  const page = await openPage(), out = outPath('out/poster.jpg');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await frameOf(page, +args.poster, 'image/jpeg', .9));
  console.log('wrote ' + out);
} else if (args.stills) {
  const page = await openPage(), out = outPath('out/stills'); mkdirSync(out, { recursive: true });
  console.log('GPU:', await page.evaluate(() => window.gpuInfo()));
  for (const s of times(args.stills)) {
    const t0 = Date.now(), buf = await frameOf(page, s, 'image/png');
    const f = `${out}/t${s.toFixed(2).replace('.', '_')}.png`; writeFileSync(f, buf);
    console.log(`${f}  ${Date.now() - t0} ms`);
  }
} else if (args.loop) {
  // One full cycle of a standalone loop scene as PNGs (t = loop time); frame n equals frame 0, so it isn't rendered.
  const out = outPath(`out/loop_${args.loop}`), workers = +(args.workers || 3); mkdirSync(out, { recursive: true });
  const probe = await openPage(), len = await probe.evaluate(() => window.LOOP.len), n = Math.round(len * fps);
  await probe.close();
  let next = 0; const start = Date.now();
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    const page = await openPage('#' + w);
    while (next < n) { const i = next++; writeFileSync(`${out}/l${String(i).padStart(3, '0')}.png`, await frameOf(page, i / fps, 'image/png')); }
  }));
  console.log(`${n} loop frames → ${out}  (${((Date.now() - start) / n).toFixed(0)} ms/frame)`);
} else if (args.frames) {
  // Parallel, resumable: each worker page pulls the next missing frame index; files are written atomically.
  const [a, b] = String(args.frames).split(':').map(Number), workers = +(args.workers || 4);
  mkdirSync(FRAMES_DIR, { recursive: true });
  const first = Math.round(a * fps), last = Math.min(Math.ceil(DUR * fps) - 1, Math.round(b * fps) - 1);
  const todo = []; for (let i = first; i <= last; i++) { const f = `${FRAMES_DIR}/f${String(i).padStart(5, '0')}.jpg`; if (!existsSync(f) || statSync(f).size < 1000) todo.push(i); }
  console.log(`${todo.length} frames to render (${last - first + 1 - todo.length} already done), ${workers} workers`);
  let next = 0, done = 0; const start = Date.now();
  const work = async w => {
    const page = await openPage('#' + w, null, { strict: true });
    while (next < todo.length) {
      const i = todo[next++], f = `${FRAMES_DIR}/f${String(i).padStart(5, '0')}.jpg`;
      const buf = await frameOf(page, i / fps, 'image/jpeg', .94);
      writeFileSync(f + '.tmp', buf); renameSync(f + '.tmp', f);
      if (++done % 24 === 0 || done === todo.length) {
        const el = (Date.now() - start) / 1000;
        console.log(`frame ${done}/${todo.length}  ${(el / done * 1000).toFixed(0)} ms/frame effective  eta ${((todo.length - done) * el / done / 60).toFixed(1)} min`);
      }
    }
  };
  try { await Promise.all(Array.from({ length: workers }, (_, w) => work(w))); }
  catch (e) { console.error(`render failed: ${e.message}`); exitCode = 1; }
} else {
  const page = await openPage();
  const [a, b] = args.clip ? String(args.clip).split(':').map(Number) : [0, DUR];
  const out = outPath('out/clip.mp4'); mkdirSync(dirname(out), { recursive: true });
  const ff = child('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-ss', String(a), '-t', String(b - a), '-i', 'assets/pdoom.mp3',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', out],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const n = Math.round((b - a) * fps), start = Date.now();
  for (let i = 0; i < n; i++) {
    const buf = await frameOf(page, a + i / fps, 'image/jpeg', .92);
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 24 === 0 || i === n - 1) console.log(`frame ${i + 1}/${n}  ${((Date.now() - start) / (i + 1)).toFixed(0)} ms/frame`);
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r));
  console.log(`wrote ${out}`);
}
await browser.close();
local?.stop();
process.exit(exitCode);
