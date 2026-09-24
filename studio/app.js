// app.js: every URL the studio answers. Pages and the shared engine come from the repo (root), version code from the
// database, work folders and thumbnails from <data>/.studio/, finished videos from <data>/library/ (data defaults to root).
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { safeJoin, serveFile, json, error, makeGuard } from './http.js';
import { versionManifest, workManifest } from './versions.js';
import { parseStoryboard } from './storyboard.js';
import { isValidPath } from './db.js';

// Repo files anyone may load: the player, the shared engine, the libraries and the song. Nothing else.
const PUBLIC = [/^watch\.html$/, /^src\/[a-z0-9_]+\.js$/, /^node_modules\/p5\/lib\/[\w.-]+$/, /^node_modules\/p5\.brush\/dist\/[\w.-]+$/, /^assets\/pdoom\.mp3$/];
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const JOB_KINDS = ['storyboard', 'shared', 'chapter', 'render', 'thumbs'];
const NO_STORE = { 'cache-control': 'no-store' };

// Two kinds of origin. The studio's own (localhost, 127.0.0.1, [::1]) serves the page that carries the token and the
// UI; version code never runs there. studio.html, which runs version code, is served only on renderer origins
// (w0.localhost, w1.localhost, …), which have neither the token page nor the UI, and under a policy that keeps the
// code to this server (no requests elsewhere) and lets only studio pages frame it. Chrome rejects IPv6 literals in
// CSP source lists (and logs an error that would fail every render check), so [::1] can't be listed as a framer.
// No workers, frames or plugins either (p5 and p5.brush use none): a worker is a separate browser target, so its
// requests would bypass render.mjs's page-level interception, and a frame or object could hold a same-origin document
// served without this policy (any file under /src/), from which a worker could be started out of this policy's reach.
const onRenderer = req => /^w\d+\.localhost:\d+$/.test(req.headers.get('host') || '');
const studioCsp = port => ["default-src 'self'", "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:", "connect-src 'self'", "media-src 'self'", "worker-src 'none'", "frame-src 'none'", "object-src 'none'",
  "form-action 'none'", "base-uri 'none'",
  `frame-ancestors http://localhost:${port} http://127.0.0.1:${port} http://*.localhost:${port}`].join('; ');
// Whatever the CSP misses, a renderer host never serves a service worker or shared worker script: Chrome marks
// those fetches with Sec-Fetch-Dest, and every one of them is answered 404, whatever the path.
const WORKER_DESTS = ['serviceworker', 'sharedworker'];
// The only two /api endpoints chapter code needs (src/loader.js): everything else under /api/ is answered 404 on
// renderer hosts, so code running there can't read (or, were the guard ever to slip, write) anything through it.
const RENDERER_API_OK = [/^\/api\/versions\/[a-z0-9-]+$/, /^\/api\/work\/\d+$/];
const TOKEN_PAGE = { 'content-type': 'text/html; charset=utf-8', ...NO_STORE, 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" };

export function createApp({ db, root, data = root, token, queue, events, port = 8080, claudeBin = process.env.CLAUDE_BIN || 'claude', authTimeoutMs = 5000 }) {
  const app = { port };
  const guard = makeGuard({ port: () => app.port, token });
  const dirs = { ui: join(root, 'studio/ui'), work: join(data, '.studio/work'), library: join(data, 'library'), thumbs: join(data, '.studio/thumbs') };
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

  const routes = [
    ['GET', /^\/$/, req => onRenderer(req) ? error(404, 'not found')
      : new Response(readFileSync(join(dirs.ui, 'index.html'), 'utf8').replace('%%TOKEN%%', token), { headers: TOKEN_PAGE })],
    ['GET', /^\/ui\/(.+)$/, (req, [, p]) => onRenderer(req) ? error(404, 'not found') : file(req, dirs.ui, p, NO_STORE)],
    ['GET', /^\/studio\.html$/, req => onRenderer(req)
      ? file(req, root, 'studio.html', { 'content-security-policy': studioCsp(app.port) })
      : Response.redirect(`http://w0.localhost:${app.port}/studio.html${new URL(req.url).search}`, 302)],
    ['GET', /^\/v\/([a-z0-9-]+)\/(.+)$/, (req, [, id, p]) => {
      const f = isValidPath(p) && db.getFile(id, p);
      return f ? new Response(f.content, { headers: { 'content-type': TYPES[extname(p)], ...NO_STORE } }) : error(404, 'not found');
    }],
    ['GET', /^\/work\/(\d+)\/(.+)$/, (req, [, jid, p]) => isValidPath(p) ? file(req, join(dirs.work, jid), p, { 'content-type': TYPES[extname(p)], ...NO_STORE }) : error(404, 'not found')],
    ['GET', /^\/library\/(.+)$/, (req, [, p]) => file(req, dirs.library, p)],
    ['GET', /^\/thumbs\/(.+)$/, (req, [, p]) => file(req, dirs.thumbs, p, NO_STORE)],

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
      try {
        const v = db.promoteVersion(id);
        events.publish('version', { id: v.id });
        return json(v);
      } catch (e) { return error(409, e.message); }
    }],
    ['PUT', /^\/api\/versions\/([a-z0-9-]+)\/files\/STORYBOARD\.md$/, async (req, [, id]) => {
      const missing = needVersion(id); if (missing) return missing;
      const blocked = guardExample(id); if (blocked) return blocked;
      const b = await body(req);
      if (typeof b.content !== 'string') return error(400, 'content is required');
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
      if (['storyboard', 'shared', 'chapter'].includes(b.kind)) { const blocked = guardExample(b.versionId); if (blocked) return blocked; }
      if (b.kind === 'render') {
        const chapters = new Set(db.listFiles(b.versionId).map(f => /^ch\/c0(\d)/.exec(f.path)?.[1]).filter(Boolean)).size;
        if (chapters < 9) return error(409, `a final render needs all nine chapters (${chapters} of 9 are written)`);
        const [busy] = db.findJobs({ versionId: b.versionId, kinds: ['render'], statuses: ['queued', 'running'] });
        if (busy) return error(409, `a render of this version is already ${busy.status}`);
      }
      return json({ id: queue.enqueue({ kind: b.kind, versionId: b.versionId, params: b.params || {}, model: b.model || null }) }, 201);
    }],
    ['POST', /^\/api\/jobs\/(\d+)\/cancel$/, (req, [, jid]) => json({ ok: queue.cancel(+jid) })],
    ['POST', /^\/api\/jobs\/(\d+)\/retry$/, (req, [, jid]) => json({ id: queue.retry(+jid) })],
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

  app.fetch = async req => {
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
    if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC.some(r => r.test(path.slice(1)))) return file(req, root, path.slice(1));
    return error(404, 'not found');
  };
  return app;
}
