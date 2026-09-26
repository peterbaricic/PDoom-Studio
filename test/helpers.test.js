import { test, expect } from 'bun:test';
import { limiter } from './helpers.js';

test('limiter: a finished run hands its slot to the next in line, so one arriving just then waits too (no overshoot)', async () => {
  const lim = limiter(1), seen = [];
  let open;
  const gate = new Promise(r => { open = r; });
  const first = lim.run(() => gate);
  const queued = lim.run(async () => { seen.push(['queued', lim.running()]); });
  // asks at the very moment the first run gives its slot up, before the queued one has started
  const late = gate.then(() => lim.run(async () => { seen.push(['late', lim.running()]); }));
  open();
  await Promise.all([first, queued, late]);
  expect(seen).toEqual([['queued', 1], ['late', 1]]);
  expect(lim.running()).toBe(0);
});

test('limiter: at most max at once, every run done', async () => {
  const lim = limiter(3);
  let now = 0, most = 0;
  const results = await Promise.all(Array.from({ length: 20 }, (_, k) => lim.run(async () => {
    now++; most = Math.max(most, now);
    await Bun.sleep(k % 3);
    now--;
    return k;
  })));
  expect(results).toEqual(Array.from({ length: 20 }, (_, k) => k));
  expect(most).toBe(3);
  expect(lim.running()).toBe(0);
});
