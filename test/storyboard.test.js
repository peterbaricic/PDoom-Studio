import { test, expect } from 'bun:test';
import { parseStoryboard, chapterWindowErrors, CHAPTER_WINDOWS } from '../studio/storyboard.js';
import { goodStoryboard } from './helpers.js';

test('parses a valid storyboard', () => {
  const s = parseStoryboard(goodStoryboard());
  expect(s.errors).toEqual([]);
  expect(s.title).toBe('The P(doom) Bake-Off');
  expect(s.logline).toBe('Clawd and the Researcher bake a superintelligence.');
  expect(s.chapters).toHaveLength(9);
  expect(s.chapters[2]).toEqual({ n: 3, name: 'Chapter 3', start: 38.5, end: 59, walkthrough: 'What happens in chapter 3.' });
});

test('accepts a hyphen instead of the en dash and middle dot', () => {
  const s = parseStoryboard(goodStoryboard().replaceAll('–', '-').replaceAll(' · ', ' - '));
  expect(s.errors).toEqual([]);
});

test('reports missing front matter', () => {
  const s = parseStoryboard(goodStoryboard().replace(/^---[\s\S]*?---\n/, ''));
  expect(s.errors).toContain('missing front matter block (--- title: … logline: … ---)');
});

test('reports a wrong chapter window', () => {
  const s = parseStoryboard(goodStoryboard().replace('(38.5–59)', '(38.5–60)'));
  expect(s.errors).toContain('chapter 3 must cover 38.5–59, not 38.5–60');
});

test('reports a missing walkthrough and a missing chapter', () => {
  const text = goodStoryboard().replace('Walkthrough: What happens in chapter 5.', '').replace(/## 9 ·[\s\S]*$/, '');
  const s = parseStoryboard(text);
  expect(s.errors).toContain('chapter 5 has no "Walkthrough:" line');
  expect(s.errors).toContain('expected 9 chapters, found 8');
});

// Frames are cached per chapter window; a chapter() reaching into its neighbour's window would paint the neighbour's
// frames under the neighbour's key.
test('chapter() registrations must stay inside their own chapter\'s window', () => {
  const reg = (owner, start, end, name = 'x') => ({ owner, name, start, end });
  // the Original's shape: each chapter file its exact window, the finale running past the song's end (DUR + 1)
  const original = CHAPTER_WINDOWS.map(([a, b], i) => reg(`ch/c0${i + 1}_part.js`, a, i === 8 ? 157.6 : b));
  expect(chapterWindowErrors(original)).toEqual([]);
  // sub-windows of its own window, and the plain file name
  expect(chapterWindowErrors([reg('ch/c03.js', 38.5, 45), reg('ch/c03.js', 45, 59), reg('ch/c03.js', 50, 51)])).toEqual([]);
  // overrunning into a neighbour's window, on either side
  expect(chapterWindowErrors([reg('ch/c02.js', 23, 40, 'two')])).toEqual(["ch/c02.js: chapter('two', 23, 40) reaches outside chapter 2's window (23–38.5 s)"]);
  expect(chapterWindowErrors([reg('ch/c03_takeoff.js', 38, 59)])).toEqual(["ch/c03_takeoff.js: chapter('x', 38, 59) reaches outside chapter 3's window (38.5–59 s)"]);
  // only past the song's end in the last window
  expect(chapterWindowErrors([reg('ch/c08.js', 123.5, 141)])).toHaveLength(1);
  // not a window at all
  expect(chapterWindowErrors([reg('ch/c04.js', 70, 60)])).toEqual(["ch/c04.js: chapter('x', 70, 60) is not a window of time (start before end)"]);
  expect(chapterWindowErrors([reg('ch/c04.js', NaN, 60)])).toHaveLength(1);
  // registered by anything but a chapter file
  expect(chapterWindowErrors([reg('shared.js', 0, 23), reg(null, 0, 23)])).toEqual([
    "chapter('x', 0, 23) is called from shared.js: only a chapter file (ch/c0<n>…js) may call chapter()",
    "chapter('x', 0, 23) is called from outside the version's files: only a chapter file (ch/c0<n>…js) may call chapter()",
  ]);
});
