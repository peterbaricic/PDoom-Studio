// pool.js: paints frames for the frame cache in a pool of pages of one sealed render browser (studio/browser.js),
// launched on first use. Each page loads one snapshot (studio.html?render&record-cast&snapshot=<id> on w0.localhost,
// with the guards of studio/frames/page.js) and paints one frame at a time, so a more urgent request waits at most
// for the frames already being painted. The queue runs preview, then prefetch, then render, then thumbs; the newest
// preview request goes first.
//
// Requests for the same frame of the same segment coalesce, queued or in progress. A frame is painted with one
// requester's snapshot; the CAST entries it read become its dependencies ({ chapterPath: sha }), and a requester whose
// current files don't match them (another version sharing that chapter, but not the chapters it read from) is queued
// again for a paint of its own.
//
// A frame that fails (the chapter throws, its script threw while loading, the page reports a load error, or painting
// takes over paintTimeoutMs) marks its segment broken: the request and every later one for that segment fail with
// that error, without painting. A hung page is closed and replaced; other pages keep painting.
import { launchBrowser } from '../browser.js';
import { getSnapshot } from '../snapshot.js';
import { openSealedPage } from './page.js';
import { FPS, chapterOfFrame, chapterPaths, depsOf } from './keys.js';

export const PRIORITIES = ['preview', 'prefetch', 'render', 'thumbs'];

class Broken extends Error {}

// Chapter code can hang the page at any point, so nothing asked of it waits for ever.
const within = (promise, ms, message) => {
  let timer;
  promise.catch(() => {});
  return Promise.race([promise, new Promise((_, bad) => { timer = setTimeout(() => bad(new Broken(message)), ms); })]).finally(() => clearTimeout(timer));
};

