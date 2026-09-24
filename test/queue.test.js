import { test, expect, beforeEach } from 'bun:test';
import { openDb } from '../studio/db.js';
import { createEvents } from '../studio/events.js';
import { createQueue } from '../studio/queue.js';

let db, events, started, gates;
// A runner that records when it starts and finishes only when the test opens its gate.
const gated = kind => async (job, ctx) => {
  started.push(`${kind}#${job.id}`);
  ctx.log(`${kind} running\n`); ctx.progress(.5); ctx.cost(.25);
  await new Promise((ok, bad) => {
    gates.set(job.id, { ok, bad });
    ctx.signal.addEventListener('abort', () => bad(new Error('aborted')));
  });
};
const open = id => gates.get(id).ok();
const fail = (id, msg) => gates.get(id).bad(new Error(msg));
const tick = () => new Promise(r => setTimeout(r, 10));

beforeEach(() => {
  db = openDb(':memory:'); events = createEvents(); started = []; gates = new Map();
  db.createVersion({ id: 'a' });
});
const make = limits => {
  const kinds = ['storyboard', 'shared', 'chapter', 'render', 'thumbs'];
  const q = createQueue({ db, events, limits, runners: Object.fromEntries(kinds.map(k => [k, gated(k)])) });
  q.start(); return q;
};

test('runs a job to done with log, progress and cost', async () => {
  const q = make(), seen = [];
  events.subscribe(e => seen.push(e.type));
  const id = q.enqueue({ kind: 'storyboard', versionId: 'a', model: 'opus' });
  await tick();
  expect(db.getJob(id)).toMatchObject({ status: 'running', progress: .5, cost_usd: .25, log: 'storyboard running\n' });
  open(id); await q.idle();
  expect(db.getJob(id)).toMatchObject({ status: 'done', progress: 1 });
  expect(seen).toContain('log');
});

test('respects lane limits', async () => {
  const q = make({ claude: 2, render: 1 });
  const ids = [1, 2, 3].map(n => q.enqueue({ kind: 'chapter', versionId: 'a', params: { chapter: n } }));
  const r = [q.enqueue({ kind: 'render', versionId: 'a' }), q.enqueue({ kind: 'render', versionId: 'a' })];
  await tick();
  expect(started).toEqual([`chapter#${ids[0]}`, `chapter#${ids[1]}`, `render#${r[0]}`]);
  open(ids[0]); await tick();
  expect(started).toContain(`chapter#${ids[2]}`);
  for (const id of [ids[1], ids[2], r[0]]) open(id);
  await tick(); open(r[1]); await q.idle();
});

test('approve runs shared first, then the chapters', async () => {
  const q = make({ claude: 3, render: 1 });
  const [shared, ...chapters] = q.approve('a', 'sonnet');
  expect(chapters).toHaveLength(9);
  expect(db.getJob(chapters[4]).params).toEqual({ chapter: 5, after: shared });
  expect(db.getVersion('a').status).toBe('approved');
  await tick();
  expect(started).toEqual([`shared#${shared}`]);
  open(shared); await tick();
  expect(started.slice(1)).toEqual(chapters.slice(0, 3).map(id => `chapter#${id}`));
  for (const id of chapters) { while (!gates.has(id)) await tick(); open(id); }
  await q.idle();
});

test('failure, retry and dependents', async () => {
  const q = make();
  const [shared, first] = q.approve('a', null);
  await tick(); fail(shared, 'bad code'); await tick();
  expect(db.getJob(shared)).toMatchObject({ status: 'failed', error: 'bad code' });
  expect(db.getJob(first).status).toBe('queued');
  const again = q.retry(shared);
  expect(db.getJob(first).params.after).toBe(again);
  await tick(); open(again); await tick();
  expect(started).toContain(`chapter#${first}`);
  expect(() => q.retry(again)).toThrow('only failed, cancelled or interrupted jobs can be retried');
});

test('cancel stops queued and running jobs', async () => {
  const q = make({ claude: 1, render: 1 });
  const a = q.enqueue({ kind: 'chapter', versionId: 'a' }), b = q.enqueue({ kind: 'chapter', versionId: 'a' });
  await tick();
  expect(q.cancel(b)).toBe(true);
  expect(db.getJob(b).status).toBe('cancelled');
  expect(q.cancel(a)).toBe(true);
  await q.idle();
  expect(db.getJob(a).status).toBe('cancelled');
  expect(q.cancel(a)).toBe(false);
});

test('a retried chapter waits for the shared job that can still finish, not the failed one it first waited for', async () => {
  const q = make();
  const [shared, ...chapters] = q.approve('a', null);
  await tick(); fail(shared, 'bad code'); await tick();
  for (const id of chapters) q.cancel(id);              // the user gives up on the waiting chapters…
  const again = q.retry(shared);                         // …retries the shared setup, which now works…
  await tick(); open(again); await tick();
  expect(db.getJob(again).status).toBe('done');
  const chapter = q.retry(chapters[0]);                  // …and then retries a chapter
  expect(db.getJob(chapter).params).toEqual({ chapter: 1, after: again });
  await tick();
  expect(started).toContain(`chapter#${chapter}`);
  open(chapter); await q.idle();
});

test('a retried chapter whose shared job is gone runs if the version has shared.js, and waits otherwise', async () => {
  const q = make();
  const [shared, first, second] = q.approve('a', null);
  await tick(); fail(shared, 'bad code'); await tick();
  q.cancel(first); q.cancel(second);
  const waiting = q.retry(first);
  expect(db.getJob(waiting).params).toEqual({ chapter: 1, after: shared });
  db.writeFiles('a', [{ path: 'shared.js', content: 'const SET = {};' }], { source: 'manual' });
  q.cancel(waiting);
  const runs = q.retry(second);
  expect(db.getJob(runs).params).toEqual({ chapter: 2 });
  await tick();
  expect(started).toContain(`chapter#${runs}`);
  open(runs);
});
