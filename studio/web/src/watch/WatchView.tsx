// WatchView.tsx: /versions/:id/watch?render=<renderId> — a finished render (the version's latest when none is named)
// with the walkthrough beside it, following the video: the chapter playing is highlighted and expanded, and clicking
// one seeks there. Below: how the version was made (concept, storyboard, revisions, feedback, Claude cost, render
// date) and the version's other renders.
//
// A render outlives its version (studio/db.js keeps its title and logline, and listRenders falls back to them), so a
// version that's gone still plays here under its stored title; only the parts read from the version are left out.
//
// Loaded lazily (router.tsx): its own chunk, with the Markdown renderer it shares with the inspector.
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ApiError, api } from '@/api/client';
import type { Manifest, Render, Revision, WalkthroughChapter } from '@/api/types';
import { Skeleton } from '@/components/ui/skeleton';
import { libraryFile, renderTitle, rendersQuery } from '@/library/renders';
import { cn } from '@/lib/utils';
import { jobsQuery } from '@/shell/JobsDrawer';
import { formatDuration } from '@/shell/jobFormat';
import { StoryboardMarkdown, storyboardQuery } from '@/workspace/inspectorControls';
import { withoutFrontMatter } from '@/workspace/storyboardSections';

export interface WatchViewProps {
  versionId: string;
  // The render to play (?render=); the version's latest when undefined.
  renderId?: number;
}

// The notes Claude's jobs leave when nobody gave feedback (studio/claude-job.js: `${kind} job`) say nothing about how
// the version was made; every other note on a claude or manual revision is someone's feedback or edit.
const PLACEHOLDER_NOTE = /^(storyboard|shared|chapter) job$/;
const when = (ms: number) => new Date(ms).toLocaleString();

// A version that isn't there (404) or a request the server refused won't answer differently a second later.
const retryUnlessRefused = (count: number, e: Error) => !(e instanceof ApiError && e.status < 500) && count < 1;

export function WatchView({ versionId, renderId }: WatchViewProps) {
  const renders = useQuery(rendersQuery);
  const manifest = useQuery({
    queryKey: ['version', versionId],
    queryFn: () => api.get<Manifest>(`/api/versions/${encodeURIComponent(versionId)}`),
    retry: retryUnlessRefused,
  });

  // Newest first, as the library lists them.
  const mine = (renders.data ?? []).filter(r => r.version_id === versionId).sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  const render = renderId === undefined ? mine[0] : mine.find(r => r.id === renderId);
  // With no render to play, whether the version was ever rendered (its renders deleted since) or not: a finished
  // render job says so.
  const nothingToPlay = !!renders.data && !render && renderId === undefined;
  const { data: jobs } = useQuery({ ...jobsQuery(versionId), enabled: nothingToPlay });

  if (!renders.data) {
    if (renders.error) return <p className="text-muted-foreground p-6">{`Couldn't load the library: ${renders.error.message}`}</p>;
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
        <Skeleton className="aspect-video w-full" />
      </div>
    );
  }

  if (!render) {
    return (
      <div className="text-muted-foreground flex flex-col gap-2 p-6">
        {renderId === undefined ? (
          <>
            <p>
              {!jobs
                ? 'No render to show.'
                : jobs.some(j => j.kind === 'render' && j.status === 'done')
                  ? 'This version has no renders now: they were deleted from the library.'
                  : "This version hasn't been rendered yet."}
            </p>
            <p>
              <Link to="/versions/$id" params={{ id: versionId }} className="text-foreground underline">
                Back to the version
              </Link>
            </p>
          </>
        ) : (
          <>
            <p>This render no longer exists.</p>
            <p>
              <Link to="/library" className="text-foreground underline">
                See what's in the library
              </Link>
            </p>
          </>
        )}
      </div>
    );
  }

  const deleted = manifest.error instanceof ApiError && manifest.error.status === 404;
  // After a refetch answers 404 (the version deleted while this is open), the query keeps the manifest it had: it's
  // stale, and nothing may be asked on its account (history, jobs, the storyboard).
  const live = deleted ? undefined : manifest.data;
  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-6 p-4">
      <Player
        key={render.id}
        render={render}
        walkthrough={live?.walkthrough ?? []}
        // room for the walkthrough, kept while it loads so the video doesn't jump; none when there won't be one
        side={manifest.isPending || !!live?.walkthrough.length}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <HowItWasMade
          versionId={versionId}
          render={render}
          manifest={live}
          deleted={deleted}
          error={deleted ? null : (manifest.error?.message ?? null)}
        />
        <OtherRenders versionId={versionId} render={render} renders={mine} />
      </div>
    </div>
  );
}

