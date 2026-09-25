// timelineGeometry.ts: where things sit on the timeline. Pure maths, unit-tested (timelineGeometry.test.ts): the nine
// chapter blocks sized by their real windows (GET /api/song's chapters), and the mapping between a position on the
// track and a time in the song, for the playhead, the coverage shading, the lyrics and scrubbing.

export interface ChapterBlock {
  n: number; // 1..9
  start: number; // seconds
  end: number; // seconds
  x: number; // from the track's left edge, in the unit of `width` (pixels, or 100 for percent)
  width: number;
}

// The song runs from 0 to the end of its last chapter.
export const songEnd = (chapters: Array<[number, number]>) => chapters.at(-1)?.[1] ?? 0;

// One block per chapter, laid end to end, each as wide as its share of the song: together they fill `width`.
export function timelineGeometry(chapters: Array<[number, number]>, width: number): ChapterBlock[] {
  const duration = songEnd(chapters);
  return chapters.map(([start, end], k) => ({
    n: k + 1,
    start,
    end,
    x: timeToX(start, duration, width),
    width: timeToX(end, duration, width) - timeToX(start, duration, width),
  }));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// A time in the song to a position on a track `width` wide (clamped to the track).
export function timeToX(t: number, duration: number, width: number): number {
  return duration > 0 ? (clamp(t, 0, duration) / duration) * width : 0;
}

// A position on the track to a time in the song (clamped to the song: a drag past either end stops there).
export function xToTime(x: number, duration: number, width: number): number {
  return width > 0 ? (clamp(x, 0, width) / width) * duration : 0;
}

// m:ss, rounded down (a clock: 0:09 until the tenth second has begun).
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds + 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
