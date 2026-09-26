// thumbs.ts: the chapters' thumbnail strips (three frames side by side, 960x180), which a chapter job's check and the
// thumbs job write to <data>/.studio/thumbs/<id>/c0N.jpg and studio/app.js serves at /thumbs/<id>/c0N.jpg. The
// manifest's `thumbs` says which exist and when each was written, so only those are asked for (no 404s), and the URL
// names both the chapter's revision and that time, so new code or a refreshed strip is never an old cached picture.
import type { Manifest } from '@/api/types';

// Chapter number -> its strip's URL, for the written chapters that have one.
export function chapterThumbs(manifest: Manifest | undefined): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [n, written] of Object.entries(manifest?.thumbs ?? {})) {
    const path = manifest!.files.find(p => p.startsWith(`ch/c0${n}`));
    if (!path) continue; // not written (any more): a strip on disk is of code that's gone
    out[+n] = `/thumbs/${encodeURIComponent(manifest!.id)}/c0${n}.jpg?r=${manifest!.fileRevisions[path] ?? 0}.${written}`;
  }
  return out;
}
