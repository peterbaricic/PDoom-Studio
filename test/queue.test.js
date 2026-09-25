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

// The review's stuck-chapter scenario: a chapter that keeps chasing a shared job through several failed retries,
// instead of being left pointed at the very first (and by then long-dead) attempt.
test('a chapter chases the shared job through repeated failed retries until one finally succeeds', async () => {
  const q = make();
  const [s1, ...chapters] = q.approve('a', null);
  await tick(); fail(s1, 'bad code'); await tick();
  for (const id of chapters) q.cancel(id);                // the user gives up on the waiting chapters…
  const s2 = q.retry(s1);                                 // …retries the shared setup…
  await tick(); fail(s2, 'bad code again'); await tick();  // …which fails again…
  const chapter = q.retry(chapters[0]);                   // …and retries the chapter anyway
  expect(db.getJob(chapter).params).toEqual({ chapter: 1, after: s2 });   // chases s2, not the long-dead s1
  const s3 = q.retry(s2);                                 // retrying s2 repoints the still-queued chapter forward
  expect(db.getJob(chapter).params).toEqual({ chapter: 1, after: s3 });
  await tick(); open(s3); await tick();
  expect(db.getJob(s3).status).toBe('done');
  await tick();
  expect(started).toContain(`chapter#${chapter}`);
  open(chapter); await q.idle();
});

test('log events carry the offset the text was appended at', async () => {
  const logs = [];
  events.subscribe(e => e.type === 'log' && logs.push(e.data));
  const q = createQueue({ db, events, runners: { storyboard: async (job, ctx) => { ctx.log('héllo 🙂\n'); ctx.log('world\n'); } } });
  q.start();
  const id = q.enqueue({ kind: 'storyboard', versionId: 'a' });
  await q.idle();
  // Offsets count what JSON-decoded strings count (UTF-16 code units), so a client can compare them with its copy.
  expect(logs).toEqual([{ id, offset: 0, text: 'héllo 🙂\n' }, { id, offset: 'héllo 🙂\n'.length, text: 'world\n' }]);
  expect(db.getJob(id).log.length).toBe(logs[1].offset + 'world\n'.length);
});

test('progress events are throttled per job, but the latest progress and every state change still go out', async () => {
  const jobEvents = [];
  events.subscribe(e => e.type === 'job' && jobEvents.push(e.data));
  let release;
  const q = createQueue({ db, events, progressEveryMs: 50, runners: { render: async (job, ctx) => {
    for (let i = 1; i <= 100; i++) ctx.progress(i / 200);    // one report per painted frame
    await new Promise(r => { release = r; });
  } } });
  q.start();
  const id = q.enqueue({ kind: 'render', versionId: 'a' });
  await tick();
  // queued, running, and the first progress report; the other 99 are held back.
  expect(jobEvents.map(j => [j.status, j.progress])).toEqual([['queued', 0], ['running', 0], ['running', .005]]);
  await new Promise(r => setTimeout(r, 80));
  // One trailing event, carrying the latest progress.
  expect(jobEvents.map(j => [j.status, j.progress])).toEqual([['queued', 0], ['running', 0], ['running', .005], ['running', .5]]);
  release(); await q.idle();
  expect(jobEvents.at(-1)).toMatchObject({ status: 'done', progress: 1 });
  expect(jobEvents).toHaveLength(5);
});

test('a final progress report of 1 is published at once', async () => {
  const jobEvents = [];
  events.subscribe(e => e.type === 'job' && jobEvents.push(e.data));
  let release;
  const q = createQueue({ db, events, progressEveryMs: 10_000, runners: { render: async (job, ctx) => {
    ctx.progress(.1); ctx.progress(.2); ctx.progress(1);
    await new Promise(r => { release = r; });
  } } });
  q.start();
  q.enqueue({ kind: 'render', versionId: 'a' });
  await tick();
  expect(jobEvents.map(j => j.progress)).toEqual([0, 0, .1, 1]);
  release(); await q.idle();
});
