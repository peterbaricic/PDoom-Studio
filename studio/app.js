// app.js: every URL the studio answers. Pages and the shared engine come from the repo (root), version code from the
// database, work folders and thumbnails from <data>/.studio/, finished videos from <data>/library/ (data defaults to root).
import { readFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { safeJoin, serveFile, json, error, makeGuard } from './http.js';
import { versionManifest, workManifest } from './versions.js';
import { parseStoryboard, CHAPTER_WINDOWS } from './storyboard.js';
import { isValidPath } from './db.js';
import { getSnapshot, blobBySha } from './snapshot.js';
import { N, FPS, DURATION } from './frames/keys.js';

// Repo files anyone may load: the player, the shared engine, the libraries, the song and the bundled fonts. Nothing else.
const PUBLIC = [/^watch\.html$/, /^src\/[a-z0-9_]+\.js$/, /^node_modules\/p5\/lib\/[\w.-]+$/, /^node_modules\/p5\.brush\/dist\/[\w.-]+$/, /^assets\/pdoom\.mp3$/,
  /^assets\/fonts\/[\w.-]+\.(?:css|woff2)$/];
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const JOB_KINDS = ['storyboard', 'shared', 'chapter', 'render', 'thumbs'];
const CLAUDE_KINDS = ['storyboard', 'shared', 'chapter'];   // the kinds that write the version's files
const NO_STORE = { 'cache-control': 'no-store' };
const IMMUTABLE = { 'cache-control': 'public, max-age=31536000, immutable' };
// The React app (studio/web/, built by Vite into studio/web/dist — see studio/build-web.js): the studio's UI. It
// carries the token exactly as the old studio/ui/ page did, under a CSP strict enough that the Vite build must not
// emit an inline script (constraints.md): no unsafe-inline anywhere, and nothing may load from another origin.
const SPA_CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' blob: data:", "media-src 'self'",
  "font-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"].join('; ');
// The SPA's own routes (docs/superpowers/specs/2026-09-25-react-studio-design.md, section 2): the server answers all
// of these with the built index.html, same as "/". studio/web/router.tsx handles "/" itself (client-side redirect).
const VERSION_ID = '[a-z0-9][a-z0-9-]{0,40}';
const SPA_ROUTES = [/^\/$/, new RegExp(`^/versions/${VERSION_ID}$`), new RegExp(`^/versions/${VERSION_ID}/watch$`), /^\/library$/];

// Two kinds of origin. The studio's own (localhost, 127.0.0.1, [::1]) serves the page that carries the token and the
// UI; version code never runs there. studio.html, which runs version code, is served only on renderer origins
// (w0.localhost, w1.localhost, …), which have neither the token page nor the UI, and under a policy that keeps the
// code to this server (no requests elsewhere) and lets only studio pages frame it. Chrome rejects IPv6 literals in
// CSP source lists (and logs an error that would fail every render check), so [::1] can't be listed as a framer.
// No workers, frames or plugins either (p5 and p5.brush use none): a worker is a separate browser target, so its
// requests would bypass render.mjs's page-level interception, and a frame or object could hold a same-origin document
// from which a worker could be started out of this policy's reach.
// No inline script: studio.html has none, and allowing it would let chapter code add its own, speculation rules
// included (a prefetch or prerender of any URL). Inline style stays allowed (studio.html's <style>, and p5 sets style
// attributes); what CSS can load is still limited by img-src, font-src and style-src.
// Sandboxed, which matters in the user's own browser, where the player's workers run chapter code with none of the
// render browser's network isolation (studio/browser.js): no popups (not even after a user gesture), top-level
// navigation, downloads or form submissions. It keeps scripts, its own origin (the loader's same-origin fetches, the
// player's postMessage origin checks) and modal dialogs, without which Chrome silently skips render.mjs's
// beforeunload guard.
const onRenderer = req => /^w\d+\.localhost:\d+$/.test(req.headers.get('host') || '');
const studioCsp = port => ["default-src 'self'", "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", "font-src 'self'",
  "img-src 'self' data: blob:", "connect-src 'self'", "media-src 'self'", "worker-src 'none'", "frame-src 'none'", "object-src 'none'",
  "form-action 'none'", "base-uri 'none'",
  `frame-ancestors http://localhost:${port} http://127.0.0.1:${port} http://*.localhost:${port}`,
  'sandbox allow-scripts allow-same-origin allow-modals'].join('; ');
