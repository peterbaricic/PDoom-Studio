import { describe, expect, test } from 'vitest';
import { chapterAt, timeToX, timelineGeometry, xToTime } from './timelineGeometry';

// The song's real chapter windows (studio/storyboard.js's CHAPTER_WINDOWS, as /api/song sends them).
const CHAPTERS: Array<[number, number]> = [
  [0, 23], [23, 38.5], [38.5, 59], [59, 73], [73, 95.4], [95.4, 109.4], [109.4, 123.5], [123.5, 140.5], [140.5, 156.6],
];
const DURATION = 156.6;

describe('timelineGeometry', () => {
  test('gives each chapter a block whose width is proportional to its window, and the blocks fill the width', () => {
    const blocks = timelineGeometry(CHAPTERS, 1000);
    expect(blocks.map(b => b.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    blocks.forEach((b, k) => {
      const [start, end] = CHAPTERS[k]!;
      expect([b.start, b.end]).toEqual([start, end]);
      expect(b.width).toBeCloseTo(((end - start) / DURATION) * 1000, 9);
    });
    expect(blocks.reduce((sum, b) => sum + b.width, 0)).toBeCloseTo(1000, 9);
    // laid end to end, from 0 to the full width
    expect(blocks[0]!.x).toBe(0);
    for (let k = 1; k < blocks.length; k++) expect(blocks[k]!.x).toBeCloseTo(blocks[k - 1]!.x + blocks[k - 1]!.width, 9);
    expect(blocks.at(-1)!.x + blocks.at(-1)!.width).toBeCloseTo(1000, 9);
  });

  test('works in percent too (width 100)', () => {
    const blocks = timelineGeometry(CHAPTERS, 100);
    expect(blocks[1]!.x).toBeCloseTo((23 / DURATION) * 100, 9);
    expect(blocks[1]!.width).toBeCloseTo((15.5 / DURATION) * 100, 9);
  });

  test('no chapters, no blocks', () => {
    expect(timelineGeometry([], 500)).toEqual([]);
  });
});

describe('timeToX / xToTime', () => {
  test('xToTime(timeToX(t)) is t, across the song', () => {
    for (const width of [100, 733, 1920]) {
      for (let t = 0; t <= DURATION; t += 0.37) expect(xToTime(timeToX(t, DURATION, width), DURATION, width)).toBeCloseTo(t, 9);
    }
  });

  test('maps the ends of the song to the ends of the track', () => {
    expect(timeToX(0, DURATION, 800)).toBe(0);
    expect(timeToX(DURATION, DURATION, 800)).toBe(800);
    expect(xToTime(400, DURATION, 800)).toBeCloseTo(DURATION / 2, 9);
  });

  test('clamps positions outside the track (a drag past either end)', () => {
    expect(xToTime(-50, DURATION, 800)).toBe(0);
    expect(xToTime(900, DURATION, 800)).toBe(DURATION);
    expect(timeToX(-3, DURATION, 800)).toBe(0);
    expect(timeToX(999, DURATION, 800)).toBe(800);
  });

  test('a track with no width yet maps everything to the start', () => {
    expect(xToTime(10, DURATION, 0)).toBe(0);
  });
});

describe('chapterAt', () => {
  test('picks the chapter the engine would (start inclusive, end exclusive), and the last one at the very end', () => {
    expect(chapterAt(CHAPTERS, 0)).toBe(1);
    expect(chapterAt(CHAPTERS, 22.99)).toBe(1);
    expect(chapterAt(CHAPTERS, 23)).toBe(2);
    expect(chapterAt(CHAPTERS, 156.58)).toBe(9);
    expect(chapterAt(CHAPTERS, 156.6)).toBe(9);
  });
});
