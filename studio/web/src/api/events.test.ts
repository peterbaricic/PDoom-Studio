import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'vitest';
import { applyFramesEvent, handleStudioEvent } from './events';
import type { Coverage, JobWithLog } from './types';

describe('applyFramesEvent', () => {
  const coverage = (ranges: Array<[number, number]>, broken: Coverage['broken'] = []): Coverage => ({ total: 3759, ranges, broken });

  test('merges a new range that overlaps an existing one', () => {
    const prev = coverage([[0, 10]]);
    expect(applyFramesEvent(prev, { ranges: [[5, 20]], broken: [] }).ranges).toEqual([[0, 20]]);
  });

  test('merges adjacent ranges (no gap between them) into one', () => {
    const prev = coverage([[0, 10]]);
    expect(applyFramesEvent(prev, { ranges: [[11, 20]], broken: [] }).ranges).toEqual([[0, 20]]);
  });

  test('keeps disjoint ranges separate, sorted', () => {
    const prev = coverage([[50, 60]]);
    expect(applyFramesEvent(prev, { ranges: [[0, 10]], broken: [] }).ranges).toEqual([
      [0, 10],
      [50, 60],
    ]);
  });

  test('merges several overlapping and adjacent ranges from both sides at once', () => {
    const prev = coverage([
      [0, 5],
      [20, 30],
    ]);
    const next = applyFramesEvent(prev, {
      ranges: [
        [6, 12],
        [13, 19],
        [100, 110],
      ],
      broken: [],
    });
    expect(next.ranges).toEqual([
      [0, 30],
      [100, 110],
    ]);
  });

  test('replaces broken with the event\'s (the frame service always reports the full current set)', () => {
    const prev = coverage([[0, 10]], [{ chapter: 3, error: 'old error' }]);
    const next = applyFramesEvent(prev, { ranges: [], broken: [{ chapter: 5, error: 'new error' }] });
    expect(next.broken).toEqual([{ chapter: 5, error: 'new error' }]);
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

  test('version invalidates the versions list and that one version', () => {
    const qc = client();
    const seen: unknown[][] = [];
    qc.invalidateQueries = (filters => {
      seen.push([filters?.queryKey]);
      return Promise.resolve();
    }) as typeof qc.invalidateQueries;
    handleStudioEvent(qc, 'version', { id: 'a' });
    expect(seen).toEqual([[['versions']], [['version', 'a']]]);
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

  test('frames merges ranges into the cached coverage for that version, and does nothing when it is not cached', () => {
    const qc = client();
    qc.setQueryData(['coverage', 'a'], { total: 3759, ranges: [[0, 10]], broken: [] } as Coverage);
    handleStudioEvent(qc, 'frames', { versionId: 'a', ranges: [[11, 20]], broken: [] });
    expect(qc.getQueryData<Coverage>(['coverage', 'a'])?.ranges).toEqual([[0, 20]]);

    handleStudioEvent(qc, 'frames', { versionId: 'b', ranges: [[0, 1]], broken: [] });
    expect(qc.getQueryData(['coverage', 'b'])).toBeUndefined();
  });

  test('an unknown event type is ignored', () => {
    const qc = client();
    expect(() => handleStudioEvent(qc, 'mystery', {})).not.toThrow();
  });
});
