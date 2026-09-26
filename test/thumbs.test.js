import { test, expect } from 'bun:test';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDb } from '../studio/db.js';
import { snapshotOf } from '../studio/snapshot.js';
import { segmentKeys, engineHash } from '../studio/frames/keys.js';
import { currentThumbs, stampThumb, thumbPath } from '../studio/thumbs.js';
import { tempDir } from './helpers.js';

const root = process.cwd();
const keyOf = (db, n) => segmentKeys(snapshotOf(db, 'v'), engineHash(root))[n];
const writeStrip = (data, n, at = null) => {
  const p = thumbPath(data, 'v', n);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, 'jpeg');
  if (at) utimesSync(p, at, at);
};

// A strip is shown only while it's the picture of the chapter as it is now: stamped with the segment key it was
// painted under (code, shared.js, options, engine), and not rewritten since.
test('a strip counts only while its stamp names the chapter\'s current segment key, and the file is the one stamped', () => {
  const db = openDb(':memory:'), data = tempDir();
  db.createVersion({ id: 'v' });
  db.writeFiles('v', [{ path: 'ch/c02_tent.js', content: '// one' }, { path: 'ch/c03.js', content: '// three' }], { source: 'manual' });
  writeStrip(data, 2, 1_700_000_000);
  stampThumb(data, 'v', 2, keyOf(db, 2));
  writeStrip(data, 3);   // never stamped (made before stamps existed, say)
  const rev = db.listFiles('v').find(f => f.path === 'ch/c02_tent.js').revision_id;
  expect(currentThumbs(db, root, data, 'v')).toEqual({ 2: { mtime: 1_700_000_000_000, revision: rev } });

  // rewritten after it was stamped (a check whose draft then failed): not the stamped picture
  writeStrip(data, 2, 1_700_000_100);
  expect(currentThumbs(db, root, data, 'v')).toEqual({});
});

test('a restored chapter never shows the strip of the newer code it replaced', () => {
  const db = openDb(':memory:'), data = tempDir();
  db.createVersion({ id: 'v' });
  db.writeFiles('v', [{ path: 'ch/c02.js', content: '// first' }], { source: 'manual' });
  const first = db.listFiles('v')[0].revision_id;
  db.writeFiles('v', [{ path: 'ch/c02.js', content: '// second' }], { source: 'claude' });
  writeStrip(data, 2);
  stampThumb(data, 'v', 2, keyOf(db, 2));
  expect(Object.keys(currentThumbs(db, root, data, 'v'))).toEqual(['2']);
  db.restore(first);
  expect(currentThumbs(db, root, data, 'v')).toEqual({});
  // a version with no such chapter, or none at all: nothing
  expect(currentThumbs(db, root, data, 'nope')).toEqual({});
});
