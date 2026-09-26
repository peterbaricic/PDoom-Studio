import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { _resetRestartedForTests, restartedState } from './client';
import { applyFramesEvent, handleStudioEvent, newerCoverage, watchStudioEvents } from './events';
import type { Coverage, JobWithLog } from './types';

describe('applyFramesEvent', () => {
  const keys = (k: string): Coverage['segments'] => Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => [n, `${k}${n}`]));
  const coverage = (ranges: Array<[number, number]>, broken: Coverage['broken'] = []): Coverage => ({
    total: 3759,
    ranges,
    broken,
    segments: keys('a'),
  });

  // Every `frames` event carries the version's whole current coverage (studio/frames/service.js), not what's new.
  test('the event\'s ranges replace the old ones, even when they cover less (frames evicted, the cache cleared)', () => {
    const prev = coverage([[0, 600], [900, 1000]]);
    expect(applyFramesEvent(prev, { ranges: [[0, 100]], broken: [], segments: keys('a') }).ranges).toEqual([[0, 100]]);
    expect(applyFramesEvent(prev, { ranges: [], broken: [] }).ranges).toEqual([]);
  });

  test('the event\'s ranges replace the old ones when they cover more, too', () => {
    const prev = coverage([[0, 10]]);
    expect(applyFramesEvent(prev, { ranges: [[0, 20], [50, 60]], broken: [] }).ranges).toEqual([
      [0, 20],
      [50, 60],
    ]);
  });

  test('replaces broken with the event\'s (the frame service always reports the full current set)', () => {
    const prev = coverage([[0, 10]], [{ chapter: 3, error: 'old error' }]);
    const next = applyFramesEvent(prev, { ranges: [], broken: [{ chapter: 5, error: 'new error' }] });
    expect(next.broken).toEqual([{ chapter: 5, error: 'new error' }]);
  });

  test('a chapter whose segment key changed: the event\'s ranges replace the old ones (they were for older code)', () => {
    const prev = coverage([[0, 600]]);
    const segments = { ...keys('a'), 2: 'b2' };
    const next = applyFramesEvent(prev, { ranges: [[0, 551]], broken: [], segments });
    expect(next.ranges).toEqual([[0, 551]]);
    expect(next.segments).toEqual(segments);
  });

  test('an event older than what\'s cached (a GET answered after it was sent) is ignored', () => {
    const prev = { ...coverage([[0, 20]]), seq: 7 };
    expect(applyFramesEvent(prev, { ranges: [[0, 10]], broken: [], seq: 5 })).toBe(prev);
    expect(applyFramesEvent(prev, { ranges: [[0, 30]], broken: [], seq: 8 }).ranges).toEqual([[0, 30]]);
    expect(applyFramesEvent(prev, { ranges: [[0, 30]], broken: [], seq: 8 }).seq).toBe(8);
  });

  test('newerCoverage keeps the cached coverage over a GET answer older than it, and takes the answer otherwise', () => {
    const cached = { ...coverage([[0, 30]]), seq: 9 };
    const answer = { ...coverage([[0, 20]]), seq: 8 };
    expect(newerCoverage(cached, answer)).toBe(cached);
    expect(newerCoverage({ ...cached, seq: 7 }, answer)).toBe(answer);
    expect(newerCoverage(undefined, answer)).toBe(answer);
  });

  test('leaves total untouched (the event never carries one)', () => {
    const prev = coverage([[0, 10]]);
    expect(applyFramesEvent(prev, { ranges: [[11, 12]], broken: [] }).total).toBe(3759);
  });
});

