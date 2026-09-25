import { test, expect } from 'bun:test';
import { PRIORITIES, createPool } from '../studio/frames/pool.js';

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
