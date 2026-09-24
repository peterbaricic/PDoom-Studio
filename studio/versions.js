// versions.js: what a version consists of (its manifest), built from either database's files.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isValidPath } from './db.js';
import { parseStoryboard, CHAPTER_WINDOWS } from './storyboard.js';

export const DEFAULT_OPTIONS = { wipes: true, cornerMeter: true };

export function buildManifest(version, files) {
  const paths = [...files.keys()].filter(isValidPath).sort();
  const chapters = paths.filter(p => p.startsWith('ch/'));
  const scripts = [...(files.has('shared.js') ? ['shared.js'] : []), ...chapters];
  let walkthrough = [];
  if (files.has('walkthrough.json')) {
    walkthrough = JSON.parse(files.get('walkthrough.json')).map(c => ({ n: c.n, name: c.name, start: CHAPTER_WINDOWS[c.n - 1][0], end: CHAPTER_WINDOWS[c.n - 1][1], text: c.text }));
  } else if (files.has('STORYBOARD.md')) {
    walkthrough = parseStoryboard(files.get('STORYBOARD.md')).chapters.map(c => ({ n: c.n, name: c.name, start: c.start, end: c.end, text: c.walkthrough }));
  }
  return { id: version.id, title: version.title || '', logline: version.logline || '', status: version.status || 'concept',
    example: !!version.example, options: { ...DEFAULT_OPTIONS, ...version.options }, files: paths, scripts, walkthrough };
}

export function versionManifest(db, id) {
  const version = db.getVersion(id);
  if (!version) return null;
  const files = new Map(db.listFiles(id).map(f => [f.path, db.getFile(id, f.path).content]));
  return buildManifest(version, files);
}

export function readWorkFiles(dir) {
  const files = new Map();
  const add = rel => { if (isValidPath(rel)) files.set(rel, readFileSync(join(dir, rel), 'utf8')); };
  for (const name of readdirSync(dir)) add(name);
  if (existsSync(join(dir, 'ch'))) for (const name of readdirSync(join(dir, 'ch'))) add(`ch/${name}`);
  return files;
}

export const workManifest = (dir, version) => buildManifest(version, readWorkFiles(dir));
