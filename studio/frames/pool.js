// pool.js: paints frames for the frame cache in a pool of pages of one sealed render browser (studio/browser.js),
// launched on first use. Each page loads one snapshot (studio.html?render&record-cast&snapshot=<id> on w0.localhost,
// with the guards of studio/frames/page.js) and paints one frame at a time, so a more urgent request waits at most
// for the frames already being painted. The queue runs preview, then prefetch, then render, then thumbs, then
// background (a version's paint-ahead sweep, studio/frames/service.js: only when nothing else waits); the newest
// preview request goes first, and each version keeps at most MAX_PREFETCH prefetch requests queued: those nearest
// the newest request's playhead (`near`, by default the frame it asks for).
//
// Requests for the same frame of the same segment coalesce, queued or in progress. A frame is painted with one
// requester's snapshot; the CAST entries it read (while painting, and while the scripts loaded) become its
// dependencies ({ chapterPath: sha }), and a requester whose current files don't match them (another version sharing
// that chapter, but not the chapters it read from) is queued again for a paint from its own snapshot.
//
// Failures:
// - a chapter that throws while painting, or whose script throws while loading, breaks its segment until the key
//   changes: the request and every later one for that segment fail with that error, without painting;
// - a chapter that takes over paintTimeoutMs to paint a frame, or loadTimeoutMs to load (a script still running when
//   the page should have been ready is the one it last asked for: scripts load one after another), breaks it for
//   brokenTtlMs only (a slow machine can be slow once). A snapshot with a chapter that hangs while loading is loaded
//   without it for the other chapters, whose frames paint as long as they didn't need it;
// - anything else that stops a snapshot from loading (a load error such as a missing font, shared.js throwing)
//   fails its requests for snapshotFailureTtlMs without costing a page each;
// - the browser going away, or the pool closing, fails only the requests at hand (ask again);
// - a browser that won't start at all (none installed, a bad CHROME_PATH) fails every request at hand and every one
//   after it at once, with the reason (unavailable: true), until launchRetryMs has passed: then the next request tries
//   to launch it again, so installing a browser (or fixing CHROME_PATH and restarting) recovers. health() says so.
// A snapshot's first load runs alone: until one page has loaded it, its other requests wait instead of each taking
// (and, for a hanging chapter, holding) a page of their own.
import { launchBrowser } from '../browser.js';
import { getSnapshot, rememberSnapshot, sha256, canonicalJson } from '../snapshot.js';
import { openSealedPage, PAINTER_SECRET } from './page.js';
import { FPS, chapterOfFrame, chapterPaths, depsOf, depsHash } from './keys.js';
import { CHAPTER_WINDOWS } from '../storyboard.js';

export const PRIORITIES = ['preview', 'prefetch', 'render', 'thumbs', 'background'];
const PREFETCH = 1, MAX_PREFETCH = 240;

// The chapter's (or the version's) own fault: its segment is broken, for good (until = null) or until then.
// snapshot: it's the whole snapshot that failed to load, not this segment.
class Broken extends Error { constructor(message, until = null, { snapshot = false } = {}) { super(message); this.until = until; this.snapshot = snapshot; } }
// The painting browser didn't start: nothing can be painted, whatever the chapter.
class Unavailable extends Error {}
// A script that was still running when the page should have been ready.
class Hung extends Error { constructor(message, chapter) { super(message); this.chapter = chapter; } }

// Chapter code can hang the page at any point, so nothing asked of it waits for ever.
const within = (promise, ms, error) => {
  let timer;
  promise.catch(() => {});
  return Promise.race([promise, new Promise((_, bad) => { timer = setTimeout(() => bad(error()), ms); })]).finally(() => clearTimeout(timer));
};

