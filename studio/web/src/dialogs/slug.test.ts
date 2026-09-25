import { describe, expect, test } from 'vitest';
import { isValidVersionId, slug } from './slug';

describe('slug', () => {
  test('lowercases the title and joins its words with single hyphens', () => {
    expect(slug('The P(doom) Bake-Off')).toBe('the-p-doom-bake-off');
    expect(slug('  Upping   my   P(doom)!  ')).toBe('upping-my-p-doom');
    expect(slug('Version 2')).toBe('version-2');
  });

  test('drops accents and anything else outside a-z and 0-9', () => {
    expect(slug('Café Crème — Déjà vu')).toBe('cafe-creme-deja-vu');
    expect(slug('AI 🤖 doom')).toBe('ai-doom');
    // precomposed and decomposed accents alike
    expect([slug('Caf\u00e9'), slug('Cafe\u0301'), slug('\u00c5ngstr\u00f6m')]).toEqual(['cafe', 'cafe', 'angstrom']);
  });

  test('gives only ids the server accepts, at most 41 characters, never ending in a hyphen', () => {
    const titles = ['A', '-leading', 'trailing-', `${'x'.repeat(40)} y`, 'a'.repeat(100), `${'b'.repeat(39)}--c`, 'Ω 9', '...1'];
    for (const t of titles) {
      const id = slug(t);
      expect(isValidVersionId(id), `${t} -> ${id}`).toBe(true);
      expect(id.length).toBeLessThanOrEqual(41);
      expect(id.endsWith('-')).toBe(false);
    }
    expect(slug('a'.repeat(100))).toBe('a'.repeat(41));
    expect(slug(`${'x'.repeat(40)} y`)).toBe('x'.repeat(40));
  });

  test('is empty when there is nothing to make an id from', () => {
    expect(slug('')).toBe('');
    expect(slug('!!! ???')).toBe('');
    expect(slug('日本語')).toBe('');
  });

  test('isValidVersionId is the server rule', () => {
    expect(isValidVersionId('my-take-2')).toBe(true);
    expect(isValidVersionId('a'.repeat(41))).toBe(true);
    expect(isValidVersionId('a'.repeat(42))).toBe(false);
    for (const bad of ['', '-a', 'A', 'a b', 'a_b', 'café']) expect(isValidVersionId(bad), bad).toBe(false);
  });
});
