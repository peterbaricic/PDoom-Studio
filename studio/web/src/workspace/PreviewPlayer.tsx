// PreviewPlayer.tsx: the picture (a 1920x1080 <canvas> the player draws server-painted frames onto) and its controls:
// Play/Pause (Cancel while waiting), the time, how long until it's safe to play, "Play now (m:ss ready)" and full
// screen (the Fullscreen API, on the player itself). The playback logic is usePreviewPlayer's; Workspace owns the
// player, because the timeline drives it too.
import { useEffect, useRef, useState } from 'react';
import { LoaderCircleIcon, MaximizeIcon, MinimizeIcon, PauseIcon, PlayIcon, TriangleAlertIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatClock } from './timelineGeometry';
import type { PreviewPlayer as Player } from './usePreviewPlayer';

export interface PreviewPlayerProps {
  player: Player;
  duration: number;
  // Why the player can't know what's painted (the coverage didn't load).
  loadError?: string | null;
}

// What the player is up to, in a line.
function statusLine({ state, safeIn, error, starting }: Player): string | null {
  if (error) return null;
  if (state === 'playing') return 'Playing';
  if (starting) return 'Starting…';
  const wait = safeIn == null ? null : formatClock(Math.ceil(safeIn));
  if (state === 'waiting') return wait ? `Starts by itself in about ${wait}` : 'Starts by itself once it can play without stopping';
  if (safeIn === 0) return 'Ready to play without stopping';
  return wait ? `Safe to play in ${wait}` : 'Painting frames…';
}

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName));
// A dialog or sheet is open (or has focus): the space bar is its business.
const modalOpen = (el: EventTarget | null) =>
  !!document.querySelector('[role="dialog"][data-state="open"]') || (el instanceof Element && !!el.closest('[role="dialog"]'));

export function PreviewPlayer({ player, duration, loadError }: PreviewPlayerProps) {
  const box = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const { state, time, safeIn, aheadReady, painting, cantPaint, play, playNow, canvasRef } = player;
  const error = player.error ?? loadError ?? null;

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement && document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Space plays and pauses, unless it's meant for a field or a button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || typing(e.target) || modalOpen(e.target)) return;
      e.preventDefault();
      play();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [play]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void box.current?.requestFullscreen?.();
  };

  const status = statusLine({ ...player, error });
  const showPlayNow = state !== 'playing' && !error && safeIn !== 0 && aheadReady >= 1;

  return (
    <div
      ref={box}
      className="group flex flex-col bg-black data-[fullscreen=true]:h-full"
      data-fullscreen={fullscreen}
      data-painting={painting}
    >
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <canvas
          ref={canvasRef}
          width={1920}
          height={1080}
          className="aspect-video max-h-[60vh] w-full bg-black object-contain group-data-[fullscreen=true]:aspect-auto group-data-[fullscreen=true]:h-full group-data-[fullscreen=true]:max-h-none"
        />
        {error ? (
          <div role="alert" className="absolute inset-x-6 bottom-6 flex items-start gap-2 rounded-md bg-black/80 p-3 text-sm text-red-200">
            <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span className="font-mono whitespace-pre-wrap">{error}</span>
          </div>
        ) : (
          painting &&
          (cantPaint ? (
            // the server has no painting browser: waiting won't bring the frame, so say why instead
            <div role="status" className="absolute top-3 right-3 left-3 flex items-start justify-end gap-1.5 text-xs">
              <span className="flex items-start gap-1.5 rounded bg-black/70 px-2 py-1 text-amber-200">
                <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
                {`Can't paint previews: ${cantPaint}`}
              </span>
            </div>
          ) : (
            <div className="absolute top-3 right-3 flex items-center gap-1.5 rounded bg-black/70 px-2 py-1 text-xs text-white/80">
              <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />
              Painting…
            </div>
          ))
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 bg-black/90 px-3 py-2 text-sm text-white">
        <Button size="sm" variant="secondary" onClick={play} className="w-24">
          {state === 'playing' ? <PauseIcon aria-hidden /> : state === 'waiting' ? <LoaderCircleIcon aria-hidden className="animate-spin" /> : <PlayIcon aria-hidden />}
          {state === 'playing' ? 'Pause' : state === 'waiting' ? 'Cancel' : 'Play'}
        </Button>
        <span className="tabular-nums">{`${formatClock(time)} / ${formatClock(duration)}`}</span>
        {status && <span className="text-white/70">{status}</span>}
        {showPlayNow && (
          <Button size="sm" variant="outline" className="bg-transparent text-white" onClick={playNow}>
            {`Play now (${formatClock(aheadReady)} ready)`}
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto size-8 text-white"
          aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <MinimizeIcon aria-hidden /> : <MaximizeIcon aria-hidden />}
        </Button>
      </div>
    </div>
  );
}
