// Workspace.tsx: /versions/:id — the preview player over the timeline (chapter blocks, coverage, playhead), the
// lyrics and the render bar, with the inspector (the storyboard, or the selected chapter) beside them. The playhead
// and the selected chapter live in the URL (?t=<seconds>&ch=<1-9>): the URL moves the player (a chapter block's link,
// the browser's back button, a shared link), and the player writes its position back whenever it's not playing
// (replacing the history entry, so scrubbing doesn't fill the history).
import { Suspense, lazy, useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { api } from '@/api/client';
import type { Coverage, Job, Manifest, Song } from '@/api/types';
import { Skeleton } from '@/components/ui/skeleton';
import { jobsQuery } from '@/shell/JobsDrawer';
import { LyricsTrack } from './LyricsTrack';
import { PreviewPlayer } from './PreviewPlayer';
import { RenderBar } from './RenderBar';
import { Timeline } from './Timeline';
import { songEnd } from './timelineGeometry';
import { usePreviewPlayer } from './usePreviewPlayer';

// Its own chunk: the Markdown renderer it carries is too heavy for the bundle the player waits on.
const Inspector = lazy(() => import('./Inspector').then(m => ({ default: m.Inspector })));

export interface WorkspaceSearch {
  ch?: number;
  t?: number;
}

// The route's search params, validated (router.tsx): a chapter 1..9 and a time >= 0, anything else dropped.
export function workspaceSearch(search: Record<string, unknown>): WorkspaceSearch {
  const ch = Number(search.ch);
  const t = Number(search.t);
  return {
    ...(Number.isInteger(ch) && ch >= 1 && ch <= 9 ? { ch } : {}),
    ...(search.t != null && search.t !== '' && Number.isFinite(t) && t >= 0 ? { t } : {}),
  };
}

const URL_WRITE_DELAY_MS = 250;
const BROKEN_RECHECK_MS = 15_000;
const roundTime = (t: number) => Math.round(t * 1000) / 1000;

export function Workspace({ versionId }: { versionId: string }) {
  const song = useQuery({ queryKey: ['song'], queryFn: () => api.get<Song>('/api/song'), staleTime: Infinity });
  const manifest = useQuery({
    queryKey: ['version', versionId],
    queryFn: () => api.get<Manifest>(`/api/versions/${encodeURIComponent(versionId)}`),
  });
  const coverage = useQuery({
    queryKey: ['coverage', versionId],
    queryFn: () => api.get<Coverage>(`/api/coverage/${encodeURIComponent(versionId)}`),
    // A break from a timeout expires on the server (after a minute) without an event saying so: while any chapter
    // is broken, ask again now and then, so the player learns when it can paint it again.
    refetchInterval: q => (q.state.data?.broken.length ? BROKEN_RECHECK_MS : false),
  });
  const { data: jobs = [] } = useQuery(jobsQuery(versionId));

  if (manifest.error || song.error) {
    return <p className="text-muted-foreground p-6">{`Couldn't load this version: ${(manifest.error ?? song.error)!.message}`}</p>;
  }
  if (!song.data) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
        <Skeleton className="aspect-video w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }
  return (
    <WorkspaceBody
      versionId={versionId}
      song={song.data}
      manifest={manifest.data}
      coverage={coverage.data}
      coverageError={coverage.error?.message ?? null}
      jobs={jobs}
    />
  );
}

interface BodyProps {
  versionId: string;
  song: Song;
  manifest: Manifest | undefined;
  coverage: Coverage | undefined;
  coverageError: string | null;
  jobs: Job[];
}

function WorkspaceBody({ versionId, song, manifest, coverage, coverageError, jobs }: BodyProps) {
  const queryClient = useQueryClient();
  const search = useSearch({ from: '/versions/$id' });
  const navigate = useNavigate();
  const chapterStart = (ch: number | undefined) => (ch ? song.chapters[ch - 1]?.[0] : undefined);
  // Where the URL puts the playhead: its t, or else the selected chapter's start.
  const urlTime = search.t ?? chapterStart(search.ch);

  const onStaleKeys = useCallback(() => queryClient.invalidateQueries({ queryKey: ['coverage', versionId] }), [queryClient, versionId]);
  const player = usePreviewPlayer({
    versionId,
    song,
    coverage,
    segmentKeys: coverage?.segments,
    initialTime: urlTime ?? 0,
    onStaleKeys,
  });

  // URL -> player: a new t (or chapter) in the URL that isn't where the player already is.
  const applied = useRef(urlTime);
  const { seek } = player;
  // A seek from the timeline (a scrub, a block): what the URL will say next is already applied.
  const seekHere = useCallback(
    (to: number) => {
      applied.current = to;
      seek(to);
    },
    [seek],
  );
  useEffect(() => {
    if (urlTime === undefined || urlTime === applied.current) return;
    applied.current = urlTime;
    seek(urlTime);
  }, [urlTime, seek]);

  // player -> URL: its position whenever it isn't playing (after a seek, a scrub, a pause).
  const playing = player.state === 'playing';
  const t = roundTime(player.time);
  useEffect(() => {
    if (playing || t === roundTime(urlTime ?? 0)) return;
    const timer = setTimeout(() => {
      applied.current = t;
      void navigate({ to: '/versions/$id', params: { id: versionId }, search: prev => ({ ...prev, t }), replace: true });
    }, URL_WRITE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [playing, t, urlTime, navigate, versionId]);

  // A chapter selected, or the whole storyboard again: the inspector starts at its top.
  const inspectorBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (inspectorBox.current) inspectorBox.current.scrollTop = 0;
  }, [search.ch]);

  const written = manifest && new Set(manifest.files.map(f => /^ch\/c0(\d)/.exec(f)?.[1]).filter(Boolean)).size;
  const duration = songEnd(song.chapters);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-4 p-4 xl:flex-row xl:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <PreviewPlayer
          player={player}
          duration={duration}
          loadError={coverageError ? `Couldn't load which frames are painted: ${coverageError}` : null}
        />
        <div className="flex flex-col gap-1">
          <Timeline
            versionId={versionId}
            song={song}
            coverage={coverage}
            jobs={jobs}
            walkthrough={manifest?.walkthrough}
            selected={search.ch}
            time={player.time}
            onSeek={seekHere}
          />
          <LyricsTrack lyrics={song.lyrics} duration={duration} time={player.time} />
        </div>
        <RenderBar versionId={versionId} chapters={written} jobs={jobs} />
      </div>
      <div ref={inspectorBox} className="xl:sticky xl:top-4 xl:max-h-[calc(100dvh-6rem)] xl:w-[28rem] xl:shrink-0 xl:overflow-y-auto">
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <Inspector versionId={versionId} manifest={manifest} jobs={jobs} chapter={search.ch} />
        </Suspense>
      </div>
    </div>
  );
}
