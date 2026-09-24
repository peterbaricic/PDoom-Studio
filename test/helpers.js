import { mkdtempSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CHAPTER_WINDOWS } from '../studio/storyboard.js';

export const goodStoryboard = () => [
  '---', 'title: The P(doom) Bake-Off', 'logline: Clawd and the Researcher bake a superintelligence.', '---', '',
  '# Storyboard', '',
  ...CHAPTER_WINDOWS.flatMap(([a, b], i) => [`## ${i + 1} · Chapter ${i + 1} (${a}–${b})`, `Walkthrough: What happens in chapter ${i + 1}.`, '', '| shot | ... |', '']),
].join('\n');

export const tempDir = (prefix = 'studio-data-') => mkdtempSync(join(tmpdir(), prefix));

// A private copy of the repo's studio/default.db. Tests that need the examples database (for the Original, or as a
// target for promoteVersion) make one of these once per file and reuse it, instead of touching the repo's own copy.
export const tempDefaultDb = () => {
  const p = join(tempDir('default-db-'), 'default.db');
  cpSync(join(process.cwd(), 'studio/default.db'), p);
  return p;
};

// Tests never touch the repo's user.db, studio.db, studio/default.db, .studio/ or library/ (a studio may be running
// on them): spawned servers and render.mjs runs get a throwaway data root, a user database inside it, and a copy of
// the examples database, all pinned here so that a USER_DB, STUDIO_DB or DEFAULT_DB set in the shell can never
// point a test at real files. (USER_DB wins over STUDIO_DB, its alias, so pinning it is enough.) The examples copy
// is shared by every isolatedEnv in the process: read-only by convention — a test that promotes passes its own.
let sharedDefaultDb = null;
export const isolatedEnv = (data = tempDir(), extra = {}) =>
  ({ ...process.env, STUDIO_DATA: data, USER_DB: join(data, 'user.db'), DEFAULT_DB: sharedDefaultDb ??= tempDefaultDb(), ...extra });
