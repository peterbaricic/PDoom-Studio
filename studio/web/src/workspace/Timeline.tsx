// Timeline.tsx: the song as nine chapter blocks, each as wide as its window, over a track that shows which frames the
// server has cached (coverage shading) and where the playhead is. Clicking a block selects that chapter and seeks to
// its start (in the URL: ?ch=n&t=start); dragging on the track scrubs. A block shows when Claude is working on its
// chapter (or has it queued), when it isn't written yet, and when it's broken, with the error in its tooltip. A
// block whose chapter has a thumbnail strip shows it faintly behind its label.
import { useNavigate } from '@tanstack/react-router';
import { ClockIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react';
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Coverage, Job, Song, WalkthroughChapter } from '@/api/types';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatClock, songEnd, timeToX, timelineGeometry, xToTime } from './timelineGeometry';

export interface TimelineProps {
  versionId: string;
  song: Song;
  coverage: Coverage | undefined;
  jobs: Job[];
  // Chapter names, from the storyboard's walkthrough (when there is one).
  walkthrough?: WalkthroughChapter[];
  // Each chapter's thumbnail strip URL, where it has one (thumbs.ts).
  thumbs?: Record<number, string>;
  selected?: number;
  time: number;
  onSeek: (t: number) => void;
}

const pct = (v: number) => `${v}%`;

// How much of frames [first, last] the ranges cover, 0..1.
function coveredShare(ranges: Coverage['ranges'], first: number, last: number) {
  let n = 0;
  for (const [a, b] of ranges) n += Math.max(0, Math.min(b, last) - Math.max(a, first) + 1);
  return last >= first ? n / (last - first + 1) : 0;
}

export function Timeline({ versionId, song, coverage, jobs, walkthrough, thumbs, selected, time, onSeek }: TimelineProps) {
  const navigate = useNavigate();
  const duration = songEnd(song.chapters);
  const blocks = timelineGeometry(song.chapters, 100);
  const total = coverage?.total ?? song.frames;
  const chapterJobs = (n: number) => jobs.filter(j => j.kind === 'chapter' && Number(j.params.chapter) === n);

  const scrubTo = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(xToTime(e.clientX - r.left, duration, r.width));
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    scrubTo(e);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.buttons & 1) scrubTo(e);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const step = e.shiftKey ? 5 : 1;
    const to =
      e.key === 'ArrowRight' ? time + step : e.key === 'ArrowLeft' ? time - step : e.key === 'Home' ? 0 : e.key === 'End' ? duration : null;
    if (to == null) return;
    e.preventDefault();
    onSeek(Math.min(duration, Math.max(0, to)));
  };

  return (
    <div className="relative select-none">
      <div className="relative h-14">
        {blocks.map(b => {
          const key = coverage?.segments[b.n];
          const written = key !== null; // unknown (still loading) counts as written
          const error = coverage?.broken.find(x => x.chapter === b.n)?.error;
          const js = chapterJobs(b.n);
          const working = js.some(j => j.status === 'running');
          const queued = !working && js.some(j => j.status === 'queued');
          const name = walkthrough?.find(w => w.n === b.n)?.name;
          const [first, last] = [Math.ceil(b.start * song.fps - 1e-6), Math.ceil(b.end * song.fps - 1e-6) - 1];
          const share = coverage ? coveredShare(coverage.ranges, first, Math.min(last, total - 1)) : 0;
          const span = `${formatClock(b.start)}–${formatClock(b.end)}`;
          const status = error ? 'broken' : !written ? 'not written yet' : working ? 'Claude is working on it' : queued ? 'queued' : null;
          const thumb = written && !error ? thumbs?.[b.n] : undefined;
          return (
            <Tooltip key={b.n}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`Chapter ${b.n}${name ? ` · ${name}` : ''}, ${span}${status ? `, ${status}` : ''}`}
                  aria-pressed={selected === b.n}
                  data-broken={error ? 'true' : undefined}
                  onClick={() => {
                    // seek here too: re-selecting the selected block (while playing, say) leaves the URL as it was
                    onSeek(b.start);
                    void navigate({ to: '/versions/$id', params: { id: versionId }, search: { ch: b.n, t: b.start } });
                  }}
                  className={cn(
                    'absolute inset-y-0 flex flex-col items-start justify-between overflow-hidden rounded-sm border px-1.5 py-1 text-left text-xs transition-colors',
                    'hover:bg-accent focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]',
                    written ? 'bg-card' : 'bg-transparent border-dashed text-muted-foreground',
                    error && 'border-destructive bg-destructive/15',
                    selected === b.n && 'ring-primary ring-2',
                  )}
                  style={{ left: pct(b.x), width: pct(b.width) }}
                >
                  {thumb && (
                    // the strip's middle frame fills the block, faintly; decorative, the label says what it is
                    <img
                      src={thumb}
                      alt=""
                      aria-hidden
                      loading="lazy"
                      onError={e => (e.currentTarget.hidden = true)}
                      className="pointer-events-none absolute inset-0 size-full object-cover opacity-30"
                    />
                  )}
                  <span className="relative flex w-full items-center gap-1 font-medium">
                    <span>{b.n}</span>
                    {error && <TriangleAlertIcon aria-hidden className="text-destructive size-3.5 shrink-0" />}
                    {working && <LoaderCircleIcon aria-label="Claude is working on this chapter" className="size-3.5 shrink-0 animate-spin" />}
                    {queued && <ClockIcon aria-label="queued for Claude" className="text-muted-foreground size-3.5 shrink-0 opacity-60" />}
                  </span>
                  {name && <span className="text-muted-foreground relative w-full truncate">{name}</span>}
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm">
                <p className="font-medium">
                  Chapter {b.n}
                  {name ? ` · ${name}` : ''} ({span})
                </p>
                {error ? (
                  <p className="font-mono whitespace-pre-wrap">{error}</p>
                ) : !written ? (
                  <p>Not written yet.</p>
                ) : (
                  <p>
                    {Math.floor(share * 100)}% painted{working ? ' · Claude is working on it' : queued ? ' · queued for Claude' : ''}
                  </p>
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      {/* the track: cached frames shaded, the playhead on top; drag to scrub */}
      <div
        role="slider"
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration * 10) / 10}
        aria-valuenow={Math.round(time * 10) / 10}
        aria-valuetext={formatClock(time)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onKeyDown}
        className="bg-muted focus-visible:ring-ring/50 relative mt-1 h-4 cursor-pointer touch-none rounded-sm outline-none focus-visible:ring-[3px]"
      >
        {coverage?.ranges.map(([a, b]) => (
          <div
            key={`${a}-${b}`}
            data-range={`${a}-${b}`}
            className="absolute inset-y-0 bg-emerald-500/60"
            style={{ left: pct((a / total) * 100), width: pct(((b - a + 1) / total) * 100) }}
          />
        ))}
      </div>
      <div
        data-playhead
        aria-hidden
        className="bg-foreground pointer-events-none absolute -top-1 bottom-0 w-0.5 -translate-x-1/2"
        style={{ left: pct(timeToX(time, duration, 100)) }}
      />
    </div>
  );
}
