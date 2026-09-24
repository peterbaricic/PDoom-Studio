// render-job.js: final renders (frames → MP4 + poster → library) and chapter thumbnail sheets, both via render.mjs.
// Frames, thumbnails and the library live under the data root (<data>/.studio/, <data>/library/; data defaults to root).
import { mkdirSync, rmSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAPTER_WINDOWS } from './storyboard.js';

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

export function createRenderRunner({ db, root, data = root, baseUrl, events = null }) {
  const render = async (job, ctx) => {
    const vid = job.version_id, range = job.params.frames || '0:156.6', [a, b] = range.split(':').map(Number);
    const framesDir = join(data, '.studio/frames', vid), lib = join(data, 'library');
    const revisionIds = db.listFiles(vid).map(f => f.revision_id), stampFile = join(framesDir, 'revisions.json');
    // Frames left by an earlier attempt are reused only if they were painted from exactly the same revisions and
    // engine options (the options change every frame's look too).
    const stamp = JSON.stringify({ revisionIds, options: db.getVersion(vid).options });
    if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') !== stamp) rmSync(framesDir, { recursive: true, force: true });
    mkdirSync(framesDir, { recursive: true }); mkdirSync(lib, { recursive: true });
    writeFileSync(stampFile, stamp);

    const name = `${vid}-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`, t0 = Date.now();
    let total = 0, already = 0;
    await runRender([`--v=${vid}`, `--base=${baseUrl}`, `--frames=${range}`, `--workers=${job.params.workers || 4}`, `--frames-dir=${framesDir}`], {
      root, ctx, onLine: line => {
        let m = /(\d+) frames to render \((\d+) already done\)/.exec(line);
        if (m) { total = +m[1]; already = +m[2]; }
        m = /^frame (\d+)\/(\d+)/.exec(line);
        if (m && total) ctx.progress(.95 * (already + +m[1]) / (already + total));
      },
    });
    ctx.progress(.95);   // also when every frame was already there, so no frame line was printed
    await runRender(['--encode', `--frames-dir=${framesDir}`, `--start=${Math.round(a * 24)}`, `--out=${join(lib, name + '.mp4')}`], { root, ctx });
    await runRender([`--v=${vid}`, `--base=${baseUrl}`, `--poster=${job.params.poster ?? 78}`, `--out=${join(lib, name + '.jpg')}`], { root, ctx });
    db.addRender({ versionId: vid, file: name + '.mp4', revisionIds, durationS: +(b - a).toFixed(3), renderS: (Date.now() - t0) / 1000,
      sizeBytes: statSync(join(lib, name + '.mp4')).size, poster: name + '.jpg' });
    rmSync(framesDir, { recursive: true, force: true });
    events?.publish('library', { versionId: vid });
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
