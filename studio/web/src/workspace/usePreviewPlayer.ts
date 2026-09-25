// usePreviewPlayer.ts: plays a version's server-painted frames in sync with the song. Chapter code never runs here:
// frames are JPEGs from GET /api/frames/<version>/<i>.jpg, painted by the studio's sealed painting pool and cached by
// content (studio/frames/). This page only fetches, decodes (createImageBitmap, off the main thread) and draws them onto
// a <canvas>, with the picture following the song's clock (audio.currentTime).
//
// Scheduling: at most MAX_IN_FLIGHT requests at once.
//   - First the window ahead of the playhead (48 frames while paused, 120 while playing): fetched and kept in memory
//     as JPEG blobs; only a few frames around the playhead are decoded to bitmaps at a time (1080p bitmaps are 8 MB).
//     The playhead frame goes as a `preview` (the server paints it first and drops older previews); the rest as
//     `prefetch`.
//   - Then, with any request left over, frames past the window the server hasn't cached yet (from the coverage), so
//     the rest of the song gets painted and "safe to play" comes closer. Their bytes aren't kept. A window frame
//     that needs a slot takes one from these.
//   - A seek cancels (AbortController) every request the new position doesn't need: the server withdraws them from
//     its painting queue (Review Focus 3).
//
// Rules, as the old player had them: never stutter. Play waits until every frame from the playhead to the end (or to
// the first chapter that can't be shown) is cached, then plays. "Play now" plays what's cached from the playhead on,
// and if it reaches a frame that isn't, it stops there and waits like Play does.
//
// Segment keys (Review Focus 2): every frame is fetched and kept with the segment key it was painted under (the
// response's ETag, "<segment key>.<deps hash>"), and is drawn only while that is still its chapter's current key
// (coverage.segments). When a chapter's key changes, its frames in memory and in flight are dropped.
//
// Broken segments (Review Focus 1): a 409 (or the coverage's broken list) marks the chapter's key broken; its frames
// aren't asked for again until the key changes or the server stops reporting it broken, playback stops where it
// starts, and the error is shown.
import { useCallback, useEffect, useRef, useState } from 'react';
import { frameUrl } from '@/api/client';
import type { Coverage, Song } from '@/api/types';

export type PlayerState = 'paused' | 'waiting' | 'playing';
type Segments = Coverage['segments'];

export interface PreviewPlayerOptions {
  versionId: string;
  song: Song | undefined;
  coverage: Coverage | undefined;
  segmentKeys: Segments | undefined;
  // Where the playhead starts, in seconds (the URL's t).
  initialTime?: number;
  // The song. Made from /assets/pdoom.mp3 when left out (tests pass a fake).
  audio?: HTMLAudioElement;
  // A frame came back painted under a key this player doesn't know: its coverage (and keys) are out of date.
  onStaleKeys?: () => void;
}

export interface PreviewPlayer {
  state: PlayerState;
  time: number; // the playhead, in seconds
  play(): void; // Play, or Pause while playing, or cancel waiting
  pause(): void;
  seek(t: number): void;
  playNow(): void;
  // Seconds until it's safe to play from the playhead (0: it is), or null when that can't be told yet.
  safeIn: number | null;
  // Seconds cached from the playhead on, without a gap: what "Play now" would play.
  aheadReady: number;
  // Why the playhead's frame can't be shown: a broken chapter's error, or a chapter not written yet.
  error: string | null;
  // The playhead's frame isn't on screen yet (being fetched or painted).
  painting: boolean;
  canvasRef: (el: HTMLCanvasElement | null) => void;
}

export const MAX_IN_FLIGHT = 6;
const WINDOW_PAUSED = 48;
const WINDOW_PLAYING = 120;
const KEEP_BEHIND = 24; // blobs kept behind the playhead, for a small step back
const DECODE_AHEAD = 8;
const RATE_WINDOW_MS = 20_000; // paint rate measured over this much coverage history
const PUMP_EVERY_MS = 500;

interface Snapshot {
  state: PlayerState;
  time: number;
  safeIn: number | null;
  aheadReady: number;
  error: string | null;
  painting: boolean;
}

interface InFlight {
  ctrl: AbortController;
  keep: boolean; // a window frame: its bytes are kept
}

