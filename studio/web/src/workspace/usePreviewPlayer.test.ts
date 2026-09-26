import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { _resetRestartedForTests, restartedState } from '@/api/client';
import type { Coverage, Song } from '@/api/types';
import { usePreviewPlayer, type PreviewPlayerOptions } from './usePreviewPlayer';

// The song as /api/song sends it (studio/storyboard.js's CHAPTER_WINDOWS; 3759 frames at 24 fps).
const CHAPTERS: Array<[number, number]> = [
  [0, 23], [23, 38.5], [38.5, 59], [59, 73], [73, 95.4], [95.4, 109.4], [109.4, 123.5], [123.5, 140.5], [140.5, 156.6],
];
const SONG: Song = { fps: 24, frames: 3759, duration: 156.6, chapters: CHAPTERS, lyrics: [] };
const N = 3759;
const CH2 = 552; // chapter 2's first frame (23 s)

const keys = (tag: string, overrides: Record<number, string | null> = {}): Coverage['segments'] => ({
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => [n, `${tag}${n}`])),
  ...overrides,
});
const coverage = (ranges: Array<[number, number]>, segments: Coverage['segments'], broken: Coverage['broken'] = []): Coverage => ({
  total: N,
  ranges,
  broken,
  segments,
});
const chapterOf = (i: number) => 1 + CHAPTERS.findIndex(([a, b]) => i / 24 >= a && i / 24 < b);

// ---- a fake song element: its clock is moved by the test ----
class FakeAudio extends EventTarget {
  currentTime = 0;
  paused = true;
  muted = false;
  preload = '';
  // A real <audio> fires `pause` in a later task than pause() itself; this one does too when asked to.
  asyncPauseEvent = false;
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    if (this.paused) return;
    this.paused = true;
    if (this.asyncPauseEvent) setTimeout(() => this.dispatchEvent(new Event('pause')), 0);
    else this.dispatchEvent(new Event('pause'));
  });
}

// ---- a fake frame server: every request waits until the test answers it ----
interface Pending {
  frame: number;
  prio: string | null;
  signal: AbortSignal;
  resolve: (r: Response) => void;
}
let requests: Pending[];
let paintAhead: number[]; // the `from` of every POST /api/frames/mine/paint-ahead
let fetchMock: ReturnType<typeof vi.fn>;
const open = () => requests.filter(r => !r.signal.aborted && !answered.has(r));
const answered = new Set<Pending>();
const framesAsked = () => requests.map(r => r.frame);

function frameResponse(frame: number, key: string) {
  return new Response(`frame ${frame} ${key}`, { status: 200, headers: { etag: `"${key}.-"`, 'content-type': 'image/jpeg' } });
}
function answer(r: Pending, res: Response) {
  answered.add(r);
  r.resolve(res);
}
// Answers every open request for frame i (the newest first) with the frame under `key`.
function answerFrame(i: number, key: string) {
  const r = open().filter(x => x.frame === i).at(-1);
  if (!r) throw new Error(`no open request for frame ${i} (asked: ${framesAsked().join(',')})`);
  answer(r, frameResponse(i, key));
}

// ---- decoding and the canvas: what got drawn, by the frame's text ----
let drawn: string[];
let decode: (blob: Blob) => Promise<unknown>;
const canvas = () =>
  ({
    width: 1920,
    height: 1080,
    getContext: () => ({ drawImage: (b: { label: string }) => drawn.push(b.label) }),
  }) as unknown as HTMLCanvasElement;

beforeEach(() => {
  // Everything but setImmediate: flush() yields real macrotasks with it, for Response/Blob reads that don't settle in
  // microtasks alone.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date', 'performance'],
  });
  requests = [];
  paintAhead = [];
  answered.clear();
  drawn = [];
  fetchMock = vi.fn((url: string, init: RequestInit = {}) => {
    if (url === '/api/frames/mine/paint-ahead' && init.method === 'POST') {
      paintAhead.push(JSON.parse(String(init.body)).from);
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    const m = /^\/api\/frames\/([a-z0-9-]+)\/(\d+)\.jpg(?:\?prio=(\w+))?$/.exec(url);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    return new Promise<Response>((resolve, reject) => {
      const r: Pending = { frame: +m[2]!, prio: m[3] ?? null, signal: init.signal!, resolve };
      requests.push(r);
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  decode = async blob => ({ label: await blob.text(), close() {} });
  vi.stubGlobal('createImageBitmap', (blob: Blob) => decode(blob));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  _resetRestartedForTests();
});

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let k = 0; k < 5; k++) await new Promise(r => setImmediate(r));
    await vi.advanceTimersByTimeAsync(0);
  });
};