export function createPool({ port, baseUrl, painters = 3, onPainted, paintTimeoutMs = 20000, loadTimeoutMs = 60000,
  brokenTtlMs = 60000, snapshotFailureTtlMs = 30000, launch = launchBrowser, launchRetryMs = 30000, painterSecret = PAINTER_SECRET }) {
  const origin = new URL(baseUrl); origin.hostname = 'w0.localhost';
  const pageUrl = snapshotId => `${origin.origin}/studio.html?render&painter=${painterSecret}&record-cast&snapshot=${snapshotId}`;
  const emptySlot = () => ({ page: null, snapshotId: null, without: '', chapterErrors: {}, loadReads: {} });
  const slots = Array.from({ length: painters }, () => ({ ...emptySlot(), busy: false, used: 0 }));
  const jobs = new Map();            // `${key}:${frame}` -> { id, key, frame, waiters, state: 'queued' | 'painting', seq }
  const broken = new Map();          // segment key -> { error, until }
  const failedSnapshots = new Map(); // snapshot id -> { error, until }
  const hung = new Map();            // snapshot id -> Map<chapter, { error, until }>
  const loaded = new Set(), firstLoads = new Set();   // snapshots a page has loaded; ones whose first load is running
  const counts = { painted: 0, loads: 0, failures: 0 };
  let browser = null, seq = 0, closed = false;
  let launchFailure = null;          // { error, at }: the last launch failed, and none has succeeded since
  const painterDown = () => launchFailure && Date.now() - launchFailure.at < launchRetryMs ? launchFailure.error : null;

  const fresh = (map, k) => { const v = map.get(k); if (v && v.until != null && v.until <= Date.now()) { map.delete(k); return null; } return v || null; };
  const hungIn = snapshotId => {
    const m = hung.get(snapshotId) || new Map();
    for (const n of [...m.keys()]) fresh(m, n);
    return m;
  };

  const prioOf = job => Math.min(...job.waiters.map(w => w.prio));
  const leadOf = job => job.waiters.reduce((a, b) => (b.prio < a.prio ? b : a));
  // Highest priority first; among previews the newest, otherwise the oldest. A job whose snapshot is having its
  // first load waits for it.
  const nextJob = () => {
    let best = null;
    for (const job of jobs.values()) {
      if (job.state !== 'queued' || firstLoads.has(leadOf(job).snapshotId)) continue;
      const p = prioOf(job), bp = best && prioOf(best);
      if (!best || p < bp || (p === bp && (p === 0 ? job.seq > best.seq : job.seq < best.seq))) best = job;
    }
    return best;
  };

  const finish = (w, result) => { if (w.done) return; w.done = true; w.signal?.removeEventListener('abort', w.onAbort); w.resolve(result); };
  const settle = (waiters, result) => { for (const w of waiters) finish(w, result); };
  const brokenResult = (error, until = null) => ({ ok: false, broken: true, error, ...(until != null && { until }) });
  const unavailableResult = error => ({ ok: false, unavailable: true, error });

  // A request's result: { ok: true, depsHash }; { ok: false, broken: true, error, until?, snapshot? } (snapshot: the
  // whole snapshot failed to load, not this segment); { ok: false, unavailable: true, error } (the painting browser
  // didn't start: error says why); or { ok: false, error, superseded? | cancelled? } (ask again).
  function request({ versionId, snapshotId, key, frame, prio = 'preview', currentShas = {}, signal, near = frame }) {
    if (!PRIORITIES.includes(prio)) throw new Error(`unknown priority: ${prio}`);
    return new Promise(resolve => {
      if (closed) return resolve({ ok: false, error: 'the painting pool is closed' });
      const down = painterDown();
      if (down) return resolve(unavailableResult(down));
      const b = fresh(broken, key), f = !b && fresh(failedSnapshots, snapshotId);
      if (b) return resolve(brokenResult(b.error, b.until));
      if (f) return resolve({ ...brokenResult(f.error, f.until), snapshot: true });
      if (signal?.aborted) return resolve({ ok: false, cancelled: true, error: 'cancelled' });
      const w = { versionId, snapshotId, key, frame, prio: PRIORITIES.indexOf(prio), currentShas, signal, near, resolve };
      w.onAbort = () => cancel(w);
      signal?.addEventListener('abort', w.onAbort, { once: true });
      enqueue(w);
      pump();
    });
  }

  function enqueue(w) {
    const id = `${w.key}:${w.frame}`;
    let job = jobs.get(id);
    if (!job) jobs.set(id, job = { id, key: w.key, frame: w.frame, waiters: [], state: 'queued', seq: 0 });
    job.waiters.push(w);
    w.job = job; w.seq = ++seq;
    if (job.state === 'queued') job.seq = w.seq;
    if (w.prio === PREFETCH) {
      // Over the cap, the version's queued prefetch farthest from this request's playhead goes (the older first).
      const mine = queuedWaiters().filter(x => x.versionId === w.versionId && x.prio === PREFETCH)
        .sort((a, b) => Math.abs(b.frame - w.near) - Math.abs(a.frame - w.near) || a.seq - b.seq);
      for (const x of mine.slice(0, Math.max(0, mine.length - MAX_PREFETCH))) drop(x, { ok: false, superseded: true, error: 'superseded by nearer prefetch requests' });
    }
  }

  const queuedWaiters = () => [...jobs.values()].filter(j => j.state === 'queued').flatMap(j => j.waiters);

  // Takes a waiter off its job (a queued job left with none goes; one being painted goes on, for the cache).
  function drop(w, result) {
    const job = w.job;
    job.waiters = job.waiters.filter(x => x !== w);
    if (!job.waiters.length && job.state === 'queued') jobs.delete(job.id);
    finish(w, result);
  }
  const cancel = w => { if (!w.done) drop(w, { ok: false, cancelled: true, error: 'cancelled' }); };

  // Drops the queued (not yet painting) requests of this version (or of every version, for null) at this priority;
  // they resolve as superseded.
  function supersede(versionId, prio) {
    const p = PRIORITIES.indexOf(prio);
    for (const w of queuedWaiters()) {
      if ((versionId == null || w.versionId === versionId) && w.prio === p) drop(w, { ok: false, superseded: true, error: 'superseded by a newer request' });
    }
  }

  function pump() {
    while (!closed) {
      const free = slots.filter(s => !s.busy);
      const job = free.length && nextJob();
      if (!job) return;
      const w = leadOf(job);
      // A page that already has this snapshot, or else the one idle the longest (an empty one first).
      const slot = free.find(s => s.page && s.snapshotId === w.snapshotId) || free.sort((a, b) => (!!a.page - !!b.page) || a.used - b.used)[0];
      job.state = 'painting'; slot.busy = true;
      // A snapshot no page has loaded yet: its first load runs alone, so its other requests wait (nextJob skips them)
      // instead of each taking a page, all of them held for as long as a hanging chapter holds one.
      const first = !(slot.page && slot.snapshotId === w.snapshotId) && !loaded.has(w.snapshotId);
      if (first) firstLoads.add(w.snapshotId);
      paint(slot, job, w).finally(() => { if (first) firstLoads.delete(w.snapshotId); slot.busy = false; slot.used = Date.now(); pump(); });
    }
  }

  const closePage = slot => {
    const page = slot.page;
    Object.assign(slot, emptySlot());
    // Closing a page whose renderer is stuck in a loop still works: Chrome ends the renderer process.
    return page ? Promise.race([page.close().catch(() => {}), Bun.sleep(5000)]) : Promise.resolve();
  };

  const getBrowser = async () => {
    // Launched on first use; should it ever go away (a crash), the next paint starts a new one. A failure to start
    // isn't any segment's fault: it's remembered, and nothing is tried again for launchRetryMs.
    const down = painterDown();
    if (down) throw new Unavailable(down);
    const launching = browser ??= launch({ port }).then(b => {
      b.once('disconnected', () => {
        if (browser !== launching) return;
        browser = null;
        for (const s of slots) if (s.page) Object.assign(s, emptySlot());
      });
      return b;
    });
    try {
      const b = await launching;
      launchFailure = null;
      return b;
    } catch (e) {
      if (browser === launching) browser = null;
      if (closed) throw new Error('the painting pool is closed');
      const why = String(e?.message || e).trim().split('\n').slice(0, 3).join(' ');
      launchFailure = { error: `the painting browser did not start: ${why}`, at: Date.now() };
      throw new Unavailable(launchFailure.error);
    }
  };

  // The chapters (numbers) whose file has this content hash.
  const chaptersWithSha = (snap, sha) => [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(n => sha && chapterPaths(snap.files, n).some(p => snap.files[p] === sha));

  // Loads the snapshot into the slot's page, leaving out the chapters in `without` (they hang while loading).
  async function load(slot, snapshotId, without) {
    // (Already marked when pump() handed this paint a snapshot no page had loaded: then the mark lasts the whole paint.)
    const first = !loaded.has(snapshotId) && !firstLoads.has(snapshotId);
    if (first) firstLoads.add(snapshotId);
    try { return await loadInto(slot, snapshotId, without); } finally { if (first) firstLoads.delete(snapshotId); }
  }
  async function loadInto(slot, snapshotId, without) {
    await closePage(slot);
    const b = await getBrowser();
    const snap = getSnapshot(snapshotId);
    if (!snap) throw new Error('the snapshot is no longer known');
    let pageSnapshot = snapshotId;
    if (without.size) {
      const files = Object.fromEntries(Object.entries(snap.files).filter(([p]) => ![...without].some(n => chapterPaths(snap.files, n).includes(p))));
      pageSnapshot = rememberSnapshot({ id: sha256(canonicalJson({ options: snap.options, files })), options: snap.options, files }).id;
    }
    counts.loads++;
    let lastBlob = null, page;
    try {
      page = await openSealedPage(b, pageUrl(pageSnapshot), {
        readyTimeout: loadTimeoutMs, recordScriptErrors: true,
        onRequest: r => { const m = /\/api\/blob\/([0-9a-f]{64})$/.exec(r.url()); if (m) lastBlob = m[1]; },
      });
      const state = await within(page.evaluate(() => ({
        loadError: window.loadError || null, scriptErrors: window.scriptErrors || [], loadReads: window.castRecorder?.loadReads() || {},
      })), paintTimeoutMs, () => new Error('the painting page stopped responding after it loaded'));
      if (state.loadError) throw new Error(state.loadError);
      // An error while a chapter's own script ran breaks that chapter only; one from anywhere else (shared.js, the
      // engine) breaks every chapter.
      const chapterErrors = {};
      for (const { file, message } of state.scriptErrors) {
        const chapters = chaptersWithSha(snap, /\/api\/blob\/([0-9a-f]{64})$/.exec(file)?.[1]);
        if (!chapters.length) throw new Error(`the version did not load: ${message}`);
        for (const n of chapters) chapterErrors[n] ??= message;
      }
      Object.assign(slot, { page, snapshotId, without: [...without].sort().join(','), chapterErrors, loadReads: state.loadReads || {} });
      loaded.add(snapshotId);
      if (loaded.size > 1000) loaded.delete(loaded.values().next().value);
      // A crashed renderer: the slot starts over with a fresh page.
      page.on('error', () => { if (slot.page === page) closePage(slot); });
    } catch (e) {
      if (page && slot.page !== page) page.close().catch(() => {});
      if (closed || !b.connected) throw new Error(e.message);
      if (e.notReady) {
        const chapters = chaptersWithSha(snap, lastBlob).filter(n => !without.has(n));
        if (chapters.length) throw new Hung(`chapter ${chapters[0]} did not finish loading within ${loadTimeoutMs / 1000} s`, chapters[0]);
      }
      const until = Date.now() + snapshotFailureTtlMs;
      failedSnapshots.set(snapshotId, { error: e.message, until });
      throw new Broken(e.message, until, { snapshot: true });
    }
  }

  async function paint(slot, job, w) {
    const { key, frame } = job, n = chapterOfFrame(frame), snapshotId = w.snapshotId;
    let result;
    try {
      const failed = fresh(failedSnapshots, snapshotId);
      if (failed) throw new Broken(failed.error, failed.until, { snapshot: true });
      for (;;) {
        const without = hungIn(snapshotId), h = without.get(n);
        if (h) throw new Broken(h.error, h.until);
        if (slot.page && slot.snapshotId === snapshotId && slot.without === [...without.keys()].sort().join(',')) break;
        try { await load(slot, snapshotId, new Set(without.keys())); break; }
        catch (e) {
          if (!(e instanceof Hung)) throw e;
          if (!hung.has(snapshotId)) hung.set(snapshotId, new Map());
          hung.get(snapshotId).set(e.chapter, { error: e.message, until: Date.now() + brokenTtlMs });
          // Once that expires and the chapter is tried again, its load runs alone again, as a first one.
          loaded.delete(snapshotId);
        }
      }
      if (slot.chapterErrors[n]) throw new Broken(slot.chapterErrors[n]);
      const page = slot.page;
      let out;
      try {
        out = await within(page.evaluate(async t => {
          const r = await window.paintAt(t);
          return { url: document.getElementById('out').toDataURL('image/jpeg', .94), castReads: r?.castReads || [], drawnBy: r?.drawnBy ?? null };
        }, frame / FPS), paintTimeoutMs, () => new Broken(`painting frame ${frame} took over ${paintTimeoutMs / 1000} s`, Date.now() + brokenTtlMs));
      } catch (e) {
        // Stuck: the page goes, and the slot gets a fresh one next time. The break's time counts from now, once the
        // page is closed (that can take seconds), so it's never handed over already partly or wholly used up.
        if (e instanceof Broken) { await closePage(slot); throw new Broken(e.message, Date.now() + brokenTtlMs); }
        // The browser going away (or the pool closing) isn't the chapter's doing.
        if (closed || !page.browser().connected) throw e;
        // A crashed renderer might be a one-off; an error the chapter threw isn't.
        if (page.isClosed() || /Target closed|crashed/i.test(e.message)) { await closePage(slot); throw new Broken(e.message.split('\n')[0], Date.now() + brokenTtlMs); }
        throw new Broken(e.message.split('\n')[0]);   // the chapter's own error, without the stack puppeteer appends
      }
      if (typeof out?.url !== 'string' || !out.url.startsWith('data:image/jpeg;base64,')) throw new Broken('the painting page returned no JPEG');
      const snap = getSnapshot(snapshotId) || { options: {}, files: {} };
      // The frame is keyed by its window's chapter: drawn by another chapter's registration (one reaching past its
      // own window), it would change with that chapter's code, not this key's. Not this chapter's fault, so the break
      // lasts brokenTtlMs: fixing the other chapter doesn't change this key. (Drawn by nothing, it's the engine's
      // placeholder, which is this key's too.)
      if (out.drawnBy) {
        const owner = typeof out.drawnBy.owner === 'string' ? out.drawnBy.owner : null;
        if (!chapterPaths(snap.files, n).includes(owner)) {
          const [a, b] = CHAPTER_WINDOWS[n - 1];
          throw new Broken(`frame ${frame} was drawn by ${owner || 'code outside the version\'s chapter files'}, not by chapter ${n}: `
            + `a chapter() window reaches into chapter ${n}'s ${a}–${b} s`, Date.now() + brokenTtlMs);
        }
      }
      // What the page reports is chapter code's to tamper with, so it's only ever read as { path: string | null }.
      const clean = list => (Array.isArray(list) ? list : []).map(r => ({ path: typeof r?.path === 'string' ? r.path : null }));
      const loadReads = Object.fromEntries(Object.entries(slot.loadReads || {}).map(([p, list]) => [p, clean(list)]));
      const deps = depsOf(clean(out.castReads), snap, n, loadReads);
      // Painted without a chapter that hung while loading, a frame that read an entry nobody defined might have
      // needed that chapter: it can't be painted until the chapter loads.
      if (slot.without && deps['*']) {
        const h = [...hungIn(snapshotId).values()][0];
        throw new Broken(`this frame may need a chapter that did not load: ${h?.error || 'it timed out'}`, h?.until ?? Date.now() + brokenTtlMs);
      }
      await onPainted({ key, frame, jpeg: Buffer.from(out.url.slice(out.url.indexOf(',') + 1), 'base64'), deps, snapshotId, versionId: w.versionId });
      counts.painted++;
      result = { ok: true, deps, depsHash: depsHash(deps) };
    } catch (e) {
      counts.failures++;
      if (closed) result = { ok: false, error: 'the painting pool is closed' };
      else if (e instanceof Unavailable) result = unavailableResult(e.message);
      else if (e instanceof Broken) {
        if (!e.snapshot) broken.set(key, { error: e.message, until: e.until });
        result = { ...brokenResult(e.message, e.until), ...(e.snapshot && { snapshot: true }) };
      } else result = { ok: false, error: e.message };
    }
    jobs.delete(job.id);
    const waiters = job.waiters.filter(x => !x.done);
    if (!result.ok) {
      const whole = result.snapshot, answer = result;
      // A snapshot that didn't load fails its own requests (queued ones too), not those of the other snapshots that
      // asked for this frame; a broken segment fails every request for it.
      const hit = x => whole ? x.snapshotId === snapshotId : !result.broken || x.key === key;
      settle(waiters.filter(hit), answer);
      for (const x of waiters.filter(x => !hit(x))) enqueue(x);
      if (result.broken) for (const x of queuedWaiters()) if (whole ? x.snapshotId === snapshotId : x.key === key) drop(x, answer);
      // No browser: nothing queued can be painted either.
      if (result.unavailable) for (const x of queuedWaiters()) drop(x, answer);
      return;
    }
    // A requester whose current files differ from what the frame read gets a paint of its own, from its own snapshot.
    const again = [];
    for (const x of waiters) {
      if (Object.entries(result.deps).every(([p, sha]) => x.currentShas[p] === sha)) finish(x, { ok: true, depsHash: result.depsHash });
      else if (x.snapshotId === snapshotId) finish(x, { ok: false, error: 'the frame was painted with other files than its own' });
      else again.push(x);
    }
    for (const x of again) enqueue(x);
  }

  const stats = () => ({
    ...counts,
    painting: slots.filter(s => s.busy).length,
    pages: slots.filter(s => s.page).length,
    queued: [...jobs.values()].filter(j => j.state === 'queued')
      .flatMap(j => j.waiters.map(w => ({ versionId: w.versionId, prio: PRIORITIES[w.prio], key: j.key, frame: j.frame }))),
  });

  // Whether frames can be painted: { ok: false, reason } once the painting browser failed to start, until it starts.
  const health = () => ({ ok: !launchFailure, reason: launchFailure?.error ?? null });

  async function close() {
    closed = true;
    for (const job of [...jobs.values()]) if (job.state === 'queued') { jobs.delete(job.id); settle(job.waiters, { ok: false, error: 'the painting pool is closed' }); }
    const b = await browser?.catch(() => null);
    browser = null;
    await b?.close().catch(() => {});
  }

  return { request, supersede, stats, health, close };
}