// The segment key in a frame's ETag: "<segment key>.<deps hash>".
const keyOfEtag = (etag: string | null) => (etag ?? '').replace(/^W\//, '').replace(/"/g, '').split('.')[0] ?? '';

export class PreviewEngine {
  private fps = 24;
  private frames = 0;
  private chapterOf = new Uint8Array(0);
  private keys: Segments | null = null;
  private covered = new Uint8Array(0);
  private local = new Set<number>(); // fetched under the current key: cached, whatever the coverage says yet
  private coverageBroken = new Map<number, string>(); // chapter -> error, from the coverage
  private localBroken = new Map<string, string>(); // segment key -> error, from a 409
  private samples: Array<[number, number]> = []; // [time ms, frames covered], for the paint rate

  private ph = 0;
  private coverage: Coverage | undefined; // the latest, applied once the song is known
  private pendingKeys: Segments | undefined;
  private mode: PlayerState = 'paused';
  private blobs = new Map<number, { key: string; blob: Blob }>();
  private bitmaps = new Map<number, { key: string; bitmap: Promise<ImageBitmap | null> }>();
  private inflight = new Map<number, InFlight>();
  private retryAt = new Map<number, number>();
  private mismatched = new Map<number, string | null>(); // frame -> its key when an answer came under another
  private staleReported = false;
  private shown = -1;
  private shownKey: string | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ownPause = false;
  private nowPending = false; // "Play now" pressed before the playhead's (cached) frame reached this page
  private raf = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private last: Snapshot | null = null;

  onChange: () => void = () => {};
  onStaleKeys: () => void = () => {};

  constructor(
    private readonly versionId: string,
    private readonly audio: HTMLAudioElement,
    private readonly initialTime = 0,
  ) {
    this.ph = Math.max(0, Math.floor(initialTime * this.fps + 1e-6));
  }

  // ---- lifecycle (start/stop pairs, so React's StrictMode can run the effect twice) ----

  start() {
    if (this.running) return;
    this.running = true;
    this.audio.addEventListener('pause', this.onAudioPause);
    this.audio.addEventListener('ended', this.onAudioEnded);
    this.timer = setInterval(() => {
      this.pump();
      this.notify();
    }, PUMP_EVERY_MS);
    this.pump();
    this.notify();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.audio.removeEventListener('pause', this.onAudioPause);
    this.audio.removeEventListener('ended', this.onAudioEnded);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    cancelAnimationFrame(this.raf);
    if (this.mode === 'playing') {
      this.ownPause = true;
      this.audio.pause();
    }
    this.mode = 'paused';
    for (const i of [...this.inflight.keys()]) this.abort(i);
    for (const i of [...this.bitmaps.keys()]) this.dropBitmap(i);
  }

  // ---- inputs ----

  setSong(song: Song | undefined) {
    if (!song || this.frames) return;
    this.fps = song.fps;
    this.frames = song.frames;
    this.chapterOf = new Uint8Array(song.frames).map((_, i) => {
      const k = song.chapters.findIndex(([a, b]) => i / song.fps >= a && i / song.fps < b);
      return k >= 0 ? k + 1 : song.chapters.length;
    });
    this.covered = new Uint8Array(song.frames);
    this.ph = this.frameOf(this.initialTime);
    this.update(this.pendingKeys, this.coverage);
  }

  // The server's view of the version: each chapter's segment key, and what's cached and broken. Applied together, so
  // nothing is asked for under new keys before the coverage has said which chapters are broken.
  update(keys: Segments | undefined, coverage: Coverage | undefined) {
    this.pendingKeys = keys;
    this.coverage = coverage;
    if (!this.frames) return; // applied once the song is known
    this.applyKeys(keys);
    this.applyCoverage(coverage);
    if (this.mode === 'playing') {
      if (this.blockedAt(this.ph)) this.stopAt(this.ph);
      else if (!this.hasBlob(this.ph)) this.gap();
    }
    this.maybeResume();
    this.pump();
    this.draw(this.ph);
    this.notify();
  }

  private applyKeys(keys: Segments | undefined) {
    if (!keys) return;
    const old = this.keys;
    const changed = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(n => (old?.[n] ?? null) !== (keys[n] ?? null));
    if (old && !changed.length) return;
    this.keys = { ...keys };
    this.staleReported = false;
    if (!old) return;
    // A chapter's code (or the options, or shared.js) changed: whatever this page holds for it is from older code.
    const stale = (i: number) => changed.includes(this.chapterOf[i]!);
    for (const i of [...this.inflight.keys()]) if (stale(i)) this.abort(i);
    for (const i of [...this.blobs.keys()]) if (stale(i)) this.blobs.delete(i);
    for (const i of [...this.bitmaps.keys()]) if (stale(i)) this.dropBitmap(i);
    for (const i of [...this.local]) if (stale(i)) this.local.delete(i);
    for (const i of [...this.mismatched.keys()]) if (stale(i)) this.mismatched.delete(i);
    for (const i of [...this.retryAt.keys()]) if (stale(i)) this.retryAt.delete(i);
    this.samples = [];
  }

  private applyCoverage(coverage: Coverage | undefined) {
    if (!coverage) return;
    this.covered.fill(0);
    let count = 0;
    for (const [a, b] of coverage.ranges) {
      this.covered.fill(1, Math.max(0, a), Math.min(this.frames, b + 1));
      count += b - a + 1;
    }
    // A chapter the server no longer reports broken (a timeout's break expired, say) may be asked for again; one it
    // newly reports broken isn't waited on any longer.
    const nowBroken = new Map(coverage.broken.map(b => [b.chapter, b.error]));
    for (const n of this.coverageBroken.keys()) {
      const key = this.keys?.[n];
      if (!nowBroken.has(n) && key) this.localBroken.delete(key);
    }
    this.coverageBroken = nowBroken;
    for (const i of [...this.inflight.keys()]) if (nowBroken.has(this.chapterOf[i]!)) this.abort(i);
    // the paint rate, from how fast the coverage grows
    const now = Date.now();
    if (this.samples.length && count < this.samples.at(-1)![1]) this.samples = [];
    this.samples.push([now, count]);
    while (this.samples.length > 2 && this.samples[1]![0] < now - RATE_WINDOW_MS) this.samples.shift();
  }

  setCanvas(canvas: HTMLCanvasElement | null) {
    this.canvas = canvas;
    this.shown = -1;
    this.draw(this.ph);
  }

  // ---- what's where ----

  private frameOf(t: number) {
    return Math.min(Math.max(0, this.frames - 1), Math.max(0, Math.floor(t * this.fps + 1e-6)));
  }

  private keyOf(i: number): string | null | undefined {
    return this.keys?.[this.chapterOf[i]!];
  }

  // Why frame i can't be had: its chapter isn't written, or is broken. Null when it can (or keys aren't known yet).
  private blockedAt(i: number): string | null {
    if (!this.keys) return null;
    const n = this.chapterOf[i]!;
    const key = this.keys[n];
    if (!key) return `Chapter ${n} isn't written yet.`;
    const error = this.coverageBroken.get(n) ?? this.localBroken.get(key);
    return error == null ? null : `Chapter ${n} failed to paint: ${error}`;
  }

  // The first frame from i on that can't be had (the end of what can play from i), or the song's end.
  private endFrom(i: number) {
    let k = i;
    while (k < this.frames && !this.blockedAt(k)) {
      // skip to the next chapter: a chapter is blocked as a whole
      const n = this.chapterOf[k]!;
      while (k < this.frames && this.chapterOf[k] === n) k++;
    }
    return Math.min(k, this.frames);
  }

  private isCached(i: number) {
    return this.covered[i] === 1 || this.local.has(i);
  }

  private hasBlob(i: number) {
    const b = this.blobs.get(i);
    return !!b && b.key === this.keyOf(i);
  }

  private safeNow() {
    const end = this.endFrom(this.ph);
    if (end <= this.ph) return false;
    for (let i = this.ph; i < end; i++) if (!this.isCached(i)) return false;
    return true;
  }

  private paintRate(): number | null {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last) return null;
    const dt = (Date.now() - first[0]) / 1000;
    const grown = last[1] - first[1];
    return dt >= 1 && grown > 0 ? grown / dt : null;
  }

  snapshot(): Snapshot {
    const ready = this.frames > 0 && !!this.keys;
    const end = ready ? this.endFrom(this.ph) : this.ph;
    let ahead = 0;
    let missing = 0;
    if (ready) {
      while (this.ph + ahead < end && this.isCached(this.ph + ahead)) ahead++;
      for (let i = this.ph + ahead; i < end; i++) if (!this.isCached(i)) missing++;
    }
    const rate = this.paintRate();
    const safeIn = !ready || end <= this.ph ? null : missing === 0 ? 0 : rate ? missing / rate : null;
    return {
      state: this.mode,
      time: this.ph / this.fps,
      safeIn,
      aheadReady: ahead / this.fps,
      error: ready ? this.blockedAt(this.ph) : null,
      painting: !(this.shown === this.ph && this.shownKey != null && this.shownKey === this.keyOf(this.ph)),
    };
  }

  private notify() {
    const next = this.snapshot();
    const last = this.last;
    if (
      last &&
      last.state === next.state &&
      last.time === next.time &&
      last.safeIn === next.safeIn &&
      last.aheadReady === next.aheadReady &&
      last.error === next.error &&
      last.painting === next.painting
    ) {
      return;
    }
    this.last = next;
    this.onChange();
  }

  current(): Snapshot {
    return (this.last ??= this.snapshot());
  }

  // ---- requests ----

  private window() {
    return this.mode === 'playing' ? WINDOW_PLAYING : WINDOW_PAUSED;
  }

  private wanted(i: number) {
    if (this.inflight.has(i) || this.blockedAt(i) || !this.keyOf(i)) return false;
    if ((this.retryAt.get(i) ?? 0) > Date.now()) return false;
    const m = this.mismatched.get(i);
    return m === undefined || m !== this.keyOf(i);
  }

  private pump() {
    if (!this.running || !this.frames || !this.keys) return;
    // requests for frames the playhead has passed are of no use any more
    for (const [i, f] of this.inflight) if (f.keep && i < this.ph) this.abort(i);
    const end = this.endFrom(this.ph);
    const windowEnd = Math.min(end, this.ph + this.window());
    const want: Array<{ i: number; keep: boolean }> = [];
    for (let i = this.ph; i < windowEnd && want.length < MAX_IN_FLIGHT; i++) {
      if (!this.hasBlob(i) && this.wanted(i)) want.push({ i, keep: true });
    }
    for (let i = Math.max(windowEnd, this.ph); i < this.frames && want.length < MAX_IN_FLIGHT; i++) {
      if (!this.isCached(i) && this.wanted(i)) want.push({ i, keep: false });
    }
    for (const { i, keep } of want) {
      if (this.inflight.size >= MAX_IN_FLIGHT) {
        // a window frame takes the slot of the farthest frame that is only being painted
        const far = [...this.inflight].filter(([, f]) => !f.keep).sort((a, b) => b[0] - a[0])[0];
        if (!keep || !far) break;
        this.abort(far[0]);
      }
      this.request(i, keep);
    }
  }

  private abort(i: number) {
    const f = this.inflight.get(i);
    if (!f) return;
    this.inflight.delete(i);
    f.ctrl.abort();
  }

  private request(i: number, keep: boolean) {
    const ctrl = new AbortController();
    const key = this.keyOf(i)!;
    this.inflight.set(i, { ctrl, keep });
    const mine = () => this.inflight.get(i)?.ctrl === ctrl;
    const prio = keep && i === this.ph ? 'preview' : 'prefetch';
    const settle = (retryInMs?: number) => {
      if (!mine()) return false;
      this.inflight.delete(i);
      if (retryInMs) this.retryAt.set(i, Date.now() + retryInMs);
      return true;
    };
    fetch(frameUrl(this.versionId, i, prio), { signal: ctrl.signal })
      .then(async res => {
        if (!mine()) return;
        if (res.status === 200) {
          const painted = keyOfEtag(res.headers.get('etag'));
          const blob = keep ? await res.blob() : (await res.body?.cancel().catch(() => {}), null);
          if (!settle()) return;
          this.arrived(i, painted, blob);
        } else if (res.status === 409) {
          const error = await res
            .json()
            .then((b: { error?: string }) => b.error)
            .catch(() => undefined);
          if (!settle()) return;
          this.localBroken.set(key, error || 'the chapter failed to paint');
        } else if (res.status === 404) {
          // the server has no such chapter (or version): what this page knows of the version is out of date. The
          // chapter waits for new keys rather than being asked for frame by frame.
          if (!settle()) return;
          this.localBroken.set(key, 'not found on the server');
          this.mismatch(i);
        } else {
          // 202: not painted within the server's hold time; ask again, as Retry-After says
          settle(res.status === 202 ? 1000 : 2000);
        }
      })
      .catch(() => {
        settle(2000); // aborted (then it's no longer ours), or the server is unreachable: ask again in a while
      })
      .finally(() => {
        if (!this.running) return;
        this.pump();
        this.notify();
      });
  }

  private mismatch(i: number) {
    this.mismatched.set(i, this.keyOf(i) ?? null);
    if (!this.staleReported) {
      this.staleReported = true;
      this.onStaleKeys();
    }
  }

  private arrived(i: number, painted: string, blob: Blob | null) {
    if (painted !== this.keyOf(i)) {
      this.mismatch(i);
      return;
    }
    this.local.add(i);
    if (blob && i >= this.ph - KEEP_BEHIND && i < this.ph + WINDOW_PLAYING) this.blobs.set(i, { key: painted, blob });
    if (i === this.ph && this.mode !== 'playing') this.draw(i);
    this.maybeResume();
  }

  // ---- drawing ----

  private bitmapOf(i: number) {
    const b = this.blobs.get(i);
    if (!b || b.key !== this.keyOf(i)) return null;
    const have = this.bitmaps.get(i);
    if (have && have.key === b.key) return have;
    if (have) this.dropBitmap(i);
    const entry = { key: b.key, bitmap: createImageBitmap(b.blob).catch(() => null) };
    this.bitmaps.set(i, entry);
    return entry;
  }

  private dropBitmap(i: number) {
    const b = this.bitmaps.get(i);
    this.bitmaps.delete(i);
    void b?.bitmap.then(bmp => bmp?.close());
  }

  private draw(i: number) {
    if (!this.canvas || (this.shown === i && this.shownKey === this.keyOf(i))) return;
    const entry = this.bitmapOf(i);
    if (!entry) return;
    void entry.bitmap.then(bmp => {
      // still the frame to show, and still from the chapter's current code
      if (!bmp || !this.canvas || this.ph !== i || entry.key !== this.keyOf(i)) return;
      this.canvas.getContext('2d')?.drawImage(bmp, 0, 0, this.canvas.width, this.canvas.height);
      this.shown = i;
      this.shownKey = entry.key;
      this.notify();
    });
  }

  private trim() {
    for (const i of this.blobs.keys()) if (i < this.ph - KEEP_BEHIND || i >= this.ph + WINDOW_PLAYING) this.blobs.delete(i);
    for (const i of this.bitmaps.keys()) if (i < this.ph - 2 || i > this.ph + DECODE_AHEAD + 4) this.dropBitmap(i);
  }

  // ---- playback ----

  private onAudioPause = () => {
    if (this.ownPause || this.mode !== 'playing') return;
    // paused from outside (a media key, the system): follow it
    cancelAnimationFrame(this.raf);
    this.mode = 'paused';
    this.pump();
    this.notify();
  };

  private onAudioEnded = () => {
    cancelAnimationFrame(this.raf);
    this.mode = 'paused';
    this.ph = Math.max(0, this.frames - 1);
    this.draw(this.ph);
    this.notify();
  };

  private startAudio() {
    this.nowPending = false;
    this.mode = 'playing';
    this.ownPause = false;
    this.audio.currentTime = this.ph / this.fps;
    const started = this.audio.play();
    started?.catch?.(() => {
      // the browser refused (no user gesture yet, say): back to paused, Play tries again
      if (this.mode !== 'playing') return;
      cancelAnimationFrame(this.raf);
      this.mode = 'paused';
      this.notify();
    });
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
    this.draw(this.ph);
    this.pump();
    this.notify();
  }

  private pauseAudio(mode: PlayerState) {
    this.nowPending = false;
    cancelAnimationFrame(this.raf);
    this.ownPause = true;
    this.audio.pause();
    this.mode = mode;
  }

  // Reached a frame that isn't here: stop the song and wait until it's safe to go on (at most one stop).
  private gap() {
    this.pauseAudio('waiting');
    this.pump();
    this.notify();
  }

  // Reached a chapter that can't be shown: stop there.
  private stopAt(i: number) {
    this.pauseAudio('paused');
    this.ph = i;
    this.pump();
    this.notify();
  }

  private maybeResume() {
    if (this.mode === 'waiting' && this.hasBlob(this.ph) && (this.nowPending || this.safeNow())) this.startAudio();
  }

  private tick = () => {
    if (this.mode !== 'playing') return;
    const i = this.frameOf(this.audio.currentTime);
    if (i !== this.ph) {
      this.ph = i;
      this.trim();
      this.pump();
    }
    if (this.blockedAt(i)) return this.stopAt(i);
    if (!this.hasBlob(i)) return this.gap();
    this.draw(i);
    for (let k = 1; k <= DECODE_AHEAD && i + k < this.frames; k++) this.bitmapOf(i + k);
    this.notify();
    this.raf = requestAnimationFrame(this.tick);
  };

  play = () => {
    if (this.mode === 'playing') return this.pause();
    if (this.mode === 'waiting') {
      this.mode = 'paused';
      this.nowPending = false;
      return this.notify();
    }
    if (!this.frames || !this.keys) return;
    if (this.ph >= this.frames - 1) this.seek(0);
    if (this.blockedAt(this.ph)) return this.notify();
    if (this.safeNow() && this.hasBlob(this.ph)) return this.startAudio();
    this.mode = 'waiting';
    this.pump();
    this.notify();
  };

  playNow = () => {
    if (this.mode === 'playing' || !this.frames || this.blockedAt(this.ph)) return;
    if (this.hasBlob(this.ph)) return this.startAudio();
    if (!this.isCached(this.ph)) return;
    // cached on the server, on its way here: start as soon as it arrives
    this.mode = 'waiting';
    this.nowPending = true;
    this.pump();
    this.notify();
  };

  pause = () => {
    if (this.mode === 'playing') {
      this.ph = this.frameOf(this.audio.currentTime);
      this.pauseAudio('paused');
      this.trim();
      this.draw(this.ph);
    } else {
      this.mode = 'paused';
      this.nowPending = false;
    }
    this.pump();
    this.notify();
  };

  seek = (t: number) => {
    if (!this.frames) {
      this.ph = Math.max(0, Math.floor(t * this.fps + 1e-6));
      return this.notify();
    }
    const i = this.frameOf(t);
    this.ph = i;
    this.nowPending = false; // "Play now" was for where the playhead was
    // cancel what the new position doesn't need: everything outside its window, and every paint-only request
    for (const [k, f] of [...this.inflight]) if (!f.keep || k < i || k >= i + this.window()) this.abort(k);
    this.trim();
    if (this.mode === 'playing') {
      if (this.blockedAt(i)) this.stopAt(i);
      else if (this.hasBlob(i)) this.audio.currentTime = i / this.fps;
      else this.gap();
    } else {
      this.draw(i);
      this.maybeResume(); // waiting, and the new position can play
    }
    this.pump();
    this.notify();
  };
}

