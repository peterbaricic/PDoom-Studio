import { mkdtempSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CHAPTER_WINDOWS } from '../studio/storyboard.js';

export const goodStoryboard = () => [
  '---', 'title: The P(doom) Bake-Off', 'logline: Clawd and the Researcher bake a superintelligence.', '---', '',
  '# Storyboard', '',
  ...CHAPTER_WINDOWS.flatMap(([a, b], i) => [`## ${i + 1} · Chapter ${i + 1} (${a}–${b})`, `Walkthrough: What happens in chapter ${i + 1}.`, '', '| shot | ... |', '']),
].join('\n');

// Tests never touch the repo's studio.db, .studio/ or library/ (a studio may be running on them): each gets a
// throwaway data root, and spawned servers and render.mjs runs get it, plus a throwaway database, through the env.
export const tempDir = (prefix = 'studio-data-') => mkdtempSync(join(tmpdir(), prefix));
export const isolatedEnv = (data = tempDir(), extra = {}) =>
  ({ ...process.env, STUDIO_DATA: data, STUDIO_DB: join(data, 'studio.db'), ...extra });

// A private copy of the repo's studio/default.db. Tests that need the examples database (for the Original, or as a
// target for promoteVersion) make one of these once per file and reuse it, instead of rebuilding one from the
// source files importOriginal used to read (which Task 4 removes) or touching the repo's own copy.
export const tempDefaultDb = () => {
  const p = join(tempDir('default-db-'), 'default.db');
  cpSync(join(process.cwd(), 'studio/default.db'), p);
  return p;
};
