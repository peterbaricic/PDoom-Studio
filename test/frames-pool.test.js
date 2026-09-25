import { test, expect } from 'bun:test';
import { PRIORITIES, createPool } from '../studio/frames/pool.js';
import { findBrowser } from '../studio/browser.js';

// The painting order itself (with a real painting browser) is tested in frames-service.test.js; here, what needs none.
test('background is the lowest priority, after thumbs', () => {
  expect(PRIORITIES).toEqual(['preview', 'prefetch', 'render', 'thumbs', 'background']);
});

test('a request at background priority is accepted; an unknown priority is refused', async () => {
  const pool = createPool({ port: 1, baseUrl: 'http://localhost:1', onPainted() {} });
  await pool.close();   // closed before anything launches: requests answer at once
  expect(await pool.request({ versionId: 'v', snapshotId: 's', key: 'k', frame: 0, prio: 'background' }))
    .toEqual({ ok: false, error: 'the painting pool is closed' });
  expect(() => pool.request({ versionId: 'v', snapshotId: 's', key: 'k', frame: 0, prio: 'someday' })).toThrow('unknown priority: someday');
});

test('with no browser to be found, findBrowser throws (the studio paints in-process: it must not exit)', () => {
  expect(() => findBrowser(undefined, { fromEnv: false, installed: [], caches: [] })).toThrow('No Chromium-based browser found');
  expect(findBrowser('/some/chrome', { installed: [], caches: [] })).toBe('/some/chrome');
});

test('a painting browser that will not start fails every request at once with the reason, and is tried again only after launchRetryMs', async () => {
  let launches = 0;
  const pool = createPool({ port: 1, baseUrl: 'http://localhost:1', onPainted() {}, launchRetryMs: 300,
    launch: async () => { launches++; throw new Error('No Chromium-based browser found.\nmore detail'); } });
  const ask = frame => pool.request({ versionId: 'v', snapshotId: 's', key: 'k', frame, prio: 'prefetch' });
  const reason = 'the painting browser did not start: No Chromium-based browser found. more detail';
  try {
    expect(pool.health()).toEqual({ ok: true, reason: null });   // not known before the first launch
    // several requests at once (more than there are painters): one launch, and every one of them answered
    const first = await Promise.all([0, 1, 2, 3, 4].map(ask));
    expect(first).toEqual(Array(5).fill({ ok: false, unavailable: true, error: reason }));
    expect(launches).toBe(1);
    expect(pool.health()).toEqual({ ok: false, reason });
    // from then on, answered there and then, with no launch, until launchRetryMs has passed
    expect(await ask(5)).toEqual({ ok: false, unavailable: true, error: reason });
    expect(launches).toBe(1);
    await Bun.sleep(350);
    expect(await ask(6)).toMatchObject({ unavailable: true });
    expect(launches).toBe(2);
    expect(pool.health().ok).toBe(false);
  } finally { await pool.close(); }
});
