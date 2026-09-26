import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { limiter, sharedBrowser } from './helpers.js';

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

// A stand-in browser: it disconnects when told, and says when it's closed.
const fakeBrowser = id => Object.assign(new EventEmitter(), { id, closed: false, async close() { this.closed = true; }, process: () => null });

test('sharedBrowser: a launch that fails is tried again by the next get(), not handed to every later test', async () => {
  let launches = 0;
  const shared = sharedBrowser(async () => { if (++launches === 1) throw new Error('could not launch under load'); return fakeBrowser(launches); });
  await expect(shared.get()).rejects.toThrow('could not launch under load');
  const b = await shared.get();
  expect([b.id, launches]).toEqual([2, 2]);
  expect(await shared.get()).toBe(b);   // and kept once it's up
  expect(launches).toBe(2);
  await shared.close();
  expect(b.closed).toBe(true);
});

test('sharedBrowser: a browser that disconnects mid-file is replaced by the next get(); close() closes every one launched', async () => {
  let launches = 0;
  const shared = sharedBrowser(async () => fakeBrowser(++launches));
  const first = await shared.get();
  first.emit('disconnected');
  const second = await shared.get();
  expect([first.id, second.id]).toEqual([1, 2]);
  expect(await shared.get()).toBe(second);
  await shared.close();
  expect([first.closed, second.closed]).toEqual([true, true]);
});