// The video, its title, and the walkthrough beside it (on narrow screens, under it).
function Player({ render, walkthrough, side }: { render: Render; walkthrough: WalkthroughChapter[]; side: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const sync = () => setTime(video.current?.currentTime ?? 0);
  const current = walkthrough.findIndex(c => time >= c.start && time < c.end);

  const seek = (c: WalkthroughChapter) => {
    const v = video.current;
    if (!v) return;
    // Just inside the chapter, so a start that rounds down to the previous chapter's last frame still lands in it.
    v.currentTime = c.start + 0.01;
    sync();
    v.play().catch(() => {});
  };

  return (
    <div className={cn('grid gap-4', side && 'lg:grid-cols-[minmax(0,1fr)_22rem]')}>
      <div className="flex min-w-0 flex-col gap-2">
        <video
          ref={video}
          data-testid="watch-video"
          className="aspect-video w-full rounded-md bg-black"
          src={libraryFile(render.file)}
          poster={render.poster ? libraryFile(render.poster) : undefined}
          controls
          preload="metadata"
          onTimeUpdate={sync}
          onSeeked={sync}
        />
        <h1 className="text-xl font-semibold">{renderTitle(render)}</h1>
        {render.logline && <p className="text-muted-foreground">{render.logline}</p>}
      </div>
      {walkthrough.length > 0 && <Walkthrough chapters={walkthrough} current={current} onPick={seek} />}
    </div>
  );
}

function Walkthrough({ chapters, current, onPick }: { chapters: WalkthroughChapter[]; current: number; onPick: (c: WalkthroughChapter) => void }) {
  const box = useRef<HTMLOListElement>(null);
  // Keeps the current chapter in view inside the list only: scrollIntoView would scroll the page too, pulling a
  // reader of "How it was made" back up at every chapter change.
  useEffect(() => {
    const list = box.current, item = list?.children[current] as HTMLElement | undefined;
    if (!list || !item) return;
    const l = list.getBoundingClientRect(), i = item.getBoundingClientRect();
    if (i.top < l.top) list.scrollTop -= l.top - i.top;
    else if (i.bottom > l.bottom) list.scrollTop += i.bottom - l.bottom;
  }, [current]);

  // lg and up: as tall as the video column beside it (the list is taken out of the flow and fills its cell).
  return (
    <div className="relative min-h-0">
      <ol ref={box} aria-label="Walkthrough" className="flex flex-col gap-1 overflow-y-auto lg:absolute lg:inset-0">
        {chapters.map((c, i) => (
          <li
            key={c.n}
            aria-current={i === current ? 'true' : undefined}
            className={cn('rounded-md border border-transparent', i === current && 'border-primary/60 bg-accent')}
          >
            <button type="button" className="hover:bg-accent/60 flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm" onClick={() => onPick(c)}>
              <span className="text-muted-foreground w-10 shrink-0 tabular-nums">{formatDuration(c.start * 1000)}</span>
              <span className="font-medium">{`${c.n} · ${c.name}`}</span>
            </button>
            {i === current && c.text && <p className="px-2 pb-2 pl-14 text-sm">{c.text}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}

interface MadeProps {
  versionId: string;
  render: Render;
  manifest: Manifest | undefined;
  deleted: boolean;
  error: string | null;
}

function HowItWasMade({ versionId, render, manifest, deleted, error }: MadeProps) {
  const has = !!manifest;
  const history = useQuery({
    queryKey: ['version', versionId, 'history'],
    queryFn: () => api.get<Revision[]>(`/api/versions/${encodeURIComponent(versionId)}/history`),
    enabled: has,
  });
  const jobs = useQuery({ ...jobsQuery(versionId), enabled: has });
  const storyboard = useQuery(storyboardQuery(versionId, !!manifest?.files.includes('STORYBOARD.md')));

  const rendered = `rendered ${when(render.created_at)}${render.render_s ? ` in ${Math.max(1, Math.round(render.render_s / 60))} min` : ''}`;
  let body;
  if (deleted) {
    body = (
      <>
        <p className="text-muted-foreground">This version was deleted, so the story of how it was made went with it. The video stays in the library.</p>
        <p className="text-muted-foreground text-sm">{capitalize(rendered)}</p>
      </>
    );
  } else if (error) {
    body = (
      <>
        <p className="text-muted-foreground">{`Couldn't load how this version was made: ${error}`}</p>
        <p className="text-muted-foreground text-sm">{capitalize(rendered)}</p>
      </>
    );
  } else if (!manifest) {
    body = <Skeleton className="h-24 w-full" />;
  } else {
    // Oldest first: the order it happened in. (The history comes newest first.)
    const notes = (history.data ?? [])
      .filter(r => (r.source === 'claude' || r.source === 'manual') && r.note && !PLACEHOLDER_NOTE.test(r.note))
      .reverse();
    const cost = (jobs.data ?? []).reduce((sum, j) => sum + (j.cost_usd || 0), 0);
    const loadError = history.error ?? jobs.error;
    const stats = history.data && jobs.data
      ? [
          `${history.data.length} revision${history.data.length === 1 ? '' : 's'}`,
          `${notes.length} round${notes.length === 1 ? '' : 's'} of feedback`,
          ...(cost > 0 ? [`Claude cost $${cost.toFixed(2)}`] : []),
          rendered,
        ].join(' · ')
      : null;
    body = (
      <>
        {manifest.concept && (
          <p>
            <span className="font-medium">Concept: </span>
            <span>{manifest.concept}</span>
          </p>
        )}
        {loadError ? (
          <p className="text-muted-foreground text-sm">{`Couldn't load the revisions and jobs: ${loadError.message}`}</p>
        ) : stats ? (
          <p className="text-muted-foreground text-sm">{stats}</p>
        ) : (
          <Skeleton className="h-5 w-2/3" />
        )}
        {notes.length > 0 && (
          <ul aria-label="Feedback" className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {notes.map(r => (
              <li key={r.id}>
                <span className="text-muted-foreground">{`${r.path}: `}</span>
                {r.note}
              </li>
            ))}
          </ul>
        )}
        {storyboard.data !== undefined && (
          <details className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Storyboard</summary>
            <StoryboardMarkdown markdown={withoutFrontMatter(storyboard.data)} className="mt-2" />
          </details>
        )}
      </>
    );
  }

  return (
    <section aria-labelledby="how-it-was-made" className="flex min-w-0 flex-col gap-3">
      <h2 id="how-it-was-made" className="text-lg font-semibold">
        How it was made
      </h2>
      {body}
      {!deleted && (
        <p className="text-sm">
          <Link to="/versions/$id" params={{ id: versionId }} className="underline">
            Open this version in the studio
          </Link>
        </p>
      )}
    </section>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function OtherRenders({ versionId, render, renders }: { versionId: string; render: Render; renders: Render[] }) {
  const others = renders.filter(r => r.id !== render.id);
  if (!others.length) return null;
  return (
    <section aria-labelledby="other-renders" className="flex flex-col gap-2">
      <h2 id="other-renders" className="text-lg font-semibold">
        {others.every(r => r.created_at <= render.created_at) ? 'Older renders' : 'Other renders'}
      </h2>
      <ul aria-label="Other renders" className="flex flex-col gap-1 text-sm">
        {others.map(r => (
          <li key={r.id}>
            <Link to="/versions/$id/watch" params={{ id: versionId }} search={{ render: r.id }} className="underline">
              {when(r.created_at)}
            </Link>
            {r.id === renders[0]?.id && <span className="text-muted-foreground"> · latest</span>}
            {r.duration_s != null && <span className="text-muted-foreground">{` · ${formatDuration(r.duration_s * 1000)}`}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
