import { test, expect } from 'bun:test';
import { parseStoryboard } from '../studio/storyboard.js';
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