function mount(overrides: Partial<PreviewPlayerOptions> = {}) {
  const audio = new FakeAudio();
  const props: PreviewPlayerOptions = {
    versionId: 'mine',
    song: SONG,
    coverage: coverage([], keys('a')),
    segmentKeys: keys('a'),
    audio: audio as unknown as HTMLAudioElement,
    ...overrides,
  };
  const hook = renderHook((p: PreviewPlayerOptions) => usePreviewPlayer(p), { initialProps: props });
  act(() => hook.result.current.canvasRef(canvas()));
  return {
    ...hook,
    audio,
    props,
    update(next: Partial<PreviewPlayerOptions>) {
      Object.assign(props, next);
      hook.rerender({ ...props });
    },
  };
}

// Answers every open request with the frame under the current key of its chapter, as a server with nothing to paint
// would, until nothing is left open (or `rounds` runs out).
async function serveAll(segments: Coverage['segments'], { except = new Set<number>(), rounds = 50 } = {}) {
  for (let k = 0; k < rounds; k++) {
    const todo = open().filter(r => !except.has(r.frame));
    if (!todo.length) return;
    for (const r of todo) answer(r, frameResponse(r.frame, segments[chapterOf(r.frame)]!));
    await flush();
  }
}

describe('scheduling', () => {
  test('requests frames ahead of the playhead, at most 4 in flight, the playhead frame as a preview', async () => {
    const p = mount({ initialTime: 10 });
    await flush();
    expect(framesAsked()).toEqual([240, 241, 242, 243]);
    expect(requests.map(r => r.prio)).toEqual(['preview', 'prefetch', 'prefetch', 'prefetch']);
    expect(p.result.current.time).toBe(10);

    answerFrame(240, 'a1');
    answerFrame(241, 'a1');
    await flush();
    expect(framesAsked().slice(4)).toEqual([244, 245]);
    expect(open()).toHaveLength(4);

    // nothing more while all four are still out, however long it takes
    await flush(10_000);
    expect(open()).toHaveLength(4);
    expect(requests).toHaveLength(6);
  });

  test('frame requests carry the studio token: the server answers them only with it', async () => {
    const meta = document.createElement('meta');
    meta.name = 'studio-token';
    meta.content = 'tok-9';
    document.head.append(meta);
    try {
      mount();
      await flush();
      const frameCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('.jpg') || String(url).includes('.jpg?'));
      expect(frameCalls.length).toBeGreaterThan(0);
      for (const [, init] of frameCalls) expect((init as RequestInit).headers).toEqual({ 'x-studio-token': 'tok-9' });
    } finally {
      meta.remove();
    }
  });

  test('frames already on screen or in memory are not asked for again, and cached frames past the window are not asked for at all', async () => {
    const p = mount({ initialTime: 0, coverage: coverage([[0, N - 1]], keys('a')) });
    await flush();
    await serveAll(keys('a'));
    // the paused window: 48 frames, each once; everything else is cached on the server, so nothing more is needed
    expect(framesAsked().sort((a, b) => a - b)).toEqual(Array.from({ length: 48 }, (_, k) => k));
    expect(drawn).toEqual(['frame 0 a1']);
    expect(p.result.current.painting).toBe(false);
  });

  test('past the window, the server is asked to paint ahead from the playhead instead of being sent requests', async () => {
    const p = mount({ initialTime: 0, coverage: coverage([[0, 47]], keys('a')) });
    await flush(1_000);
    await serveAll(keys('a'), { rounds: 20 });
    expect(Math.max(...framesAsked())).toBe(47); // nothing past the paused window is fetched

    // Play (there's more to paint): from the playhead
    act(() => p.result.current.play());
    expect(p.result.current.state).toBe('waiting');
    await flush(1_000);
    expect(paintAhead).toEqual([0]);

    // a scrub re-aims it once it settles, not once per step
    for (let s = 1; s <= 10; s++) {
      act(() => p.result.current.seek(s * 3));
      await flush(50);
    }
    expect(paintAhead).toEqual([0]);
    await flush(1_000);
    expect(paintAhead).toEqual([0, 720]);

    // new code for a chapter: aimed again
    p.update({ segmentKeys: keys('a', { 2: 'b2' }), coverage: coverage([], keys('a', { 2: 'b2' })) });
    await flush(1_000);
    expect(paintAhead).toEqual([0, 720, 720]);
    // the same keys again (a coverage refresh): not
    p.update({ segmentKeys: keys('a', { 2: 'b2' }), coverage: coverage([[720, 730]], keys('a', { 2: 'b2' })) });
    await flush(1_000);
    expect(paintAhead).toEqual([0, 720, 720]);
  });

  test('opening a version, scrubbing it and new code for it while paused ask the server to paint nothing ahead', async () => {
    const p = mount({ initialTime: 0, coverage: coverage([[0, 47]], keys('a')) });
    await flush(5_000);
    for (let s = 1; s <= 3; s++) {
      act(() => p.result.current.seek(s * 30));
      await flush(1_000);
    }
    p.update({ segmentKeys: keys('a', { 2: 'b2' }), coverage: coverage([], keys('a', { 2: 'b2' })) });
    await flush(60_000);
    expect(paintAhead).toEqual([]);
    // "Play now" wants it (what's past the playhead isn't painted): asked for then
    p.update({ coverage: coverage([[2160, 2200]], keys('a', { 2: 'b2' })) });
    await serveAll(keys('a', { 2: 'b2' }));
    act(() => p.result.current.playNow());
    await flush(1_000);
    expect(paintAhead).toEqual([2160]);
  });

  test('while playback wants painting ahead, it is asked for again every 20 s (the server holds it on a lease), and not once it stops', async () => {
    const p = mount({ initialTime: 0, coverage: coverage([[0, 100]], keys('a')) });
    await flush();
    await serveAll(keys('a'));
    act(() => p.result.current.play());
    await flush(1_000);
    expect(paintAhead).toEqual([0]);
    // the coverage keeps growing (no stall), so only the renewals ask again
    for (let s = 1; s <= 50; s++) {
      p.update({ coverage: coverage([[0, 100 + s]], keys('a')) });
      await flush(1_000);
    }
    expect(paintAhead).toEqual([0, 0, 0]); // after 20 s and 40 s
    // cancelled: no more
    act(() => p.result.current.play());
    expect(p.result.current.state).toBe('paused');
    await flush(120_000);
    expect(paintAhead).toEqual([0, 0, 0]);
  });

  test.each([
    ['unmounted', (p: ReturnType<typeof mount>) => p.unmount()],
    ['switched to another version', (p: ReturnType<typeof mount>) => p.update({ versionId: 'other' })],
  ])('a player %s while waiting stops renewing its paint-ahead (the server lets the sweep lapse)', async (_, leave) => {
    const p = mount({ initialTime: 0, coverage: coverage([[0, 100]], keys('a')) });
    await flush();
    act(() => p.result.current.play());
    await flush(1_000);
    expect(paintAhead).toEqual([0]);
    act(() => leave(p));
    await flush(120_000);
    expect(paintAhead).toEqual([0]);
  });

  test('while waiting, paint-ahead is re-aimed when a broken chapter clears', async () => {
    const segments = keys('a');
    const p = mount({ initialTime: 0, segmentKeys: segments, coverage: coverage([[0, 100]], segments, [{ chapter: 2, error: 'timed out' }]) });
    await flush();
    act(() => p.result.current.play());
    expect(p.result.current.state).toBe('waiting');
    await flush(1_000);
    const before = paintAhead.length;
    expect(before).toBeGreaterThanOrEqual(1);
    // the break expires on the server: the coverage no longer lists it
    p.update({ coverage: coverage([[0, 100]], segments) });
    await flush(1_000);
    expect(paintAhead.slice(before)).toEqual([0]);
  });

  test('while waiting, a stalled paint-ahead is re-aimed, less and less often, and not once nothing is left to paint', async () => {
    const p = mount({ initialTime: 0, coverage: coverage([[0, 100]], keys('a')) });
    await flush();
    await serveAll(keys('a'));
    act(() => p.result.current.play());
    expect(p.result.current.state).toBe('waiting');
    await flush(1_000);
    const start = paintAhead.length;
    await flush(60_000); // nothing gets painted: re-aimed after about 5 s, then 10 s, then 20 s, and renewed 20 s after that
    expect(paintAhead.length - start).toBe(4);
    expect(paintAhead.slice(start).every(f => f === 0)).toBe(true);
    // painting resumes: the wait goes back to 5 s (it had grown to 40 s)
    await flush(1_000);
    p.update({ coverage: coverage([[0, 200]], keys('a')) });
    await flush(4_500);
    expect(paintAhead.length - start).toBe(4);
    await flush(1_000);
    expect(paintAhead.length - start).toBe(5);
    // everything is painted: it plays, and nothing more is asked for
    p.update({ coverage: coverage([[0, N - 1]], keys('a')) });
    await serveAll(keys('a'));
    expect(p.result.current.state).toBe('playing');
    const done = paintAhead.length;
    await flush(120_000);
    expect(paintAhead.length).toBe(done);
  });

  test.each([
    ['a seek', (p: ReturnType<typeof mount>) => p.result.current.seek(20)],
    ['Play again', (p: ReturnType<typeof mount>) => (p.result.current.play(), p.result.current.play())],
    ['Play now', (p: ReturnType<typeof mount>) => (p.result.current.play(), p.result.current.playNow())],
  ])('%s re-aims a stalled paint-ahead, and its stall wait starts over at 5 s', async (_, reAim) => {
    const p = mount({ initialTime: 0, coverage: coverage([[0, 100]], keys('a')) });
    await flush();
    await serveAll(keys('a'));
    act(() => p.result.current.play());
    await flush(36_000); // aimed, then re-aimed after 5 s, 10 s and 20 s: the next wait would be 40 s
    const before = paintAhead.length;
    act(() => reAim(p));
    expect(p.result.current.state).not.toBe('paused'); // waiting, or (Play now) playing what's there
    await flush(1_000);
    expect(paintAhead.length).toBe(before + 1);
    await flush(3_500);
    expect(paintAhead.length).toBe(before + 1);
    await flush(1_500); // 5 s after it was aimed: stalled again
    expect(paintAhead.length).toBe(before + 2);
  });

  test('paused, a stalled paint-ahead is left alone', async () => {
    mount({ initialTime: 0, coverage: coverage([[0, 100]], keys('a')) });
    await flush(1_000);
    const start = paintAhead.length;
    await flush(60_000);
    expect(paintAhead.length).toBe(start);
  });

  test('a seek cancels the in-flight requests it no longer needs (AbortController) and asks from the new playhead', async () => {
    const p = mount({ initialTime: 0 });
    await flush();
    const before = [...requests];
    expect(before).toHaveLength(4);

    act(() => p.result.current.seek(100));
    await flush();
    expect(before.every(r => r.signal.aborted)).toBe(true);
    expect(open().map(r => r.frame)).toEqual([2400, 2401, 2402, 2403]);
    expect(open()[0]!.prio).toBe('preview');
    expect(p.result.current.time).toBe(100);
  });

  test('scrubbing never piles requests up: only the latest position\'s stay open', async () => {
    const p = mount({ initialTime: 0 });
    await flush();
    for (let s = 1; s <= 30; s++) {
      act(() => p.result.current.seek(s * 5));
      await flush(16);
      expect(open().length).toBeLessThanOrEqual(4);
    }
    expect(open().every(r => r.frame >= 150 * 24)).toBe(true);
  });

  test('a seek onto a frame already on its way as a prefetch asks for it again as a preview', async () => {
    const p = mount({ initialTime: 0 });
    await flush();
    const prefetched = requests.find(r => r.frame === 2)!;
    expect(prefetched.prio).toBe('prefetch');
    act(() => p.result.current.seek(2 / 24));
    await flush();
    expect(prefetched.signal.aborted).toBe(true);
    expect(open().find(r => r.frame === 2)!.prio).toBe('preview');
    expect(requests.find(r => r.frame === 3)!.signal.aborted).toBe(false); // still in the new window
  });

  test('a frame whose answer comes after a seek is dropped, not drawn', async () => {
    const p = mount({ initialTime: 0 });
    await flush();
    const first = requests[0]!;
    act(() => p.result.current.seek(50));
    await flush();
    answer(first, frameResponse(0, 'a1')); // the old request resolves anyway (a race with the abort)
    await flush();
    expect(drawn).toEqual([]);
  });
});

