import { test, expect } from 'bun:test';
import { cpSync, existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Database } from 'bun:sqlite';
import { openDb } from '../studio/db.js';
import { buildDefault } from '../studio/build-default.js';
import { tempDir, tempDefaultDb } from './helpers.js';

const rows = path => {
  const db = new Database(path, { readonly: true });
  try {
    return {
      versions: db.query('SELECT id, title, logline, concept, options, status, created_at, updated_at FROM versions ORDER BY id').all(),
      revisions: db.query('SELECT id, version_id, path, content, job_id, source, note, created_at FROM revisions ORDER BY id').all(),
      files: db.query('SELECT version_id, path, content, revision_id FROM files ORDER BY version_id, path').all(),
      journal: db.query('PRAGMA journal_mode').get().journal_mode,
    };
  } finally { db.close(); }
};

// An examples database holding the Original plus a promoted version, as default.db looks after a Promote.
function withPromoted() {
  const source = tempDefaultDb(), udb = openDb(join(tempDir(), 'user.db'), { defaultPath: source });
  udb.createVersion({ id: 'promoted', title: 'Promoted' });
  udb.writeFiles('promoted', [{ path: 'STORYBOARD.md', content: 'sb' }, { path: 'ch/c01.js', content: '// 1' }], { source: 'manual' });
  udb.promoteVersion('promoted');
  udb.close();
  return source;
}

test('copies every version, with all its revisions and current files, into a rollback-journal database', () => {
  const source = withPromoted(), out = join(tempDir(), 'default.db');
  buildDefault(source, out);
  const [a, b] = [rows(source), rows(out)];
  expect(a.versions.map(v => v.id)).toEqual(['original', 'promoted']);
  expect(b.versions).toEqual(a.versions);
  expect(b.revisions).toEqual(a.revisions);
  expect(b.files).toEqual(a.files);
  expect(b.journal).toBe('delete');
  expect(readdirSync(join(out, '..'))).toEqual(['default.db']);   // no temporary or journal file left behind
});

test('refuses to build into its own source, however the path is spelled, and leaves it untouched', () => {
  const source = tempDefaultDb(), bytes = readFileSync(source), dir = join(source, '..');
  symlinkSync(source, join(dir, 'link.db'));
  for (const out of [source, join(dir, '.', 'default.db'), relative(process.cwd(), source), join(dir, 'link.db')]) {
    expect(() => buildDefault(source, out)).toThrow('is the source itself');
  }
  expect(readFileSync(source).equals(bytes)).toBe(true);
  expect(readdirSync(dir).sort()).toEqual(['default.db', 'link.db']);
});

test('replaces an existing database only once the new one is complete', () => {
  const out = join(tempDir(), 'default.db');
  buildDefault(withPromoted(), out);
  const before = readFileSync(out);

  // a source that is not an examples database (a user.db: revision ids below the examples floor) is refused
  const userDb = join(tempDir(), 'user.db'), udb = openDb(userDb);
  udb.createVersion({ id: 'original' });
  udb.writeFiles('original', [{ path: 'STORYBOARD.md', content: 'x' }], { source: 'manual' });
  udb.close();
  expect(() => buildDefault(userDb, out)).toThrow('is not an examples database');
  // and so is one without an Original
  const empty = join(tempDir(), 'empty.db');
  openDb(empty).close();
  expect(() => buildDefault(empty, out)).toThrow('no "original" version');

  expect(readFileSync(out).equals(before)).toBe(true);
  expect(readdirSync(join(out, '..'))).toEqual(['default.db']);

  // a successful build replaces it, stale journal files and all
  writeFileSync(`${out}-journal`, 'stale');
  buildDefault(tempDefaultDb(), out);
  expect(rows(out).versions.map(v => v.id)).toEqual(['original']);
  expect(readdirSync(join(out, '..'))).toEqual(['default.db']);
});

test('the command line refuses the same file twice, and says how to use it', async () => {
  const source = tempDefaultDb(), bytes = readFileSync(source);
  const run = async (...args) => {
    const p = Bun.spawn(['bun', 'studio/build-default.js', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };
  const same = await run('--from', source, source);
  expect(same.code).toBe(1);
  expect(same.err).toContain('is the source itself');
  expect(same.err).not.toContain('    at ');   // a message, not a stack trace
  expect(readFileSync(source).equals(bytes)).toBe(true);

  const usage = await run(source);
  expect(usage.code).toBe(1);
  expect(usage.err).toContain('usage: bun studio/build-default.js --from <examples.db> <out.db>');

  const out = join(tempDir(), 'default.db'), ok = await run('--from', source, out);
  expect(ok.code).toBe(0);
  expect(existsSync(out)).toBe(true);
});
