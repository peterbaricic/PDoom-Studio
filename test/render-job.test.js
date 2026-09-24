import { test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../studio/db.js';
import { serve } from '../studio/serve.js';
import { createEvents } from '../studio/events.js';
import { createRenderRunner } from '../studio/render-job.js';
import { tempDir, tempDefaultDb } from './helpers.js';

const root = process.cwd(), T = { timeout: 300000 };
let db, srv, runners, data;
const ctx = (signal = new AbortController().signal, seen = []) => ({ signal, log: () => {}, progress: p => seen.push(p), cost: () => {} });
beforeAll(() => {
  db = openDb(':memory:', { defaultPath: tempDefaultDb() }); data = tempDir();
  srv = serve({ db, root, data, token: 't', events: createEvents(), port: 0 });
  runners = createRenderRunner({ db, root, data, baseUrl: srv.url });
});
afterAll(() => srv.stop());

test('renders a range into the library', async () => {
  const seen = [], job = db.getJob(db.addJob({ kind: 'render', versionId: 'original', params: { frames: '40:40.5', workers: 2, poster: 40.2 } }));
  await runners.render(job, ctx(undefined, seen));
  const [r] = db.listRenders();
  expect(r).toMatchObject({ version_id: 'original', duration_s: .5 });
  expect(r.revision_ids).toHaveLength(db.listFiles('original').length);
  expect(existsSync(join(data, 'library', r.file))).toBe(true);
  expect(existsSync(join(data, 'library', r.poster))).toBe(true);
  expect(existsSync(join(data, '.studio/frames/original'))).toBe(false);
  expect(Math.max(...seen)).toBeGreaterThan(.9);
}, T);

test('writes chapter thumbnails', async () => {
  db.createVersion({ id: 'thumbtest' });
  db.writeFiles('thumbtest', [{ path: 'ch/c02.js', content: "chapter('two', 23, 38.5, [[23, t => paint(rectPts(0, 0, W, H), { wash: PAL.rose, ink: null })]]);" }], { source: 'manual' });
  await runners.thumbs(db.getJob(db.addJob({ kind: 'thumbs', versionId: 'thumbtest' })), ctx());
  expect(existsSync(join(data, '.studio/thumbs/thumbtest/c02.jpg'))).toBe(true);
}, T);

test('cancelling stops the render, and the frames stamp names the revisions and the engine options', async () => {
  const ctrl = new AbortController(), job = db.getJob(db.addJob({ kind: 'render', versionId: 'original', params: { frames: '0:156.6' } }));
  const p = runners.render(job, ctx(ctrl.signal));
  setTimeout(() => ctrl.abort(), 3000);
  await expect(p).rejects.toThrow('cancelled');
  expect(JSON.parse(readFileSync(join(data, '.studio/frames/original/revisions.json'), 'utf8'))).toEqual({
    revisionIds: db.listFiles('original').map(f => f.revision_id), options: db.getVersion('original').options });
}, T);
