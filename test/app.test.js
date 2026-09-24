import { test, expect, beforeEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../studio/db.js';
import { importOriginal } from '../studio/versions.js';
import { createApp } from '../studio/app.js';
import { createEvents } from '../studio/events.js';
import { createQueue } from '../studio/queue.js';
import { goodStoryboard, tempDir } from './helpers.js';

const root = process.cwd();
let db, app, calls, data;
const H = { host: 'localhost:8080' }, W = { ...H, origin: 'http://localhost:8080', 'x-studio-token': 'tok', 'content-type': 'application/json' };
const get = p => app.fetch(new Request('http://localhost:8080' + p, { headers: H }));
const getOn = (host, p) => app.fetch(new Request(`http://${host}${p}`, { headers: { host } }));
const send = (method, p, body, headers = W) => app.fetch(new Request('http://localhost:8080' + p, { method, headers, body: body && JSON.stringify(body) }));

beforeEach(() => {
  db = openDb(':memory:'); calls = []; data = tempDir();
  const queue = {
    enqueue: j => { calls.push(['enqueue', j]); return 7; }, approve: (id, model) => { calls.push(['approve', id, model]); return [8, 9]; },
    cancel: id => { calls.push(['cancel', id]); return true; }, retry: id => { calls.push(['retry', id]); return 10; },
  };
  app = createApp({ db, root, data, token: 'tok', queue, events: createEvents(), port: 8080 });
});

test('the shell page carries the token and may not be framed', async () => {
  const res = await get('/');
  expect(await res.text()).toContain('content="tok"');
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
});

test('the token page and the UI are served on the studio hosts only, never where version code runs', async () => {
  for (const host of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080']) {
    expect((await getOn(host, '/')).status).toBe(200);
    expect((await getOn(host, '/ui/app.js')).status).toBe(200);
  }
  for (const host of ['w0.localhost:8080', 'w2.localhost:8080']) {
    const page = await getOn(host, '/');
    expect(page.status).toBe(404);
    expect(await page.text()).not.toContain('tok');
    expect((await getOn(host, '/ui/app.js')).status).toBe(404);
  }
});

test('studio.html runs only on w<n>.localhost, under a content security policy', async () => {
  for (const host of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080']) {
    const res = await getOn(host, '/studio.html?render&v=a');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://w0.localhost:8080/studio.html?render&v=a');
  }
  const res = await getOn('w1.localhost:8080', '/studio.html?v=a');
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('src/loader.js');
  const csp = Object.fromEntries(res.headers.get('content-security-policy').split(';').map(d => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  expect(csp['default-src']).toEqual(["'self'"]);
  expect(csp['script-src']).toEqual(["'self'", "'unsafe-inline'"]);
  expect(csp['style-src']).toEqual(["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']);
  expect(csp['font-src']).toEqual(["'self'", 'https://fonts.gstatic.com']);
  expect(csp['img-src']).toEqual(["'self'", 'data:', 'blob:']);
  expect(csp['connect-src']).toEqual(["'self'"]);
  expect(csp['media-src']).toEqual(["'self'"]);
  expect(csp['form-action']).toEqual(["'none'"]);
  expect(csp['base-uri']).toEqual(["'none'"]);
  expect(csp['frame-ancestors']).toEqual(['http://localhost:8080', 'http://127.0.0.1:8080', 'http://*.localhost:8080']);
});

test('worker hosts answer only the two API endpoints the loader needs; the rest of /api is 404 there', async () => {
  db.createVersion({ id: 'a' });
  const jid = db.addJob({ kind: 'chapter', versionId: 'a', params: { chapter: 1 } });
  mkdirSync(join(data, '.studio/work', String(jid)), { recursive: true });
  for (const host of ['w0.localhost:8080', 'w3.localhost:8080']) {
    expect((await getOn(host, '/api/versions/a')).status).toBe(200);
    expect((await getOn(host, `/api/work/${jid}`)).status).toBe(200);
    for (const p of ['/api/versions', '/api/jobs', `/api/jobs/${jid}`, '/api/health', '/api/library', '/api/events', '/api/versions/a/history']) {
      expect((await getOn(host, p)).status).toBe(404);
    }
  }
  // unaffected on the studio's own hosts
  expect((await get('/api/versions')).status).toBe(200);
  expect((await get(`/api/jobs/${jid}`)).status).toBe(200);
});

test('serves engine files but nothing private', async () => {
  expect((await getOn('w0.localhost:8080', '/studio.html')).status).toBe(200);
  expect((await get('/watch.html')).status).toBe(200);
  expect((await get('/src/core.js')).status).toBe(200);
  expect((await get('/node_modules/p5/lib/p5.min.js')).status).toBe(200);
  for (const p of ['/studio.db', '/.git/config', '/package.json', '/studio/db.js', '/src/../package.json']) expect((await get(p)).status).toBe(404);
});

test('changes need the token', async () => {
  expect((await send('POST', '/api/versions', { id: 'a' }, { ...H, origin: 'http://localhost:8080' })).status).toBe(403);
});

test('create, list and describe versions', async () => {
  expect((await send('POST', '/api/versions', { id: 'cooking-show', title: 'Bake-Off', concept: 'bake' })).status).toBe(201);
  expect((await send('POST', '/api/versions', { id: 'Bad Id' })).status).toBe(400);
  expect((await (await get('/api/versions')).json()).map(v => v.id)).toEqual(['cooking-show']);
  const m = await (await get('/api/versions/cooking-show')).json();
  expect(m).toMatchObject({ id: 'cooking-show', title: 'Bake-Off', concept: 'bake', scripts: [] });
  expect((await get('/api/versions/nope')).status).toBe(404);
  await send('PUT', '/api/versions/cooking-show', { options: { wipes: false }, title: 'New' });
  expect((await (await get('/api/versions/cooking-show')).json()).options.wipes).toBe(false);
});

test('manual storyboard edit updates title, logline and status, with history and restore', async () => {
  db.createVersion({ id: 'a' });
  await send('PUT', '/api/versions/a/files/STORYBOARD.md', { content: 'draft' });
  expect((await send('PUT', '/api/versions/a/files/STORYBOARD.md', { content: goodStoryboard() })).status).toBe(200);
  expect(db.getVersion('a')).toMatchObject({ title: 'The P(doom) Bake-Off', status: 'storyboard' });
  const revs = await (await get('/api/versions/a/revisions?path=STORYBOARD.md')).json();
  expect(revs).toHaveLength(2);
  expect(revs[0].content).toBeUndefined();
  expect((await (await get(`/api/revisions/${revs[1].id}`)).json()).content).toBe('draft');
  await send('POST', `/api/revisions/${revs[1].id}/restore`);
  expect(db.getFile('a', 'STORYBOARD.md').content).toBe('draft');
});

test('version files are served from the database', async () => {
  importOriginal(db, root);
  const res = await get('/v/original/ch/c01_lab.js');
  expect(res.headers.get('content-type')).toContain('javascript');
  expect(await res.text()).toContain("chapter('lab'");
  expect((await get('/v/original/../../studio.db')).status).toBe(404);
});

test('approve checks the storyboard first', async () => {
  db.createVersion({ id: 'a' }); db.updateVersion('a', { status: 'storyboard' });
  db.writeFiles('a', [{ path: 'STORYBOARD.md', content: 'not valid' }], { source: 'manual' });
  expect((await send('POST', '/api/versions/a/approve', {})).status).toBe(409);
  db.writeFiles('a', [{ path: 'STORYBOARD.md', content: goodStoryboard() }], { source: 'manual' });
  expect(await (await send('POST', '/api/versions/a/approve', { model: 'opus' })).json()).toEqual({ jobs: [8, 9] });
  expect(calls).toContainEqual(['approve', 'a', 'opus']);
});

test('approve works only on a storyboard waiting for it, and never while shared or chapter jobs run', async () => {
  db.createVersion({ id: 'a' });
  db.writeFiles('a', [{ path: 'STORYBOARD.md', content: goodStoryboard() }], { source: 'manual' });
  for (const status of ['concept', 'approved', 'chapters', 'ready']) {
    db.updateVersion('a', { status });
    expect((await send('POST', '/api/versions/a/approve', {})).status).toBe(409);
  }
  db.updateVersion('a', { status: 'storyboard' });
  for (const kind of ['shared', 'chapter']) for (const status of ['queued', 'running']) {
    const jid = db.addJob({ kind, versionId: 'a', params: { chapter: 1 } }); db.updateJob(jid, { status });
    const res = await send('POST', '/api/versions/a/approve', {});
    expect([res.status, (await res.json()).error]).toEqual([409, `a ${kind} job for this version is already ${status}`]);
    db.updateJob(jid, { status: 'failed' });
  }
  db.updateJob(db.addJob({ kind: 'storyboard', versionId: 'a' }), { status: 'running' });   // other kinds don't block
  expect((await send('POST', '/api/versions/a/approve', {})).status).toBe(200);
  expect(calls.filter(c => c[0] === 'approve')).toHaveLength(1);
});

test('approving twice queues the chapters once', async () => {
  const queue = createQueue({ db, events: createEvents(), runners: {} });   // not started: jobs stay queued
  app = createApp({ db, root, data, token: 'tok', queue, events: createEvents(), port: 8080 });
  db.createVersion({ id: 'a' }); db.updateVersion('a', { status: 'storyboard' });
  db.writeFiles('a', [{ path: 'STORYBOARD.md', content: goodStoryboard() }], { source: 'manual' });
  const [first, second] = await Promise.all([send('POST', '/api/versions/a/approve', {}), send('POST', '/api/versions/a/approve', {})]);
  expect([first.status, second.status].sort()).toEqual([200, 409]);
  expect(db.listJobs({ versionId: 'a' }).map(j => j.kind).sort()).toEqual(['chapter', 'chapter', 'chapter', 'chapter', 'chapter', 'chapter', 'chapter', 'chapter', 'chapter', 'shared']);
});

test('job lists leave the logs out; a single job comes with its log', async () => {
  db.createVersion({ id: 'a' });
  const jid = db.addJob({ kind: 'storyboard', versionId: 'a' }); db.appendLog(jid, 'hello log');
  for (const p of ['/api/jobs', '/api/jobs?version=a']) {
    const [j] = await (await get(p)).json();
    expect(j).toMatchObject({ id: jid, kind: 'storyboard', status: 'queued', params: {} });
    expect('log' in j).toBe(false);
  }
  expect(await (await get(`/api/jobs/${jid}`)).json()).toMatchObject({ id: jid, kind: 'storyboard', params: {}, log: 'hello log' });
  expect((await get('/api/jobs/999')).status).toBe(404);
});

test('a final render needs all nine chapters, and one render of a version at a time', async () => {
  db.createVersion({ id: 'a' });
  const chapter = n => ({ path: `ch/c0${n}.js`, content: `// ${n}` });
  db.writeFiles('a', [1, 2, 3, 4, 5, 6, 7, 8].map(chapter), { source: 'manual' });
  const render = () => send('POST', '/api/jobs', { kind: 'render', versionId: 'a' });
  let res = await render();
  expect([res.status, (await res.json()).error]).toEqual([409, 'a final render needs all nine chapters (8 of 9 are written)']);
  db.writeFiles('a', [chapter(9)], { source: 'manual' });
  expect((await render()).status).toBe(201);
  const jid = db.addJob({ kind: 'render', versionId: 'a' });
  for (const status of ['queued', 'running']) {
    db.updateJob(jid, { status });
    res = await render();
    expect([res.status, (await res.json()).error]).toEqual([409, `a render of this version is already ${status}`]);
  }
  db.updateJob(jid, { status: 'done' });
  expect((await render()).status).toBe(201);
});

test('health reports the tools, and whether the Claude CLI is signed in', async () => {
  const dir = tempDir('cli-'), calls = join(dir, 'calls');
  const cli = (name, body) => { writeFileSync(join(dir, name), body); return `bun ${join(dir, name)}`; };
  const health = async claudeBin => {
    app = createApp({ db, root, data, token: 'tok', queue: {}, events: createEvents(), port: 8080, claudeBin, authTimeoutMs: 500 });
    return (await get('/api/health')).json();
  };
  expect(await health(`bun ${join(root, 'test/fake-claude.js')}`)).toMatchObject({ claude: true, claudeSignedIn: true });
  const out = cli('out.js', `require('fs').appendFileSync(${JSON.stringify(calls)}, 'x'); console.log(JSON.stringify({ loggedIn: false })); process.exit(1);`);
  expect(await health(out)).toMatchObject({ claude: true, claudeSignedIn: false });
  await get('/api/health');                                   // cached for a minute: no second `claude auth status`
  expect(readFileSync(calls, 'utf8')).toBe('x');
  expect(await health(cli('hang.js', 'await Bun.sleep(5000);'))).toMatchObject({ claudeSignedIn: null });
  expect(await health(cli('junk.js', 'console.log("not json")'))).toMatchObject({ claudeSignedIn: null });
  expect(await health('no-such-claude-cli')).toMatchObject({ claude: false, claudeSignedIn: null });
});

test('jobs are handed to the queue', async () => {
  db.createVersion({ id: 'a' });
  expect((await send('POST', '/api/jobs', { kind: 'nonsense', versionId: 'a' })).status).toBe(400);
  expect((await send('POST', '/api/jobs', { kind: 'chapter', versionId: 'missing' })).status).toBe(404);
  expect(await (await send('POST', '/api/jobs', { kind: 'chapter', versionId: 'a', params: { chapter: 2, feedback: 'bigger' } })).json()).toEqual({ id: 7 });
  await send('POST', '/api/jobs/7/cancel'); await send('POST', '/api/jobs/7/retry');
  expect(calls.map(c => c[0])).toEqual(['enqueue', 'cancel', 'retry']);
});

test('library lists renders and deleting removes the files', async () => {
  mkdirSync(join(data, 'library'), { recursive: true });
  writeFileSync(join(data, 'library', 'zz-test.mp4'), 'mp4'); writeFileSync(join(data, 'library', 'zz-test.jpg'), 'jpg');
  db.createVersion({ id: 'a', title: 'A' });
  const rid = db.addRender({ versionId: 'a', file: 'zz-test.mp4', revisionIds: [], durationS: 1, renderS: 1, sizeBytes: 3, poster: 'zz-test.jpg' });
  expect((await (await get('/api/library')).json())[0]).toMatchObject({ id: rid, title: 'A' });
  expect((await get('/library/zz-test.mp4')).status).toBe(200);
  await send('DELETE', `/api/library/${rid}`);
  expect(existsSync(join(data, 'library', 'zz-test.mp4'))).toBe(false);
  expect(db.listRenders()).toEqual([]);
});

test('version responses carry storyboard errors, and the whole history', async () => {
  db.createVersion({ id: 'a' });
  db.writeFiles('a', [{ path: 'STORYBOARD.md', content: 'nope' }], { source: 'manual', note: 'first try' });
  db.writeFiles('a', [{ path: 'ch/c01.js', content: '//' }], { source: 'claude', note: 'make it pop' });
  expect((await (await get('/api/versions/a')).json()).storyboardErrors).toContain('expected 9 chapters, found 0');
  const hist = await (await get('/api/versions/a/history')).json();
  expect(hist.map(r => [r.path, r.note])).toEqual([['ch/c01.js', 'make it pop'], ['STORYBOARD.md', 'first try']]);
  expect(hist[0].content).toBeUndefined();
});

test('the legacy-format Original never shows storyboard errors', async () => {
  importOriginal(db, root);
  expect((await (await get('/api/versions/original')).json()).storyboardErrors).toEqual([]);
});

test('work folders are served while a job runs', async () => {
  db.createVersion({ id: 'a' });
  const jid = db.addJob({ kind: 'chapter', versionId: 'a', params: { chapter: 1 } });
  const dir = join(data, '.studio/work', String(jid));
  mkdirSync(join(dir, 'ch'), { recursive: true }); writeFileSync(join(dir, 'ch/c01.js'), '// c1');
  expect((await (await get(`/api/work/${jid}`)).json()).scripts).toEqual(['ch/c01.js']);
  expect(await (await get(`/work/${jid}/ch/c01.js`)).text()).toBe('// c1');
  expect((await get(`/work/${jid}/TASK.md`)).status).toBe(404);
});