describe('segment keys (Review Focus 2)', () => {
  test('an answer painted under a chapter\'s old key is never drawn once segments[n] has changed', async () => {
    const p = mount({ initialTime: 0 });
    await flush();
    const old = requests.find(r => r.frame === 0)!;
    p.update({ segmentKeys: keys('a', { 1: 'b1' }), coverage: coverage([], keys('a', { 1: 'b1' })) });
    await flush();
    expect(old.signal.aborted).toBe(true); // chapter 1's requests were for the old code
    answer(old, frameResponse(0, 'a1'));
    await flush();
    expect(drawn).toEqual([]);

    answerFrame(0, 'b1');
    await flush();
    expect(drawn).toEqual(['frame 0 b1']);
  });

  test('frames already in memory from the old key are dropped and fetched again; other chapters\' are kept', async () => {
    const p = mount({ initialTime: 22, coverage: coverage([[0, N - 1]], keys('a')) }); // frame 528, near chapter 2
    await flush();
    await serveAll(keys('a'));
    expect(drawn).toEqual(['frame 528 a1']);
    const asked = requests.length;
    const drawnBefore = drawn.length;

    p.update({ segmentKeys: keys('a', { 1: 'b1' }), coverage: coverage([[CH2, N - 1]], keys('a', { 1: 'b1' })) });
    await flush();
    // chapter 1's frames (528..551) are asked for again; chapter 2's (552..575) were kept
    const again = requests.slice(asked).map(r => r.frame);
    expect(again.every(i => i < CH2)).toBe(true);
    expect(again).toContain(528);
    await serveAll(keys('a', { 1: 'b1' }));
    expect(drawn.at(-1)).toBe('frame 528 b1');
    expect(drawn.slice(drawnBefore).filter(d => d.endsWith(' a1'))).toEqual([]);
    expect(requests.slice(asked).some(r => r.frame >= CH2 && r.frame < CH2 + 24)).toBe(false);
  });

  test('a decode that finishes after the key changed is not drawn', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    decode = async blob => {
      const label = await blob.text();
      await gate;
      return { label, close() {} };
    };
    const p = mount({ initialTime: 0 });
    await flush();
    answerFrame(0, 'a1');
    await flush();
    p.update({ segmentKeys: keys('a', { 1: 'b1' }), coverage: coverage([], keys('a', { 1: 'b1' })) });
    await flush();
    release();
    await flush();
    expect(drawn).toEqual([]);
  });

  test('an answer under a key the player doesn\'t know yet is dropped, the coverage is refreshed, and it isn\'t asked for in a loop', async () => {
    const onStaleKeys = vi.fn();
    const p = mount({ initialTime: 0, onStaleKeys });
    await flush();
    answerFrame(0, 'b1'); // the server already has chapter 1's new code
    await flush(5_000);
    expect(drawn).toEqual([]);
    expect(onStaleKeys).toHaveBeenCalledTimes(1);
    expect(framesAsked().filter(i => i === 0)).toHaveLength(1);

    p.update({ segmentKeys: keys('a', { 1: 'b1' }), coverage: coverage([], keys('a', { 1: 'b1' })) });
    await flush();
    answerFrame(0, 'b1');
    await flush();
    expect(drawn).toEqual(['frame 0 b1']);
  });
});