// Everything else a renderer host answers (watch.html, the engine scripts and libraries, version files, JSON, errors)
// is only ever meant as a subresource of studio.html, but chapter code could open or frame any of it as a page of its
// own origin, whose window would have an unrestricted fetch, Image and Worker. So each carries a policy that makes it,
// as a page, a sandboxed opaque origin that can load nothing, and nosniff keeps a script from being taken for a page.
// (A policy on a script, style, media or fetch response is ignored when it's loaded as what it is.)
const LOCKED_DOWN_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'";
const lockDown = res => {
  res.headers.set('x-content-type-options', 'nosniff');
  if (!res.headers.has('content-security-policy')) res.headers.set('content-security-policy', LOCKED_DOWN_CSP);
  return res;
};
// Whatever the CSP misses, a renderer host never serves a service worker or shared worker script: Chrome marks
// those fetches with Sec-Fetch-Dest, and every one of them is answered 404, whatever the path.
const WORKER_DESTS = ['serviceworker', 'sharedworker'];
// The /api endpoints chapter code needs (src/loader.js): everything else under /api/ is answered 404 on renderer
// hosts, so code running there can't read (or, were the guard ever to slip, write) anything through it.
const RENDERER_API_OK = [/^\/api\/versions\/[a-z0-9-]+$/, /^\/api\/work\/\d+$/, /^\/api\/snapshot\/[0-9a-f]{64}$/, /^\/api\/blob\/[0-9a-f]{64}$/];
const TOKEN_PAGE = { 'content-type': 'text/html; charset=utf-8', ...NO_STORE, 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" };

// frames: the frame service (studio/frames/service.js); without one, the frame and cache routes 404. frameHoldMs: how
// long a frame request waits for its frame to be painted before answering 202 (ask again). dev: accept the Vite dev
// server's origin too (studio/server.js's --dev; never set by `bun run studio`).
export function createApp({ db, root, data = root, token, queue, events, port = 8080, claudeBin = process.env.CLAUDE_BIN || 'claude', authTimeoutMs = 5000,
  frames = null, frameHoldMs = 30000, dev = false }) {
  const app = { port };
  const guard = makeGuard({ port: () => app.port, token, extraOrigins: dev ? ['http://localhost:5173'] : [] });
  const dirs = { ui: join(root, 'studio/ui'), web: join(root, 'studio/web/dist'), work: join(data, '.studio/work'),
    library: join(data, 'library'), thumbs: join(data, '.studio/thumbs') };
  // GET /api/song: the engine's fixed timing (studio/frames/keys.js) plus every lyric line, for the timeline and
  // lyrics track. src/lyrics.js is a plain script (no export — it's loaded as a <script> by studio.html/src/timeline.js
  // in the browser), so it's evaluated once here in its own Function scope to pull LY out of it; it's a trusted repo
  // file, not version code, so this is unlike the sandboxing chapter code gets.
  const LY = new Function(`${readFileSync(join(root, 'src/lyrics.js'), 'utf8')}\nreturn LY;`)();
  const song = { fps: FPS, frames: N, duration: DURATION, chapters: CHAPTER_WINDOWS, lyrics: LY };
  const body = async req => { try { return await req.json(); } catch { return {}; } };
  const file = (req, dir, rel, headers) => {
    let p; try { p = safeJoin(dir, decodeURIComponent(rel)); } catch { p = null; }
    return p ? serveFile(req, p, headers) : error(404, 'not found');
  };
  const needVersion = id => db.getVersion(id) ? null : error(404, 'no such version');
  // Guards the handful of writes examples must refuse. Called after needVersion, so the version is known to exist.
  const guardExample = id => db.getVersion(id)?.example ? error(403, 'examples are read-only — remix it first') : null;

  // Whether the Claude CLI is signed in (`claude auth status` prints JSON with loggedIn): true, false, or null when
  // that can't be told (no CLI, no answer within the timeout, unexpected output). Asked at most once a minute.
  let signedIn = { at: -Infinity, value: null, pending: null };
  const claudeSignedIn = () => {
    if (Date.now() - signedIn.at < 60000) return signedIn.value;
    signedIn.pending ??= (async () => {
      let p;
      try { p = Bun.spawn([...claudeBin.split(' '), 'auth', 'status'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' }); } catch { return null; }
      const timer = setTimeout(() => p.kill(9), authTimeoutMs);
      const out = await new Response(p.stdout).text();
      clearTimeout(timer);
      try { const { loggedIn } = JSON.parse(out); return typeof loggedIn === 'boolean' ? loggedIn : null; } catch { return null; }
    })().then(value => { signedIn = { at: Date.now(), value, pending: null }; return value; });
    return signedIn.pending;
  };

  // The SPA shell (studio/web/dist/index.html, built by Vite — studio/build-web.js): "/" and every SPA route
  // (SPA_ROUTES) get it, carrying the token exactly as the token page always has, under the strict SPA_CSP. UI hosts
  // only — chapter code has no business loading the studio's own UI, any more than the reverse.
  const spaShell = req => onRenderer(req) ? error(404, 'not found') : new Response(
    readFileSync(join(dirs.web, 'index.html'), 'utf8').replace('%%TOKEN%%', token),
    { headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE, 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'content-security-policy': SPA_CSP } });

  const routes = [
    ...SPA_ROUTES.map(re => ['GET', re, req => spaShell(req)]),
    // Vite's hashed build output (studio/web/dist/app-assets/…): safe to cache forever, since a changed file gets a
    // new name. Named app-assets, not assets, so it can never collide with the repo's own /assets/ (PUBLIC, below).
    ['GET', /^\/app-assets\/(.+)$/, (req, [, p]) => onRenderer(req) ? error(404, 'not found') : file(req, join(dirs.web, 'app-assets'), p, IMMUTABLE)],
    // The old plain-JS UI (studio/ui/): kept reachable at /ui/ until it's removed (see the design doc's build order,
    // step 10) — it used to be served at "/", which the SPA now owns.
    ['GET', /^\/ui\/?$/, req => onRenderer(req) ? error(404, 'not found')
      : new Response(readFileSync(join(dirs.ui, 'index.html'), 'utf8').replace('%%TOKEN%%', token), { headers: TOKEN_PAGE })],
    ['GET', /^\/ui\/(.+)$/, (req, [, p]) => onRenderer(req) ? error(404, 'not found') : file(req, dirs.ui, p, NO_STORE)],
    ['GET', /^\/api\/song$/, () => json(song)],
    ['GET', /^\/studio\.html$/, req => onRenderer(req)
      ? file(req, root, 'studio.html', { 'content-security-policy': studioCsp(app.port) })
      : Response.redirect(`http://w0.localhost:${app.port}/studio.html${new URL(req.url).search}`, 302)],
    ['GET', /^\/v\/([a-z0-9-]+)\/(.+)$/, (req, [, id, p]) => {
      const f = isValidPath(p) && db.getFile(id, p);
      return f ? new Response(f.content, { headers: { 'content-type': TYPES[extname(p)], ...NO_STORE } }) : error(404, 'not found');
    }],
    ['GET', /^\/work\/(\d+)\/(.+)$/, (req, [, jid, p]) => isValidPath(p) ? file(req, join(dirs.work, jid), p, { 'content-type': TYPES[extname(p)], ...NO_STORE }) : error(404, 'not found')],
    // Content-addressed code, for painting pages only (studio.html?render&snapshot=<id>, via src/loader.js): a
    // snapshot manifest and the blobs its scripts point at. Both renderer-host only — a UI host has no business
    // asking for version code, snapshotted or not — so this is refused before RENDERER_API_OK is even consulted.
    ['GET', /^\/api\/snapshot\/([0-9a-f]{64})$/, (req, [, id]) => {
      if (!onRenderer(req)) return error(404, 'not found');
      const snap = getSnapshot(id);
      if (!snap) return error(404, 'no such snapshot');
      const paths = Object.keys(snap.files).sort();
      const scriptPaths = [...(snap.files['shared.js'] ? ['shared.js'] : []), ...paths.filter(p => p.startsWith('ch/'))];
      // paths names each script (scripts[i] is paths[i]'s blob), for the painting page's CAST recording.
      return json({ id: snap.id, options: snap.options, scripts: scriptPaths.map(p => `/api/blob/${snap.files[p]}`), paths: scriptPaths, files: paths });
    }],
    ['GET', /^\/api\/blob\/([0-9a-f]{64})$/, (req, [, sha]) => {
      if (!onRenderer(req)) return error(404, 'not found');
      const content = blobBySha(db, sha);
      return content == null ? error(404, 'no such blob') : new Response(content, { headers: { 'content-type': TYPES['.js'], ...NO_STORE } });
    }],
    ['GET', /^\/library\/(.+)$/, (req, [, p]) => file(req, dirs.library, p)],
    ['GET', /^\/thumbs\/(.+)$/, (req, [, p]) => file(req, dirs.thumbs, p, NO_STORE)],

    // Frames, painted by the server (chapter code never runs in the user's browser), and the cache they live in: UI
    // hosts only. A frame's URL names a version, not content, so it's revalidated on every use: its ETag names the
    // frame's content (segment key and the dependencies it was painted with), and a match is answered 304.
    ['GET', /^\/api\/frames\/([a-z0-9-]+)\/(\d+)\.jpg$/, async (req, [, id, i]) => {
      if (onRenderer(req) || !frames || +i >= N) return error(404, 'not found');
      const prio = new URL(req.url).searchParams.get('prio') === 'prefetch' ? 'prefetch' : 'preview';
      // Held while it's painted, up to frameHoldMs; a request that gives up (the client going away, or the hold
      // running out) is withdrawn from the painting queue.
      const withdraw = new AbortController(), giveUp = () => withdraw.abort();
      req.signal?.addEventListener('abort', giveUp);
      const timer = setTimeout(giveUp, frameHoldMs);
      let r;
      try {
        r = frames.frame(id, +i, prio, { signal: withdraw.signal });
        if (r.pending) r = await r.pending;
      } finally { clearTimeout(timer); req.signal?.removeEventListener('abort', giveUp); }
      if (r.missing) return error(404, r.missing);
      if (r.broken) return error(409, r.broken);
      const got = r.file && await frames.read(id, +i);
      if (!got) return new Response(null, { status: 202, headers: { 'retry-after': '1', ...NO_STORE } });
      const headers = { etag: `"${got.key}.${got.depsHash}"`, 'cache-control': 'private, no-cache' };
      if ((req.headers.get('if-none-match') || '').split(',').some(t => t.trim().replace(/^W\//, '') === headers.etag)) return new Response(null, { status: 304, headers });
      return new Response(got.bytes, { headers: { 'content-type': 'image/jpeg', ...headers } });
    }],
    // Paint the rest of the version from `from` in the background (the preview player's look-ahead past what it
    // fetches itself): answered at once; progress shows as `frames` events. A new call re-aims the version's sweep.
    ['POST', /^\/api\/frames\/([a-z0-9-]+)\/paint-ahead$/, async (req, [, id]) => {
      if (onRenderer(req) || !frames) return error(404, 'not found');
      const missing = needVersion(id); if (missing) return missing;
      const { from } = await body(req);
      if (!Number.isInteger(from) || from < 0 || from >= N) return error(400, `from must be a frame index (0..${N - 1})`);
      const r = frames.paintAhead(id, from);
      return r ? json(r) : error(404, 'no such version');
    }],
    ['GET', /^\/api\/coverage\/([a-z0-9-]+)$/, (req, [, id]) => {
      if (onRenderer(req) || !frames) return error(404, 'not found');
      const c = frames.coverage(id);
      return c ? json(c) : error(404, 'no such version');
    }],
    ['GET', /^\/api\/cache$/, req => onRenderer(req) || !frames ? error(404, 'not found')
      : json({ usedBytes: frames.cache.usedBytes(), capBytes: frames.cache.capBytes })],
    ['POST', /^\/api\/cache\/clear$/, req => {
      if (onRenderer(req) || !frames) return error(404, 'not found');
      frames.cache.clear();
      return json({ usedBytes: frames.cache.usedBytes(), capBytes: frames.cache.capBytes });
    }],

    ['GET', /^\/api\/health$/, async () => {
      const claude = !!Bun.which(claudeBin.split(' ')[0]);
      return json({ claude, claudeSignedIn: claude ? await claudeSignedIn() : null, ffmpeg: !!Bun.which('ffmpeg') });
    }],
    ['GET', /^\/api\/events$/, req => events.stream(req)],

    ['GET', /^\/api\/versions$/, () => json(db.listVersions().map(v => ({ ...v, chapters: db.listFiles(v.id).filter(f => f.path.startsWith('ch/')).length })))],
    ['POST', /^\/api\/versions$/, async req => {
      const b = await body(req);
      try { const v = db.createVersion({ id: b.id, title: b.title, concept: b.concept, options: b.options }); events.publish('version', { id: v.id }); return json(v, 201); }
      catch (e) { return error(400, e.message); }
    }],
    ['GET', /^\/api\/versions\/([a-z0-9-]+)$/, (req, [, id]) => {
      const m = versionManifest(db, id);
      if (!m) return error(404, 'no such version');
      const sb = db.getFile(id, 'STORYBOARD.md');
      // walkthrough.json only exists on versions imported in the legacy format (currently just Original), whose
      // STORYBOARD.md predates the studio's stricter format and will never parse clean; don't flag it as broken.
      return json({ ...m, concept: db.getVersion(id).concept, fileRevisions: Object.fromEntries(db.listFiles(id).map(f => [f.path, f.revision_id])),
        storyboardErrors: sb && !m.files.includes('walkthrough.json') ? parseStoryboard(sb.content).errors : [] });
    }],
    ['GET', /^\/api\/versions\/([a-z0-9-]+)\/history$/, (req, [, id]) => json(db.history(id, null).map(({ content, ...r }) => r))],
    ['PUT', /^\/api\/versions\/([a-z0-9-]+)$/, async (req, [, id]) => {
      const missing = needVersion(id); if (missing) return missing;
      const blocked = guardExample(id); if (blocked) return blocked;
      const b = await body(req), patch = Object.fromEntries(['title', 'concept', 'options'].filter(k => k in b).map(k => [k, b[k]]));
      if (!Object.keys(patch).length) return error(400, 'nothing to update');
      const v = db.updateVersion(id, patch); events.publish('version', { id }); return json(v);
    }],
    ['POST', /^\/api\/versions\/([a-z0-9-]+)\/remix$/, async (req, [, fromId]) => {
      const missing = needVersion(fromId); if (missing) return missing;
      const b = await body(req);
      try {
        const v = db.remixVersion(fromId, { id: b.id, title: b.title });
        events.publish('version', { id: v.id });
        return json(v, 201);
      } catch (e) { return error(/already exists/.test(e.message) ? 409 : 400, e.message); }
    }],
    ['POST', /^\/api\/versions\/([a-z0-9-]+)\/promote$/, (req, [, id]) => {
      const missing = needVersion(id); if (missing) return missing;
      // A Claude job still to finish would write into what is by then a read-only example: it has to end first.
      const [busy] = db.findJobs({ versionId: id, kinds: CLAUDE_KINDS, statuses: ['queued', 'running'] });
      if (busy) return error(409, `a ${busy.kind} job for this version is still ${busy.status} — let it finish or cancel it first`);
      try {
        const v = db.promoteVersion(id);
        events.publish('version', { id: v.id });
        return json(v);
      } catch (e) { return error(409, e.message); }
    }],
    // Deletes one of the user's own versions: its files, revisions and jobs, its thumbnails, and whatever the frame
    // service still had queued for it (frames already cached age out of the cache like any other). videos=1 deletes
    // its renders and their files too (inside the library only, as DELETE /api/library/:rid does); without it they
    // stay in the library under the version's last title. Refused for an example (403) and while a job of the
    // version is queued or running (409): the job would go on writing to, or rendering, a version that's gone.
    ['DELETE', /^\/api\/versions\/([a-z0-9-]+)$/, (req, [, id]) => {
      const missing = needVersion(id); if (missing) return missing;
      const blocked = guardExample(id); if (blocked) return blocked;
      const flag = new URL(req.url).searchParams.get('videos') ?? '0';
      if (!['0', '1'].includes(flag)) return error(400, 'videos must be 0 or 1');
      let deletedRenders;
      try { ({ deletedRenders } = db.deleteVersion(id, { videos: flag === '1' })); }
      catch (e) { return error(/still (queued|running)/.test(e.message) ? 409 : 400, e.message); }
      for (const f of deletedRenders) { const p = safeJoin(dirs.library, f); if (p) unlinkSync(p); }
      rmSync(join(dirs.thumbs, id), { recursive: true, force: true });
      frames?.dropVersion(id);
      events.publish('version', { id });
      events.publish('library', {});
      return json({ ok: true });
    }],
    ['PUT', /^\/api\/versions\/([a-z0-9-]+)\/files\/STORYBOARD\.md$/, async (req, [, id]) => {
      const missing = needVersion(id); if (missing) return missing;
      const blocked = guardExample(id); if (blocked) return blocked;
      const b = await body(req);
      if (typeof b.content !== 'string') return error(400, 'content is required');
      // Optimistic concurrency: baseRevision names the revision the edit started from (null: there was no storyboard
      // yet). If Claude (or another tab) wrote the file since, the edit would silently undo that, so it's refused.
      // Everything from here to the write runs synchronously, so nothing can slip in between the check and the write.
      // Without baseRevision the write is unconditional, as it always was.
      if ('baseRevision' in b) {
        if (b.baseRevision !== null && !Number.isInteger(b.baseRevision)) return error(400, 'baseRevision must be a revision id or null');
        const current = db.getFile(id, 'STORYBOARD.md')?.revision_id ?? null;
        if (current !== b.baseRevision) return error(409, 'the storyboard changed since you started editing it — reload it to see the new text');
      }
      const [rid] = db.writeFiles(id, [{ path: 'STORYBOARD.md', content: b.content }], { source: 'manual', note: b.note || 'edited by hand' });
      const sb = parseStoryboard(b.content), v = db.getVersion(id), patch = {};
      if (sb.title) patch.title = sb.title;
      if (sb.logline) patch.logline = sb.logline;
      if (v.status === 'concept') patch.status = 'storyboard';
      if (Object.keys(patch).length) db.updateVersion(id, patch);
      events.publish('version', { id });
      return json({ revision: rid ?? null, errors: sb.errors });
    }],
    ['GET', /^\/api\/versions\/([a-z0-9-]+)\/revisions$/, (req, [, id]) =>
      json(db.history(id, new URL(req.url).searchParams.get('path') || '').map(({ content, ...r }) => r))],
    ['GET', /^\/api\/revisions\/(\d+)$/, (req, [, rid]) => { const r = db.getRevision(+rid); return r ? json(r) : error(404, 'no such revision'); }],
    ['POST', /^\/api\/revisions\/(\d+)\/restore$/, (req, [, rid]) => {
      const r = db.getRevision(+rid); if (!r) return error(404, 'no such revision');
      const blocked = guardExample(r.version_id); if (blocked) return blocked;
      const revision = db.restore(+rid); events.publish('version', { id: r.version_id }); return json({ revision });
    }],
    ['POST', /^\/api\/versions\/([a-z0-9-]+)\/approve$/, async (req, [, id]) => {
      const missing = needVersion(id); if (missing) return missing;
      const blocked = guardExample(id); if (blocked) return blocked;
      // Everything after this await runs synchronously up to queue.approve (which sets the status to approved), so
      // two approvals sent at once can't both get through.
      const b = await body(req), sb = db.getFile(id, 'STORYBOARD.md');
      if (!sb) return error(409, 'there is no storyboard yet');
      const { errors } = parseStoryboard(sb.content);
      if (errors.length) return error(409, 'the storyboard is not valid: ' + errors.join('; '));
      const { status } = db.getVersion(id);
      if (status !== 'storyboard') return error(409, `this version is past approval (${status})`);
      const [busy] = db.findJobs({ versionId: id, kinds: ['shared', 'chapter'], statuses: ['queued', 'running'] });
      if (busy) return error(409, `a ${busy.kind} job for this version is already ${busy.status}`);
      return json({ jobs: queue.approve(id, b.model || null) });
    }],

    ['GET', /^\/api\/jobs$/, req => json(db.listJobs({ versionId: new URL(req.url).searchParams.get('version') }))],
    ['GET', /^\/api\/jobs\/(\d+)$/, (req, [, jid]) => { const j = db.getJob(+jid); return j ? json(j) : error(404, 'no such job'); }],
    ['POST', /^\/api\/jobs$/, async req => {
      const b = await body(req);
      if (!JOB_KINDS.includes(b.kind)) return error(400, `kind must be one of ${JOB_KINDS.join(', ')}`);
      const missing = needVersion(b.versionId); if (missing) return missing;
      if (CLAUDE_KINDS.includes(b.kind)) { const blocked = guardExample(b.versionId); if (blocked) return blocked; }
      if (b.kind === 'render') {
        const chapters = new Set(db.listFiles(b.versionId).map(f => /^ch\/c0(\d)/.exec(f.path)?.[1]).filter(Boolean)).size;
        if (chapters < 9) return error(409, `a final render needs all nine chapters (${chapters} of 9 are written)`);
        const [busy] = db.findJobs({ versionId: b.versionId, kinds: ['render'], statuses: ['queued', 'running'] });
        if (busy) return error(409, `a render of this version is already ${busy.status}`);
      }
      return json({ id: queue.enqueue({ kind: b.kind, versionId: b.versionId, params: b.params || {}, model: b.model || null }) }, 201);
    }],
    ['POST', /^\/api\/jobs\/(\d+)\/cancel$/, (req, [, jid]) => json({ ok: queue.cancel(+jid) })],
    ['POST', /^\/api\/jobs\/(\d+)\/retry$/, (req, [, jid]) => {
      const j = db.getJob(+jid);
      if (j && CLAUDE_KINDS.includes(j.kind)) { const blocked = guardExample(j.version_id); if (blocked) return blocked; }
      return json({ id: queue.retry(+jid) });
    }],
    ['GET', /^\/api\/work\/(\d+)$/, (req, [, jid]) => {
      const j = db.getJob(+jid), dir = join(dirs.work, jid);
      return j && existsSync(dir) ? json(workManifest(dir, db.getVersion(j.version_id))) : error(404, 'no such work folder');
    }],

    ['GET', /^\/api\/library$/, () => json(db.listRenders())],
    ['DELETE', /^\/api\/library\/(\d+)$/, (req, [, rid]) => {
      const r = db.getRender(+rid); if (!r) return error(404, 'no such render');
      for (const f of [r.file, r.poster]) { const p = f && safeJoin(dirs.library, f); if (p) unlinkSync(p); }
      db.deleteRender(+rid); events.publish('library', {}); return json({ ok: true });
    }],
  ];

  const answer = async req => {
    const denied = guard(req); if (denied) return denied;
    const path = new URL(req.url).pathname;
    if (onRenderer(req) && WORKER_DESTS.includes(req.headers.get('sec-fetch-dest'))) return error(404, 'not found');
    if (onRenderer(req) && path.startsWith('/api/') && !((req.method === 'GET' || req.method === 'HEAD') && RENDERER_API_OK.some(re => re.test(path)))) {
      return error(404, 'not found');
    }
    for (const [method, re, handler] of routes) {
      const m = re.exec(path);
      if (m && (req.method === method || (method === 'GET' && req.method === 'HEAD'))) {
        try { return await handler(req, m); }
        catch (e) { return e.message === 'examples are read-only' ? error(403, 'examples are read-only — remix it first') : error(500, e.message); }
      }
    }
    // Test-only: simulates the font files failing to load (fonts.css itself still loads, so the @font-face rules
    // are registered — 404ing fonts.css instead would leave document.fonts with no matching face at all, and
    // document.fonts.check() trivially returns true for a family it has never heard of), so render.mjs --check can
    // be proven to fail on a missing font.
    if (process.env.STUDIO_TEST_BREAK_FONTS && /^\/assets\/fonts\/.*\.woff2$/.test(path)) return error(404, 'not found');
    if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC.some(r => r.test(path.slice(1)))) return file(req, root, path.slice(1));
    return error(404, 'not found');
  };
  app.fetch = async req => onRenderer(req) ? lockDown(await answer(req)) : answer(req);
  return app;
}
