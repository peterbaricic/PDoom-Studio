import { test, expect, beforeEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../studio/db.js';
import { importOriginal } from '../studio/versions.js';
import { createApp } from '../studio/app.js';
import { createEvents } from '../studio/events.js';
import { goodStoryboard, tempDir } from './helpers.js';

const root = process.cwd();
let db, app, calls, data;
const H = { host: 'localhost:8080' }, W = { ...H, origin: 'http://localhost:8080', 'x-studio-token': 'tok', 'content-type': 'application/json' };
const get = p => app.fetch(new Request('http://localhost:8080' + p, { headers: H }));
const send = (method, p, body, headers = W) => app.fetch(new Request('http://localhost:8080' + p, { method, headers, body: body && JSON.stringify(body) }));

beforeEach(() => {
  db = openDb(':memory:'); calls = []; data = tempDir();
  const queue = {
    enqueue: j => { calls.push(['enqueue', j]); return 7; }, approve: (id, model) => { calls.push(['approve', id, model]); return [8, 9]; },
    cancel: id => { calls.push(['cancel', id]); return true; }, retry: id => { calls.push(['retry', id]); return 10; },
  };
  app = createApp({ db, root, data, token: 'tok', queue, events: createEvents(), port: 8080 });
});

test('the shell page carries the token', async () => {
  expect(await (await get('/')).text()).toContain('content="tok"');
});

test('serves engine files but nothing private', async () => {
  expect((await get('/studio.html')).status).toBe(200);
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
  db.createVersion({ id: 'a' });
  db.writeFiles('a', [{ path: 'STORYBOARD.md', content: 'not valid' }], { source: 'manual' });
  expect((await send('POST', '/api/versions/a/approve', {})).status).toBe(409);
  db.writeFiles('a', [{ path: 'STORYBOARD.md', content: goodStoryboard() }], { source: 'manual' });
  expect(await (await send('POST', '/api/versions/a/approve', { model: 'opus' })).json()).toEqual({ jobs: [8, 9] });
  expect(calls).toContainEqual(['approve', 'a', 'opus']);
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
