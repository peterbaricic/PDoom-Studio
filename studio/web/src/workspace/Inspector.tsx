// Inspector.tsx: the workspace's side panel. With no chapter selected it's the storyboard review (StoryboardPanel);
// with one selected (?ch=n, set by the timeline) it's that chapter (ChapterPanel), and "Whole storyboard" or Escape
// goes back by dropping ch from the URL (the playhead stays where it is). Examples are read-only, so instead of
// editing controls they get a call to remix them.
//
// Loaded lazily by Workspace: react-markdown and remark-gfm are most of its weight, and they needn't hold up the
// player.
import { useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon, CopyPlusIcon } from 'lucide-react';
import type { Job, Manifest } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ChapterPanel } from './ChapterPanel';
import { StoryboardPanel } from './StoryboardPanel';

export interface InspectorProps {
  versionId: string;
  manifest: Manifest | undefined;
  jobs: Job[];
  // The selected chapter (1..9), if any.
  chapter?: number;
  // Opens the Remix dialog for this version (an example's call to action). Until one is wired up, the button is off.
  onRemix?: () => void;
}

// STORYBOARD.md as written: /v/<id>/STORYBOARD.md serves a version's files as plain text on the UI hosts. Under
// ['version', id, …] so that every `version` event (an edit, a storyboard job finishing) reads it again.
export function storyboardQuery(versionId: string, enabled: boolean) {
  return {
    queryKey: ['version', versionId, 'storyboard'],
    queryFn: async () => {
      const res = await fetch(`/v/${encodeURIComponent(versionId)}/STORYBOARD.md`);
      if (!res.ok) throw new Error(res.status === 404 ? 'not found' : `HTTP ${res.status}`);
      return res.text();
    },
    enabled,
  };
}

// Escape in a text field or a dialog belongs to them, not to the inspector.
const OWNS_ESCAPE = 'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]';

export function Inspector({ versionId, manifest, jobs, chapter, onRemix }: InspectorProps) {
  const navigate = useNavigate();
  const hasStoryboard = !!manifest?.files.includes('STORYBOARD.md');
  const storyboard = useQuery(storyboardQuery(versionId, hasStoryboard));

  const wholeStoryboard = useCallback(
    () =>
      void navigate({
        to: '/versions/$id',
        params: { id: versionId },
        search: prev => {
          const { ch: _dropped, ...rest } = prev as { ch?: number; t?: number };
          return rest;
        },
      }),
    [navigate, versionId],
  );
  useEffect(() => {
    if (!chapter) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest(OWNS_ESCAPE)) return;
      wholeStoryboard();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [chapter, wholeStoryboard]);

  const name = chapter ? manifest?.walkthrough.find(w => w.n === chapter)?.name : undefined;
  const panelProps = manifest && {
    versionId,
    manifest,
    jobs,
    storyboard: storyboard.data,
    storyboardError: storyboard.error?.message ?? null,
  };

  return (
    <aside aria-label="Inspector" className="bg-card flex min-w-0 flex-col rounded-md border">
      <header className="flex min-h-11 items-center gap-2 border-b px-3 py-1.5">
        {chapter ? (
          <>
            <Button size="sm" variant="ghost" className="-ml-2" onClick={wholeStoryboard} title="Back to the whole storyboard (Esc)">
              <ArrowLeftIcon aria-hidden />
              Whole storyboard
            </Button>
            <h2 className="min-w-0 truncate text-sm font-semibold">
              Chapter {chapter}
              {name ? ` · ${name}` : ''}
            </h2>
          </>
        ) : (
          <h2 className="text-sm font-semibold">Storyboard</h2>
        )}
      </header>
      {manifest?.example && (
        <div className="bg-primary/5 flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
          <span className="flex-1">This is an example, so it's read-only. Remix it to make a version of your own.</span>
          <Button size="sm" disabled={!onRemix} onClick={onRemix}>
            <CopyPlusIcon aria-hidden />
            Remix
          </Button>
        </div>
      )}
      {!panelProps ? (
        <div className="flex flex-col gap-2 p-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : chapter ? (
        // keyed: a different chapter starts with an empty feedback box
        <ChapterPanel key={chapter} {...panelProps} chapter={chapter} />
      ) : (
        <StoryboardPanel {...panelProps} />
      )}
    </aside>
  );
}