describe('handleStudioEvent', () => {
  function client() {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } });
  }

  test('version invalidates the versions list, that one version and its coverage', () => {
    const qc = client();
    const seen: unknown[][] = [];
    qc.invalidateQueries = (filters => {
      seen.push([filters?.queryKey]);
      return Promise.resolve();
    }) as typeof qc.invalidateQueries;
    handleStudioEvent(qc, 'version', { id: 'a' });
    // and its coverage: a changed chapter or option means new segment keys, and frames cached under the old ones no
    // longer count (the frames event only comes once something new is painted)
    expect(seen).toEqual([[['versions']], [['version', 'a']], [['coverage', 'a']]]);
  });

  test('job invalidates the jobs list and that one job', () => {
    const qc = client();
    const seen: unknown[][] = [];
    qc.invalidateQueries = (filters => {
      seen.push([filters?.queryKey]);
      return Promise.resolve();
    }) as typeof qc.invalidateQueries;
    handleStudioEvent(qc, 'job', { id: 7, version_id: 'a' });
    expect(seen).toEqual([[['jobs']], [['job', 7]]]);
  });

  test('log appends to the job\'s cached log at its offset, and does nothing when it is not cached', () => {
    const qc = client();
    qc.setQueryData(['job', 7], { id: 7, log: 'hello ' } as JobWithLog);
    handleStudioEvent(qc, 'log', { id: 7, offset: 6, text: 'world' });
    expect(qc.getQueryData<JobWithLog>(['job', 7])?.log).toBe('hello world');

    handleStudioEvent(qc, 'log', { id: 8, offset: 0, text: 'nope' });
    expect(qc.getQueryData(['job', 8])).toBeUndefined();
  });

  // The cached log and the event stream can disagree when a GET /api/jobs/<id> was in flight while lines arrived: the
  // fetched log may already hold the event's text (appending would duplicate it) or miss lines before it (appending
  // would drop them). Either way the cached copy is refetched instead.
  test.each([
    ['already holds the text', 'hello world', 6],
    ['misses lines before the text', 'hello ', 11],
  ])('log refetches instead of appending when the cached log %s', (_, cached, offset) => {
    const qc = client();
    qc.setQueryData(['job', 7], { id: 7, log: cached } as JobWithLog);
    const seen: unknown[] = [];
    qc.invalidateQueries = (filters => {
      seen.push(filters?.queryKey);
      return Promise.resolve();
    }) as typeof qc.invalidateQueries;
    handleStudioEvent(qc, 'log', { id: 7, offset, text: 'world' });
    expect(qc.getQueryData<JobWithLog>(['job', 7])?.log).toBe(cached);
    expect(seen).toEqual([['job', 7]]);
  });

  test('library invalidates the renders list', () => {
    const qc = client();
    const seen: unknown[][] = [];
    qc.invalidateQueries = (filters => {
      seen.push([filters?.queryKey]);
      return Promise.resolve();
    }) as typeof qc.invalidateQueries;
    handleStudioEvent(qc, 'library', {});
    expect(seen).toEqual([[['renders']]]);
  });

  test('frames replaces the cached coverage\'s ranges for that version, and does nothing when it is not cached', () => {
    const qc = client();
    qc.setQueryData<Coverage>(['coverage', 'a'], { total: 3759, ranges: [[0, 600]], broken: [], segments: {} });
    handleStudioEvent(qc, 'frames', { versionId: 'a', ranges: [[0, 20]], broken: [] });
    expect(qc.getQueryData<Coverage>(['coverage', 'a'])?.ranges).toEqual([[0, 20]]);

    handleStudioEvent(qc, 'frames', { versionId: 'b', ranges: [[0, 1]], broken: [] });
    expect(qc.getQueryData(['coverage', 'b'])).toBeUndefined();
  });

  test('an unknown event type is ignored', () => {
    const qc = client();
    expect(() => handleStudioEvent(qc, 'mystery', {})).not.toThrow();
  });
});

describe('watchStudioEvents', () => {
  // An EventSource as the browser runs one: it reconnects by itself after an error, firing `open` again.
  class FakeSource extends EventTarget {
    closed = false;
    close() {
      this.closed = true;
    }
    emit(type: string, data?: unknown) {
      this.dispatchEvent(data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
  function watch() {
    const qc = new QueryClient();
    const invalidated: unknown[] = [];
    qc.invalidateQueries = (filters => {
      invalidated.push(filters?.queryKey ?? 'everything');
      return Promise.resolve();
    }) as typeof qc.invalidateQueries;
    const source = new FakeSource();
    const stop = watchStudioEvents(qc, source as unknown as EventSource);
    return { source, invalidated, stop };
  }
  afterEach(() => _resetRestartedForTests());

  test('the first connection refetches nothing; a reconnection after an error refetches everything (events may have been missed)', () => {
    const { source, invalidated } = watch();
    source.emit('open');
    source.emit('hello', { boot: 'b1' });
    expect(invalidated).toEqual([]);
    source.emit('error');
    expect(invalidated).toEqual([]);
    source.emit('open');
    expect(invalidated).toEqual(['everything']);
    // an open with no error before it (there is none, but just so) is not a reconnection
    source.emit('open');
    expect(invalidated).toEqual(['everything']);
  });

  test('a reconnection to the same server run is not a restart; to a new one it is, at once', () => {
    const { source } = watch();
    source.emit('open');
    source.emit('hello', { boot: 'b1' });
    source.emit('error');
    source.emit('open');
    source.emit('hello', { boot: 'b1' });
    expect(restartedState.value).toBe(false);
    source.emit('error');
    source.emit('open');
    source.emit('hello', { boot: 'b2' });
    expect(restartedState.value).toBe(true);
  });

  test('events still reach the query cache, and stopping closes the stream', () => {
    const { source, invalidated, stop } = watch();
    source.emit('job', { id: 3, version_id: 'a' });
    expect(invalidated).toEqual([['jobs'], ['job', 3]]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    source.dispatchEvent(new MessageEvent('job', { data: 'not json' }));
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
    stop();
    expect(source.closed).toBe(true);
    source.emit('job', { id: 4, version_id: 'a' });
    expect(invalidated).toHaveLength(2);
  });
});
