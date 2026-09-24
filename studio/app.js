// app.js: every URL the studio answers. Pages and the shared engine come from the repo, version code from the
// database, work folders and thumbnails from .studio/, finished videos from library/.
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { safeJoin, serveFile, json, error, makeGuard } from './http.js';
import { versionManifest, workManifest } from './versions.js';
import { parseStoryboard } from './storyboard.js';
import { isValidPath } from './db.js';

// Repo files anyone may load: the pages, the shared engine, the libraries and the song. Nothing else.
const PUBLIC = [/^studio\.html$/, /^watch\.html$/, /^src\/[a-z0-9_]+\.js$/, /^node_modules\/p5\/lib\/[\w.-]+$/, /^node_modules\/p5\.brush\/dist\/[\w.-]+$/, /^assets\/pdoom\.mp3$/];
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const JOB_KINDS = ['storyboard', 'shared', 'chapter', 'render', 'thumbs'];
const NO_STORE = { 'cache-control': 'no-store' };

export function createApp({ db, root, token, queue, events, port = 8080, claudeBin = process.env.CLAUDE_BIN || 'claude' }) {
  const app = { port };
  const guard = makeGuard({ port: () => app.port, token });
  const dirs = { ui: join(root, 'studio/ui'), work: join(root, '.studio/work'), library: join(root, 'library'), thumbs: join(root, '.studio/thumbs') };
  const body = async req => { try { return await req.json(); } catch { return {}; } };
  const file = (req, dir, rel, headers) => {
    let p; try { p = safeJoin(dir, decodeURIComponent(rel)); } catch { p = null; }
    return p ? serveFile(req, p, headers) : error(404, 'not found');
  };
  const needVersion = id => db.getVersion(id) ? null : error(404, 'no such version');

  const routes = [
    ['GET', /^\/$/, () => new Response(readFileSync(join(dirs.ui, 'index.html'), 'utf8').replace('%%TOKEN%%', token),
      { headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE } })],
    ['GET', /^\/ui\/(.+)$/, (req, [, p]) => file(req, dirs.ui, p, NO_STORE)],
    ['GET', /^\/v\/([a-z0-9-]+)\/(.+)$/, (req, [, id, p]) => {
      const f = isValidPath(p) && db.getFile(id, p);
      return f ? new Response(f.content, { headers: { 'content-type': TYPES[extname(p)], ...NO_STORE } }) : error(404, 'not found');
    }],
    ['GET', /^\/work\/(\d+)\/(.+)$/, (req, [, jid, p]) => isValidPath(p) ? file(req, join(dirs.work, jid), p, { 'content-type': TYPES[extname(p)], ...NO_STORE }) : error(404, 'not found')],
    ['GET', /^\/library\/(.+)$/, (req, [, p]) => file(req, dirs.library, p)],
    ['GET', /^\/thumbs\/(.+)$/, (req, [, p]) => file(req, dirs.thumbs, p, NO_STORE)],

    ['GET', /^\/api\/health$/, () => json({ claude: !!Bun.which(claudeBin.split(' ')[0]), ffmpeg: !!Bun.which('ffmpeg') })],
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
      return json({ ...m, concept: db.getVersion(id).concept, fileRevisions: Object.fromEntries(db.listFiles(id).map(f => [f.path, f.revision_id])),
        storyboardErrors: sb ? parseStoryboard(sb.content).errors : [] });
    }],
    ['GET', /^\/api\/versions\/([a-z0-9-]+)\/history$/, (req, [, id]) => json(db.history(id, null).map(({ content, ...r }) => r))],
    ['PUT', /^\/api\/versions\/([a-z0-9-]+)$/, async (req, [, id]) => {
      const missing = needVersion(id); if (missing) return missing;
      const b = await body(req), patch = Object.fromEntries(['title', 'concept', 'options'].filter(k => k in b).map(k => [k, b[k]]));
      if (!Object.keys(patch).length) return error(400, 'nothing to update');
      const v = db.updateVersion(id, patch); events.publish('version', { id }); return json(v);
    }],
    ['PUT', /^\/api\/versions\/([a-z0-9-]+)\/files\/STORYBOARD\.md$/, async (req, [, id]) => {
      const missing = needVersion(id); if (missing) return missing;
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
      const revision = db.restore(+rid); events.publish('version', { id: r.version_id }); return json({ revision });
    }],
    ['POST', /^\/api\/versions\/([a-z0-9-]+)\/approve$/, async (req, [, id]) => {
      const missing = needVersion(id); if (missing) return missing;
      const b = await body(req), sb = db.getFile(id, 'STORYBOARD.md');
      if (!sb) return error(409, 'there is no storyboard yet');
      const { errors } = parseStoryboard(sb.content);
      if (errors.length) return error(409, 'the storyboard is not valid: ' + errors.join('; '));
      return json({ jobs: queue.approve(id, b.model || null) });
    }],

    ['GET', /^\/api\/jobs$/, req => json(db.listJobs({ versionId: new URL(req.url).searchParams.get('version') }))],
    ['POST', /^\/api\/jobs$/, async req => {
      const b = await body(req);
      if (!JOB_KINDS.includes(b.kind)) return error(400, `kind must be one of ${JOB_KINDS.join(', ')}`);
      const missing = needVersion(b.versionId); if (missing) return missing;
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
    for (const [method, re, handler] of routes) {
      const m = re.exec(path);
      if (m && (req.method === method || (method === 'GET' && req.method === 'HEAD'))) {
        try { return await handler(req, m); } catch (e) { return error(500, e.message); }
      }
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC.some(r => r.test(path.slice(1)))) return file(req, root, path.slice(1));
    return error(404, 'not found');
  };
  return app;
}