describe('playback', () => {
  test('Play waits until everything from the playhead to the end is cached, then plays in sync with the song', async () => {
    const p = mount({ initialTime: 3700 / 24, coverage: coverage([[3700, 3730]], keys('a')) });
    await flush();
    await serveAll(keys('a'), { except: new Set(Array.from({ length: 28 }, (_, k) => 3731 + k)) });
    expect(p.result.current.safeIn).not.toBe(0);
    expect(p.result.current.aheadReady).toBeCloseTo(31 / 24, 9);

    act(() => p.result.current.play());
    expect(p.result.current.state).toBe('waiting');
    expect(p.audio.play).not.toHaveBeenCalled();

    // the rest gets painted
    p.update({ coverage: coverage([[3700, N - 1]], keys('a')) });
    await flush();
    await serveAll(keys('a'));
    expect(p.result.current.safeIn).toBe(0);
    expect(p.result.current.state).toBe('playing');
    expect(p.audio.play).toHaveBeenCalledTimes(1);
    expect(p.audio.currentTime).toBeCloseTo(3700 / 24, 9);

    // the picture follows the song's clock
    p.audio.currentTime = 3712 / 24 + 0.01;
    await flush(20);
    expect(drawn.at(-1)).toBe('frame 3712 a9');
    expect(p.result.current.time).toBeCloseTo(3712 / 24, 9);
  });

  test('Play plays at once when it\'s safe', async () => {
    const p = mount({ initialTime: 0, coverage: coverage([[0, N - 1]], keys('a')) });
    await flush();
    await serveAll(keys('a'));
    expect(p.result.current.safeIn).toBe(0);
    act(() => p.result.current.play());
    expect(p.result.current.state).toBe('playing');
    expect(p.audio.play).toHaveBeenCalledTimes(1);
    act(() => p.result.current.pause());
    expect(p.result.current.state).toBe('paused');
    expect(p.audio.pause).toHaveBeenCalled();
  });

  test('"Play now" plays what\'s ready, stops at a gap, and resumes when the frame arrives', async () => {
    const GAP = 250;
    const p = mount({ initialTime: 10, coverage: coverage([[240, GAP - 1], [GAP + 1, N - 1]], keys('a')) });
    await flush();
    await serveAll(keys('a'), { except: new Set([GAP]) });
    expect(p.result.current.aheadReady).toBeCloseTo(10 / 24, 9);
    expect(p.result.current.safeIn).not.toBe(0);

    act(() => p.result.current.playNow());
    expect(p.result.current.state).toBe('playing');
    p.audio.currentTime = 249 / 24 + 0.01;
    await flush(20);
    expect(drawn.at(-1)).toBe('frame 249 a1');

    p.audio.currentTime = GAP / 24 + 0.01;
    await flush(20);
    expect(p.result.current.state).toBe('waiting');
    expect(p.audio.paused).toBe(true);
    expect(drawn.at(-1)).toBe('frame 249 a1');

    answerFrame(GAP, 'a1');
    await flush(20);
    expect(p.result.current.state).toBe('playing');
    expect(p.audio.play).toHaveBeenCalledTimes(2);
    expect(p.audio.currentTime).toBeCloseTo(GAP / 24, 9);
    expect(drawn.at(-1)).toBe('frame 250 a1');
  });

  test('after "Play now" stops at a gap, it resumes only once the rest can play without stopping', async () => {
    const p = mount({ initialTime: 10, coverage: coverage([[240, 249], [252, N - 1]], keys('a')) });
    await flush();
    await serveAll(keys('a'), { except: new Set([250, 251]) });
    act(() => p.result.current.playNow());
    p.audio.currentTime = 250 / 24 + 0.01;
    await flush(20);
    expect(p.result.current.state).toBe('waiting');
    expect(p.result.current.starting).toBe(false);

    answerFrame(250, 'a1'); // the first missing frame: 251 still isn't there
    await flush(20);
    expect(p.result.current.state).toBe('waiting');
    expect(p.audio.play).toHaveBeenCalledTimes(1);

    answerFrame(251, 'a1');
    await flush(20);
    expect(p.result.current.state).toBe('playing');
    expect(p.audio.play).toHaveBeenCalledTimes(2);
  });

  test('a late pause event from a gap doesn\'t stop playback that has already resumed', async () => {
    const GAP = 250;
    const p = mount({ initialTime: 10, coverage: coverage([[240, N - 1]], keys('a')) });
    p.audio.asyncPauseEvent = true;
    await flush();
    await serveAll(keys('a'), { except: new Set([GAP]) });
    act(() => p.result.current.play());
    expect(p.result.current.state).toBe('playing');
    // jumping onto the missing frame stops the song at a gap; the frame arrives (and playback resumes) before the
    // song's pause event has fired
    await act(async () => {
      p.result.current.seek(GAP / 24);
      expect(p.audio.pause).toHaveBeenCalledTimes(1);
      answerFrame(GAP, 'a1');
      for (let k = 0; k < 5; k++) await new Promise(r => setImmediate(r));
      expect(p.audio.play).toHaveBeenCalledTimes(2);
    });
    await flush(50); // now the stale pause event fires
    expect(p.result.current.state).toBe('playing');
    expect(p.audio.paused).toBe(false);
  });

  test('a pause from outside (a media key) is followed', async () => {
    const p = mount({ initialTime: 0, coverage: coverage([[0, N - 1]], keys('a')) });
    p.audio.asyncPauseEvent = true;
    await flush();
    await serveAll(keys('a'));
    act(() => p.result.current.play());
    act(() => {
      p.audio.pause();
    });
    await flush(10);
    expect(p.result.current.state).toBe('paused');
  });

  test('"Play now" on a cached frame not fetched yet starts as soon as it arrives', async () => {
    const p = mount({ initialTime: 0, coverage: coverage([[0, 100]], keys('a')) });
    await flush();
    act(() => p.result.current.playNow());
    expect(p.result.current.state).toBe('waiting');
    expect(p.result.current.starting).toBe(true);
    answerFrame(0, 'a1');
    await flush();
    expect(p.result.current.state).toBe('playing');
    expect(p.audio.play).toHaveBeenCalledTimes(1);
  });

  test('playback stops cleanly where a chapter isn\'t written yet', async () => {
    const segments = keys('a', { 2: null, 3: null, 4: null, 5: null, 6: null, 7: null, 8: null, 9: null });
    const p = mount({ initialTime: 22, segmentKeys: segments, coverage: coverage([[0, CH2 - 1]], segments) });
    await flush();
    await serveAll(segments);
    expect(p.result.current.safeIn).toBe(0); // everything up to chapter 2 is there
    act(() => p.result.current.play());
    expect(p.result.current.state).toBe('playing');
    p.audio.currentTime = 23.01;
    await flush(20);
    expect(p.result.current.state).toBe('paused');
    expect(p.audio.paused).toBe(true);
    expect(p.result.current.error).toMatch(/chapter 2 isn't written yet/i);
    expect(framesAsked().every(i => i < CH2)).toBe(true);
  });

  test('seeking while waiting to a part that can play starts it', async () => {
    const p = mount({ initialTime: 0, coverage: coverage([[1200, N - 1]], keys('a')) });
    await flush();
    act(() => p.result.current.play());
    expect(p.result.current.state).toBe('waiting');
    act(() => p.result.current.seek(60));
    await flush();
    await serveAll(keys('a'));
    expect(p.result.current.state).toBe('playing');
    expect(p.audio.currentTime).toBe(60);
  });

  test('the song ending leaves the player paused at the end', async () => {
    const p = mount({ initialTime: 156, coverage: coverage([[0, N - 1]], keys('a')) });
    await flush();
    await serveAll(keys('a'));
    act(() => p.result.current.play());
    p.audio.currentTime = 156.6;
    p.audio.paused = true;
    act(() => {
      p.audio.dispatchEvent(new Event('ended'));
    });
    expect(p.result.current.state).toBe('paused');
  });
});

describe('a broken segment (Review Focus 1)', () => {
  test('shows the error and doesn\'t ask for that chapter again in a loop; other chapters keep going', async () => {
    const p = mount({ initialTime: 0 });
    await flush();
    for (const r of open().filter(r => r.frame < CH2)) {
      answer(r, new Response(JSON.stringify({ error: 'chapter one is broken' }), { status: 409 }));
    }
    await flush();
    expect(p.result.current.error).toContain('chapter one is broken');
    const chapterOneAsks = requests.filter(r => r.frame < CH2).length;
    expect(chapterOneAsks).toBeLessThanOrEqual(4);

    await flush(30_000);
    expect(requests.filter(r => r.frame < CH2)).toHaveLength(chapterOneAsks);

    act(() => p.result.current.play());
    expect(p.result.current.state).not.toBe('playing');
    expect(p.audio.play).not.toHaveBeenCalled();
  });

  test('a chapter the server says it doesn\'t have waits for new keys instead of being asked for frame by frame', async () => {
    const onStaleKeys = vi.fn();
    const p = mount({ initialTime: 0, onStaleKeys });
    await flush();
    for (const r of open().filter(r => r.frame < CH2)) answer(r, new Response(JSON.stringify({ error: "chapter 1 isn't written yet" }), { status: 404 }));
    await flush(10_000);
    expect(onStaleKeys).toHaveBeenCalledTimes(1);
    expect(requests.filter(r => r.frame < CH2)).toHaveLength(4);
    // the server's reason, as a chapter that can't play rather than a broken one
    expect(p.result.current.error).toBe("Chapter 1 isn't written yet.");
  });

  test('a chapter the coverage lists as broken is not asked for at all', async () => {
    const segments = keys('a');
    const p = mount({ initialTime: 30, segmentKeys: segments, coverage: coverage([], segments, [{ chapter: 2, error: 'boom' }]) });
    await flush(5_000);
    expect(p.result.current.error).toContain('boom');
    expect(requests.some(r => chapterOf(r.frame) === 2)).toBe(false);
    expect(p.result.current.safeIn).toBeNull();
  });

  test('playing into a broken chapter stops there, with its error', async () => {
    const segments = keys('a');
    const p = mount({
      initialTime: 22,
      segmentKeys: segments,
      coverage: coverage([[0, CH2 - 1]], segments, [{ chapter: 2, error: 'chapter two threw' }]),
    });
    await flush();
    await serveAll(segments);
    expect(p.result.current.error).toBeNull();
    act(() => p.result.current.play());
    expect(p.result.current.state).toBe('playing');
    p.audio.currentTime = 23.01;
    await flush(20);
    expect(p.result.current.state).toBe('paused');
    expect(p.result.current.error).toContain('chapter two threw');
  });
});

describe('safe to play', () => {
  test('becomes true (0) exactly when the remaining frames are cached', async () => {
    const p = mount({ initialTime: 3700 / 24, coverage: coverage([], keys('a')) });
    await flush();
    expect(p.result.current.safeIn).toBeNull(); // no paint rate measured yet
    p.update({ coverage: coverage([[3700, 3757]], keys('a')) });
    await flush();
    expect(p.result.current.safeIn).not.toBe(0);
    p.update({ coverage: coverage([[3700, N - 1]], keys('a')) });
    await flush();
    expect(p.result.current.safeIn).toBe(0);
  });

  test('estimates the wait from the measured paint rate', async () => {
    const p = mount({ initialTime: 3700 / 24, coverage: coverage([[3700, 3709]], keys('a')) });
    await flush();
    await flush(4_000);
    p.update({ coverage: coverage([[3700, 3717]], keys('a')) }); // 8 frames in 4 s: 2 frames/s
    await flush();
    // 41 frames still missing (3718..3758) at 2 frames/s
    expect(p.result.current.safeIn).toBeCloseTo(20.5, 1);
  });
});

describe('the server\'s coverage shrinking (evicted, cleared)', () => {
  test('frames fetched here that the server no longer has stop counting as cached, and "safe to play" falls back', async () => {
    const p = mount({ initialTime: 3700 / 24, coverage: coverage([[3700, N - 1]], keys('a')) });
    await flush();
    await serveAll(keys('a')); // the paused window: 3700..3747
    expect(p.result.current.safeIn).toBe(0);
    // the cache was cleared (in another tab, say), and only the song's last frames painted again since
    p.update({ coverage: coverage([[3748, N - 1]], keys('a')) });
    await flush();
    expect(p.result.current.safeIn).not.toBe(0);
    expect(p.result.current.aheadReady).toBe(0);
    act(() => p.result.current.play());
    expect(p.result.current.state).toBe('waiting');
    // painted again: it plays
    p.update({ coverage: coverage([[3700, N - 1]], keys('a')) });
    await flush();
    expect(p.result.current.safeIn).toBe(0);
    expect(p.result.current.state).toBe('playing');
  });
});

describe('the server refusing frames', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  test('a 403 for a stale token (the studio restarted) says the page needs a reload', async () => {
    mount();
    await flush();
    answer(open()[0]!, json(403, { error: 'missing or wrong token' }));
    await flush();
    expect(restartedState.value).toBe(true);
  });

  test('a 403 for anything else does not', async () => {
    mount();
    await flush();
    answer(open()[0]!, json(403, { error: 'cross-site requests are not allowed' }));
    await flush();
    expect(restartedState.value).toBe(false);
  });

  const refuse = (reason = 'no Chromium-based browser found') => {
    for (const r of open()) answer(r, json(503, { error: 'the studio cannot paint frames right now', reason }));
  };

  test('a 503 (no painting browser) shows the server\'s reason instead of "painting"; paused, it asks nothing more; playing, one frame every 5 s; a painted frame clears it', async () => {
    const p = mount({ initialTime: 0 });
    await flush();
    expect(p.result.current.cantPaint).toBeNull();
    refuse();
    await flush();
    expect(p.result.current.painting).toBe(true);
    expect(p.result.current.cantPaint).toBe('no Chromium-based browser found');
    expect(requests).toHaveLength(4); // not the rest of the window, which would only be refused too
    await flush(30_000);
    expect(requests).toHaveLength(4); // paused: nobody is waiting for it
    act(() => p.result.current.play());
    await flush();
    expect(framesAsked().slice(4)).toEqual([0]); // Play asks at once
    refuse();
    await flush(4_000);
    expect(requests).toHaveLength(5);
    await flush(1_500);
    expect(framesAsked().slice(5)).toEqual([0]); // and every 5 s while it waits
    answerFrame(0, 'a1');
    await flush();
    expect(p.result.current.cantPaint).toBeNull();
    expect(open()).toHaveLength(4); // and the window is asked for again
  });

  test.each([
    ['a seek', (p: ReturnType<typeof mount>) => p.result.current.seek(2 / 24)],
    ['Play now', (p: ReturnType<typeof mount>) => p.result.current.playNow()],
  ])('with the playhead\'s frame already on screen, %s asks whether the server can paint again', async (_, ask) => {
    const p = mount({ initialTime: 0 });
    await flush();
    for (const i of [0, 1, 2, 3]) answerFrame(i, 'a1');
    await flush();
    expect(p.result.current.painting).toBe(false);
    refuse('no browser');
    await flush();
    expect(p.result.current.cantPaint).toBe('no browser');
    const asked = requests.length;
    await flush(30_000);
    expect(requests).toHaveLength(asked); // paused
    act(() => ask(p));
    await flush();
    expect(requests).toHaveLength(asked + 1); // one frame, to ask
    answer(open()[0]!, frameResponse(open()[0]!.frame, 'a1'));
    await flush();
    expect(p.result.current.cantPaint).toBeNull();
    expect(open()).toHaveLength(4);
  });

  test('a seek while the server could still paint leaves no probe owing for when it later can\'t', async () => {
    const p = mount({ initialTime: 0 });
    await flush();
    act(() => p.result.current.seek(10));
    await flush();
    const asked = requests.length;
    refuse();
    await flush();
    expect(p.result.current.cantPaint).toBe('no Chromium-based browser found');
    await flush(30_000);
    expect(requests).toHaveLength(asked); // paused: nothing, not even one frame left over from the seek
  });

  test('a frame the server already had doesn\'t say it can paint again: only a painted one does', async () => {
    const p = mount({ initialTime: 0, coverage: coverage([[0, 1]], keys('a')) });
    await flush();
    for (const r of open().filter(r => r.frame >= 2)) answer(r, json(503, { error: 'no', reason: 'no browser' }));
    await flush();
    expect(p.result.current.cantPaint).toBe('no browser');
    answerFrame(0, 'a1'); // cached: served without painting
    await flush();
    expect(p.result.current.cantPaint).toBe('no browser');
    act(() => p.result.current.play());
    await flush();
    const probe = open().find(r => r.frame >= 2)!;
    answer(probe, frameResponse(probe.frame, 'a1'));
    await flush();
    expect(p.result.current.cantPaint).toBeNull();
  });
});
