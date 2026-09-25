// render-job.js: final renders (from the frame cache, straight to an MP4 + poster in the library) and chapter
// thumbnail sheets (still via render.mjs). The library lives under the data root (<data>/library/; data defaults to
// root).
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CHAPTER_WINDOWS } from './storyboard.js';
import { FPS, N, DURATION } from './frames/keys.js';

// Runs render.mjs (still used for chapter thumbnail sheets), streaming its stdout to the job log and killing it on
// cancellation.
async function runRender(argv, { root, ctx, onLine }) {
  const p = Bun.spawn(['bun', join(root, 'render.mjs'), ...argv], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const kill = () => p.kill();
  ctx.signal.addEventListener('abort', kill);
  const errText = new Response(p.stderr).text(), dec = new TextDecoder();
  let buf = '';
  for await (const chunk of p.stdout) {
    buf += dec.decode(chunk, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); ctx.log(line + '\n'); onLine?.(line); }
  }
  const code = await p.exited;
  ctx.signal.removeEventListener('abort', kill);
  if (ctx.signal.aborted) throw new Error('cancelled');
  if (code !== 0) throw new Error((await errText).trim().split('\n').slice(-3).join(' ') || `render.mjs exited with code ${code}`);
}

// Runs ffmpeg directly (the final render's encode), killing it on cancellation.
async function runFfmpeg(argv, { root, ctx }) {
  const p = Bun.spawn(['ffmpeg', ...argv], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const kill = () => p.kill();
  ctx.signal.addEventListener('abort', kill);
  const errText = new Response(p.stderr).text();
  await new Response(p.stdout).text().catch(() => {});
  const code = await p.exited;
  ctx.signal.removeEventListener('abort', kill);
  if (ctx.signal.aborted) throw new Error('cancelled');
  if (code !== 0) throw new Error((await errText).trim().split('\n').slice(-5).join(' ') || `ffmpeg exited with code ${code}`);
}

// A single quote in a path would otherwise end the quoted 'file …' entry early; ffmpeg's concat demuxer reads
// '\'' as an escaped quote, the usual shell-style trick.
const quoteForConcat = p => `'${p.replace(/'/g, "'\\''")}'`;

// A concat demuxer list of files in frame order, each shown for exactly one frame's worth of time; the concat
// demuxer ignores the last entry's duration, so that entry is repeated once more without one to make it stick.
function writeConcatList(path, files) {
  const dur = (1 / FPS).toFixed(9);
  const lines = ['ffconcat version 1.0'];
  for (const f of files) lines.push(`file ${quoteForConcat(f)}`, `duration ${dur}`);
  lines.push(`file ${quoteForConcat(files[files.length - 1])}`);
  writeFileSync(path, lines.join('\n') + '\n');
}

export function createRenderRunner({ db, root, data = root, baseUrl, events = null, frames }) {
  const lib = join(data, 'library'), music = join(root, 'assets/pdoom.mp3');

  const render = async (job, ctx) => {
    const t0 = Date.now();
    const vid = job.version_id, range = job.params.frames || `0:${DURATION}`, [a, b] = range.split(':').map(Number);
    const first = Math.max(0, Math.round(a * FPS)), last = Math.min(N - 1, Math.round(b * FPS) - 1);
    if (last < first) throw new Error(`empty frame range: ${range}`);
    const version = db.getVersion(vid);
    if (!version) throw new Error(`no such version: ${vid}`);

    // Frames for [first, last] are painted (or found already cached) with their segments pinned against eviction
    // until release() runs. fillForRender has no cancellation of its own, so cancelling here races it against the
    // job's abort signal instead: on abort this rejects with 'cancelled' right away (nothing is encoded, no render
    // row is added), while the abandoned fill keeps running to completion in the background and, once it settles,
    // releases the pins it took — so a cancelled render never leaks a permanent pin.
    let aborted = false;
    const filling = frames.fillForRender(vid, p => ctx.progress(.85 * p), { from: first, to: last });
    filling.then(fill => { if (aborted) fill.release(); }).catch(() => {});
    const abort = new Promise((_, bad) => {
      const onAbort = () => { aborted = true; bad(new Error('cancelled')); };
      if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });
    });
    const fill = await Promise.race([filling, abort]);

    try {
      mkdirSync(lib, { recursive: true });
      const name = `${vid}-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`;
      const listFile = join(data, '.studio', `render-${job.id}.concat`);
      mkdirSync(dirname(listFile), { recursive: true });
      try {
        writeConcatList(listFile, fill.files);
        const out = join(lib, name + '.mp4');
        await runFfmpeg([
          '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
          '-ss', String(first / FPS), '-i', music,
          '-map', '0:v', '-map', '1:a', '-r', String(FPS),
          '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', out,
        ], { root, ctx });
        ctx.progress(.95);

        // The poster is the cached frame at 78 s (1872), or the middle of the range when that time isn't in it.
        const posterFrame = first <= 1872 && 1872 <= last ? 1872 : first + Math.floor((last - first) / 2);
        await Bun.write(join(lib, name + '.jpg'), Bun.file(fill.files[posterFrame - first]));
        ctx.progress(.99);

        db.addRender({
          versionId: vid, file: name + '.mp4', snapshotId: fill.snapshot.id, title: version.title, logline: version.logline,
          durationS: +((last - first + 1) / FPS).toFixed(3), renderS: (Date.now() - t0) / 1000,
          sizeBytes: statSync(out).size, poster: name + '.jpg',
        });
        events?.publish('library', { versionId: vid });
      } finally {
        rmSync(listFile, { force: true });
      }
    } finally {
      fill.release();
    }
  };

  const thumbs = async (job, ctx) => {
    const vid = job.version_id, chapters = db.listFiles(vid).filter(f => f.path.startsWith('ch/'));
    for (const [k, f] of chapters.entries()) {
      const n = +/^ch\/c0(\d)/.exec(f.path)[1], [a, b] = CHAPTER_WINDOWS[n - 1];
      const times = [a + .3, (a + b) / 2, b - .3].map(t => t.toFixed(2)).join(',');
      await runRender([`--v=${vid}`, `--base=${baseUrl}`, `--sheet=${times}`, '--cols=3', '--w=320',
        `--out=${join(data, '.studio/thumbs', vid, `c0${n}.jpg`)}`], { root, ctx });
      ctx.progress((k + 1) / chapters.length);
    }
    events?.publish('version', { id: vid });
  };

  return { render, thumbs };
}