export function createPool({ port, baseUrl, painters = 3, onPainted, paintTimeoutMs = 20000, loadTimeoutMs = 60000 }) {
  const origin = new URL(baseUrl); origin.hostname = 'w0.localhost';
  const pageUrl = snapshotId => `${origin.origin}/studio.html?render&record-cast&snapshot=${snapshotId}`;
  const slots = Array.from({ length: painters }, () => ({ page: null, snapshotId: null, chapterErrors: {}, busy: false, used: 0 }));
  const jobs = new Map();      // `${key}:${frame}` -> { key, frame, waiters, state: 'queued' | 'painting', seq }
  const broken = new Map();    // segment key -> error message
  const counts = { painted: 0, loads: 0, failures: 0 };
  let browser = null, seq = 0, closed = false;

  const prioOf = job => Math.min(...job.waiters.map(w => w.prio));
  // Highest priority first; among previews the newest, otherwise the oldest.
  const nextJob = () => {
    let best = null;
    for (const job of jobs.values()) {
      if (job.state !== 'queued') continue;
      const p = prioOf(job), bp = best && prioOf(best);
      if (!best || p < bp || (p === bp && (p === 0 ? job.seq > best.seq : job.seq < best.seq))) best = job;
    }
    return best;
  };

  const settle = (waiters, result) => { for (const w of waiters) w.resolve(result); };

  function request({ versionId, snapshotId, key, frame, prio = 'preview', currentShas = {} }) {
    if (!PRIORITIES.includes(prio)) throw new Error(`unknown priority: ${prio}`);
    return new Promise(resolve => {
      if (closed) return resolve({ ok: false, error: 'the painting pool is closed' });
      if (broken.has(key)) return resolve({ ok: false, broken: true, error: broken.get(key) });
      enqueue({ versionId, snapshotId, key, frame, prio: PRIORITIES.indexOf(prio), currentShas, resolve });
      pump();
    });
  }

  function enqueue(w) {
    const id = `${w.key}:${w.frame}`;
    let job = jobs.get(id);
    if (!job) jobs.set(id, job = { id, key: w.key, frame: w.frame, waiters: [], state: 'queued', seq: 0 });
    job.waiters.push(w);
    if (job.state === 'queued') job.seq = ++seq;
  }

  // Drops the queued (not yet painting) requests of this version at this priority; they resolve as superseded.
  function supersede(versionId, prio) {
    const p = PRIORITIES.indexOf(prio);
    for (const job of [...jobs.values()]) {
      if (job.state !== 'queued') continue;
      const gone = job.waiters.filter(w => w.versionId === versionId && w.prio === p);
      if (!gone.length) continue;
      job.waiters = job.waiters.filter(w => !gone.includes(w));
      if (!job.waiters.length) jobs.delete(job.id);
      settle(gone, { ok: false, superseded: true, error: 'superseded by a newer request' });
    }
  }

  function pump() {
    while (!closed) {
      const free = slots.filter(s => !s.busy);
      const job = free.length && nextJob();
      if (!job) return;
      const w = job.waiters.reduce((a, b) => (b.prio < a.prio ? b : a));
      // A page that already has this snapshot, or else the one idle the longest (an empty one first).
      const slot = free.find(s => s.page && s.snapshotId === w.snapshotId) || free.sort((a, b) => (!!a.page - !!b.page) || a.used - b.used)[0];
      job.state = 'painting'; slot.busy = true;
      paint(slot, job, w).finally(() => { slot.busy = false; slot.used = Date.now(); pump(); });
    }
  }

  const closePage = slot => {
    const page = slot.page;
    Object.assign(slot, { page: null, snapshotId: null, chapterErrors: {} });
    // Closing a page whose renderer is stuck in a loop still works: Chrome ends the renderer process.
    return page ? Promise.race([page.close().catch(() => {}), Bun.sleep(5000)]) : Promise.resolve();
  };

  async function load(slot, snapshotId) {
    await closePage(slot);
    // Launched on first use; should it ever go away (a crash), the next paint starts a new one, and a failure to
    // start isn't any segment's fault.
    const launching = browser ??= launchBrowser({ port }).then(b => {
      b.once('disconnected', () => {
        if (browser !== launching) return;
        browser = null;
        for (const s of slots) Object.assign(s, { page: null, snapshotId: null, chapterErrors: {} });
      });
      return b;
    });
    let b;
    try { b = await launching; } catch (e) { if (browser === launching) browser = null; throw new Error(`the painting browser did not start: ${e.message}`); }
    counts.loads++;
    const page = await openSealedPage(b, pageUrl(snapshotId), { waitUntil: 'domcontentloaded', readyTimeout: loadTimeoutMs, recordScriptErrors: true })
      .catch(e => { throw new Broken(`the painting page did not load: ${e.message}`); });
    let loadError, scriptErrors;
    try {
      ({ loadError, scriptErrors } = await within(page.evaluate(() => ({ loadError: window.loadError || null, scriptErrors: window.scriptErrors || [] })),
        paintTimeoutMs, `the painting page stopped responding after it loaded`));
    } catch (e) { page.close().catch(() => {}); throw e instanceof Broken ? e : new Broken(e.message); }
    if (loadError) { await page.close().catch(() => {}); throw new Broken(loadError); }
    // An error while a chapter's own script ran breaks that chapter only; one from anywhere else (shared.js, the
    // engine) breaks every chapter.
    const snap = getSnapshot(snapshotId), chapterErrors = {};
    for (const { file, message } of scriptErrors) {
      const sha = /\/api\/blob\/([0-9a-f]{64})$/.exec(file)?.[1];
      const chapters = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(n => sha && chapterPaths(snap?.files || {}, n).some(p => snap.files[p] === sha));
      if (!chapters.length) { await page.close().catch(() => {}); throw new Broken(`the version did not load: ${message}`); }
      for (const n of chapters) chapterErrors[n] ??= message;
    }
    Object.assign(slot, { page, snapshotId, chapterErrors });
    // A crashed renderer: the slot starts over with a fresh page.
    page.on('error', () => { if (slot.page === page) closePage(slot); });
  }

  async function paint(slot, job, w) {
    const { key, frame } = job, n = chapterOfFrame(frame);
    let result;
    try {
      if (!slot.page || slot.snapshotId !== w.snapshotId) await load(slot, w.snapshotId);
      if (slot.chapterErrors[n]) throw new Broken(slot.chapterErrors[n]);
      const page = slot.page;
      let out;
      try {
        out = await within(page.evaluate(async t => {
          const r = await window.paintAt(t);
          return { url: document.getElementById('out').toDataURL('image/jpeg', .94), castReads: r?.castReads || [] };
        }, frame / FPS), paintTimeoutMs, `painting frame ${frame} took over ${paintTimeoutMs / 1000} s`);
      } catch (e) {
        if (e instanceof Broken) { await closePage(slot); throw e; }   // stuck: the page goes, the slot gets a fresh one next time
        // The browser going away (or the pool closing) isn't the chapter's doing; anything else is, a crash included.
        if (closed || !page.browser().connected) throw e;
        throw new Broken(e.message.split('\n')[0]);   // the chapter's own error, without the stack puppeteer appends
      }
      if (typeof out?.url !== 'string' || !out.url.startsWith('data:image/jpeg;base64,')) throw new Broken('the painting page returned no JPEG');
      const snap = getSnapshot(w.snapshotId) || { options: {}, files: {} };
      // What the page reports is chapter code's to tamper with, so it's only ever read as { path: string | null }.
      const reads = (Array.isArray(out.castReads) ? out.castReads : []).map(r => ({ path: typeof r?.path === 'string' ? r.path : null }));
      const deps = depsOf(reads, snap, n);
      await onPainted({ key, frame, jpeg: Buffer.from(out.url.slice(out.url.indexOf(',') + 1), 'base64'), deps, snapshotId: w.snapshotId, versionId: w.versionId });
      counts.painted++;
      result = { ok: true, deps };
    } catch (e) {
      counts.failures++;
      if (closed) result = { ok: false, error: 'the painting pool is closed' };
      else if (e instanceof Broken) { broken.set(key, e.message); result = { ok: false, broken: true, error: e.message }; }
      else result = { ok: false, error: e.message };
    }
    jobs.delete(job.id);
    if (!result.ok) {
      settle(job.waiters, result);
      // Queued requests for the rest of a broken segment fail now, instead of each loading and failing in turn.
      if (result.broken) for (const other of [...jobs.values()]) {
        if (other.key === key && other.state === 'queued') { jobs.delete(other.id); settle(other.waiters, result); }
      }
      return;
    }
    // A requester whose current files differ from what the frame read gets a paint of its own (once: that one is
    // painted from its own snapshot, so it matches).
    const again = [];
    for (const x of job.waiters) {
      if (x.repaint || Object.entries(result.deps).every(([p, sha]) => x.currentShas[p] === sha)) x.resolve({ ok: true });
      else again.push(x);
    }
    for (const x of again) enqueue({ ...x, repaint: true });
  }

  const stats = () => ({
    ...counts,
    painting: slots.filter(s => s.busy).length,
    pages: slots.filter(s => s.page).length,
    queued: [...jobs.values()].filter(j => j.state === 'queued')
      .flatMap(j => j.waiters.map(w => ({ versionId: w.versionId, prio: PRIORITIES[w.prio], key: j.key, frame: j.frame }))),
  });

  async function close() {
    closed = true;
    for (const job of [...jobs.values()]) if (job.state === 'queued') { jobs.delete(job.id); settle(job.waiters, { ok: false, error: 'the painting pool is closed' }); }
    const b = await browser?.catch(() => null);
    browser = null;
    await b?.close().catch(() => {});
  }

  return { request, supersede, stats, close };
}