export function usePreviewPlayer({
  versionId,
  song,
  coverage,
  segmentKeys,
  initialTime = 0,
  audio,
  onStaleKeys,
}: PreviewPlayerOptions): PreviewPlayer {
  // One engine per version (the song element outlives it): switching versions starts afresh, which cancels
  // everything the old one had in flight.
  const [song$] = useState(() => {
    const el = audio ?? new Audio('/assets/pdoom.mp3');
    el.preload = 'auto';
    return el;
  });
  const [held, setHeld] = useState(() => ({ versionId, engine: new PreviewEngine(versionId, song$, initialTime) }));
  let engine = held.engine;
  if (held.versionId !== versionId) {
    engine = new PreviewEngine(versionId, song$, initialTime);
    setHeld({ versionId, engine });
  }
  const [, setVersion] = useState(0);
  const staleRef = useRef(onStaleKeys);
  staleRef.current = onStaleKeys;

  useEffect(() => {
    engine.onChange = () => setVersion(v => v + 1);
    engine.onStaleKeys = () => staleRef.current?.();
    engine.start();
    return () => engine.stop();
  }, [engine]);
  useEffect(() => engine.setSong(song), [engine, song]);
  useEffect(() => engine.update(segmentKeys, coverage), [engine, segmentKeys, coverage]);

  const canvasRef = useCallback((el: HTMLCanvasElement | null) => engine.setCanvas(el), [engine]);
  const snap = engine.current();
  return { ...snap, play: engine.play, pause: engine.pause, seek: engine.seek, playNow: engine.playNow, canvasRef };
}
