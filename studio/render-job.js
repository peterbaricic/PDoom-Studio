// render-job.js: final renders and chapter thumbnails, both straight from the frame cache (via the frame service),
// composed/encoded with ffmpeg. The library lives under the data root (<data>/library/; data defaults to root).
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CHAPTER_WINDOWS } from './storyboard.js';
import { FPS, DURATION, frameRange } from './frames/keys.js';

// Runs ffmpeg directly, killing it on cancellation.
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

// A concat demuxer list of files in frame order, each shown for exactly one frame's worth of time. (Older ffmpeg
// ignored the last entry's duration, and repeating that entry was the usual fix; ffmpeg 9 honours it, so a repeat
// adds a frame. The encode below caps the output at exactly the range's frame count either way.)
function writeConcatList(path, files) {
  const dur = (1 / FPS).toFixed(9);
  const lines = ['ffconcat version 1.0'];
  for (const f of files) lines.push(`file ${quoteForConcat(f)}`, `duration ${dur}`);
  writeFileSync(path, lines.join('\n') + '\n');
}

// One frame through the frame service, waiting out a pending paint: the file path once painted (or already
// cached), or thrown if the version/chapter is missing, the segment is broken, or nothing could be painted.
async function frameFile(frames, versionId, i, prio, ctx) {
  const r = frames.frame(versionId, i, prio, { signal: ctx.signal });
  if (r.missing) throw new Error(r.missing);
  const settled = r.pending ? await r.pending : r;
  if (settled.broken) throw new Error(settled.broken);
  if (!settled.file) throw new Error(settled.retry || `frame ${i} was not painted`);
  return settled.file;
}

export function createRenderRunner({ db, root, data = root, events = null, frames }) {
  const lib = join(data, 'library');

  const render = async (job, ctx) => {
    const t0 = Date.now();
    const vid = job.version_id, range = job.params.frames || `0:${DURATION}`, [a, b] = range.split(':').map(Number);
    const { first, last } = frameRange(a, b);
    if (last < first) throw new Error(`empty frame range: ${range}`);
    const version = db.getVersion(vid);
    if (!version) throw new Error(`no such version: ${vid}`);
    const revisionIds = db.listFiles(vid).map(f => f.revision_id);

    // Frames for [first, last] are painted (or found already cached) with their segments pinned against eviction
    // until release() runs. The job's own abort signal is forwarded to fillForRender, which forwards it in turn to
    // every frame it still needs to paint: on abort, the pool drops whatever of those is still queued right away
    // (pool.request already does this for a withdrawn signal), fillForRender's own fill rejects as soon as any of
    // them comes back cancelled, and its catch block releases the pins before rethrowing — so cancelling here both
    // stops queueing more painting work and never leaks a pin.
    let fill;
    try {
      fill = await frames.fillForRender(vid, p => ctx.progress(.85 * p), { from: first, to: last, signal: ctx.signal });
    } catch (e) {
      if (ctx.signal.aborted) throw new Error('cancelled');
      throw e;
    }
    if (ctx.signal.aborted) { fill.release(); throw new Error('cancelled'); }   // a range that was already fully cached

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
          '-ss', String(first / FPS), '-i', join(root, 'assets/pdoom.mp3'),
          '-map', '0:v', '-map', '1:a', '-r', String(FPS),
          '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p',
          // Exactly the range: its n frames, and the song cut to their length (-shortest lets the audio run on).
          '-frames:v', String(last - first + 1), '-t', ((last - first + 1) / FPS).toFixed(6),
          '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out,
        ], { root, ctx });
        ctx.progress(.95);

        // The poster is the cached frame at 78 s (1872), or the middle of the range when that time isn't in it.
        const posterFrame = first <= 1872 && 1872 <= last ? 1872 : first + Math.floor((last - first) / 2);
        await Bun.write(join(lib, name + '.jpg'), Bun.file(fill.files[posterFrame - first]));
        ctx.progress(.99);

        db.addRender({
          versionId: vid, file: name + '.mp4', revisionIds, snapshotId: fill.snapshot.id, title: version.title, logline: version.logline,
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

  // Three frames per chapter (0.3 s in, the middle, 0.3 s from the end) through the frame service, scaled to
  // 320 px wide and placed side by side with ffmpeg — the same cache preview and final renders share, so a chapter
  // already covered by a preview or a render costs nothing extra here, and a second run of this job paints nothing.
  // All nine chapter slots are attempted regardless of how many the version actually has written: a chapter that
  // isn't written yet or whose segment is broken is logged and skipped rather than failing the whole job, so the
  // healthy chapters still get their thumbnail. Only cancellation stops the job outright.
  const thumbs = async (job, ctx) => {
    const vid = job.version_id;
    for (let n = 1; n <= 9; n++) {
      const [a, b] = CHAPTER_WINDOWS[n - 1];
      const frameIdx = [a + .3, (a + b) / 2, b - .3].map(t => Math.round(t * FPS));
      try {
        const files = await Promise.all(frameIdx.map(i => frameFile(frames, vid, i, 'thumbs', ctx)));
        const out = join(data, '.studio/thumbs', vid, `c0${n}.jpg`);
        mkdirSync(dirname(out), { recursive: true });
        await runFfmpeg([
          '-y', '-loglevel', 'error', '-i', files[0], '-i', files[1], '-i', files[2],
          '-filter_complex', '[0:v]scale=320:-1[s0];[1:v]scale=320:-1[s1];[2:v]scale=320:-1[s2];[s0][s1][s2]hstack=inputs=3',
          '-frames:v', '1', '-q:v', '3', out,
        ], { root, ctx });
      } catch (e) {
        if (ctx.signal.aborted) throw new Error('cancelled');
        ctx.log(`chapter ${n}: skipped (${e.message})\n`);
      }
      ctx.progress(n / 9);
    }
    events?.publish('version', { id: vid });
  };

  return { render, thumbs };
}
