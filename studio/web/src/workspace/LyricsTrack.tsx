// LyricsTrack.tsx: the song's lyrics under the timeline, each line under its own time span (GET /api/song's lyrics,
// from src/lyrics.js), with the line being sung marked.
import { memo } from 'react';
import { cn } from '@/lib/utils';
import { formatClock, timeToX } from './timelineGeometry';

export interface LyricsTrackProps {
  lyrics: Array<[number, number, string]>;
  duration: number;
  time: number;
}

const pct = (v: number) => `${v}%`;

// The lines only change with the song, so only the current one's mark follows the playhead.
const Line = memo(function Line({ start, end, text, duration, current }: { start: number; end: number; text: string; duration: number; current: boolean }) {
  return (
    <li
      title={`${formatClock(start)} ${text}`}
      aria-current={current || undefined}
      className={cn(
        'absolute inset-y-0 truncate border-l px-1 leading-6',
        current ? 'text-foreground border-primary bg-primary/10' : 'text-muted-foreground border-border',
      )}
      style={{ left: pct(timeToX(start, duration, 100)), width: pct(timeToX(end, duration, 100) - timeToX(start, duration, 100)) }}
    >
      {text}
    </li>
  );
});

export function LyricsTrack({ lyrics, duration, time }: LyricsTrackProps) {
  return (
    <ol aria-label="Lyrics" className="relative h-6 text-[11px]">
      {lyrics.map(([start, end, text]) => (
        <Line key={`${start}-${text}`} start={start} end={end} text={text} duration={duration} current={time >= start && time < end} />
      ))}
    </ol>
  );
}
