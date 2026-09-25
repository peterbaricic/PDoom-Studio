// events.ts: one EventSource('/api/events') per app (studio/events.js), turned into TanStack Query cache updates.
// Exactly the spec's "Data flow" list (docs/superpowers/specs/2026-09-25-react-studio-design.md, section 2):
//   version -> invalidate ['versions'] and ['version', id] (and ['coverage', id]: new code means new segment keys)
//   job     -> invalidate ['jobs'] and ['job', id]
//   log     -> append to ['job', id]'s log via setQueryData (at the event's offset; else refetch it)
//   library -> invalidate ['renders']
//   frames  -> merge ranges into ['coverage', id] via setQueryData
import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { Coverage, JobWithLog } from './types';

interface VersionEvent {
  id: string;
}
interface JobEvent {
  id: number;
  version_id: string;
}
interface LogEvent {
  id: number;
  // Where in the job's log `text` starts: the log's length before this append (UTF-16 code units, as JS counts).
  offset: number;
  text: string;
}
interface FramesEvent {
  versionId: string;
  ranges: Array<[number, number]>;
  broken: Coverage['broken'];
  segments?: Coverage['segments'];
}

// Two ranges (each [first, last], inclusive, frame indices) merge when they overlap or touch (adjacent integer
// ranges, e.g. [0,10] and [11,20], cover every frame between them with nothing left out).
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const sameSegments = (a: Coverage['segments'] | undefined, b: Coverage['segments']) =>
  !!a && [1, 2, 3, 4, 5, 6, 7, 8, 9].every(n => (a[n] ?? null) === (b[n] ?? null));

// Pure, unit-tested (events.test.ts): prev's ranges plus the event's, coalesced; broken is replaced with the event's
// (the frame service always reports the full current broken-chapter set, not a delta). When the event's segment keys
// differ from prev's, a chapter's code changed: prev's ranges were counted under the old keys, so the event's (always
// the full current coverage) replace them.
export function applyFramesEvent(prev: Coverage, e: Pick<FramesEvent, 'ranges' | 'broken' | 'segments'>): Coverage {
  if (e.segments && !sameSegments(prev.segments, e.segments)) {
    return { ...prev, ranges: mergeRanges(e.ranges), broken: e.broken, segments: e.segments };
  }
  return { ...prev, ranges: mergeRanges([...prev.ranges, ...e.ranges]), broken: e.broken };
}

// The event handling itself, factored out of the hook below so it can be unit-tested without mounting a component or
// faking EventSource: given the queryClient and one decoded SSE event, does exactly what the data-flow list says.
export function handleStudioEvent(queryClient: QueryClient, type: string, data: unknown): void {
  switch (type) {
    case 'version': {
      const { id } = data as VersionEvent;
      queryClient.invalidateQueries({ queryKey: ['versions'] });
      queryClient.invalidateQueries({ queryKey: ['version', id] });
      // A changed chapter, shared.js or option gives new segment keys: the frames cached under the old ones stop
      // counting, and the player has to learn the new keys now, not whenever something new gets painted.
      queryClient.invalidateQueries({ queryKey: ['coverage', id] });
      break;
    }
    case 'job': {
      const { id } = data as JobEvent;
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      break;
    }
    case 'log': {
      // Appended only where it belongs: a log fetched while lines were arriving may already hold this text, or lack
      // lines before it, and then only a refetch makes the copy right.
      const { id, offset, text } = data as LogEvent;
      const prev = queryClient.getQueryData<JobWithLog>(['job', id]);
      if (!prev) break;
      if (prev.log.length === offset) queryClient.setQueryData<JobWithLog>(['job', id], { ...prev, log: prev.log + text });
      else queryClient.invalidateQueries({ queryKey: ['job', id] });
      break;
    }
    case 'library': {
      queryClient.invalidateQueries({ queryKey: ['renders'] });
      break;
    }
    case 'frames': {
      const e = data as FramesEvent;
      queryClient.setQueryData<Coverage>(['coverage', e.versionId], prev => (prev ? applyFramesEvent(prev, e) : prev));
      break;
    }
    default:
      break;
  }
}

const EVENT_TYPES = ['version', 'job', 'log', 'library', 'frames'] as const;

// One EventSource per mounted app (main.tsx's App calls this once). Reconnection is the browser's own: a plain
// EventSource retries with backoff on its own, so a studio restart's dropped connection comes back without any code
// here — the client 403 handling in client.ts is what tells the user to reload for a stale token.
export function useStudioEvents(queryClient: QueryClient): void {
  useEffect(() => {
    const source = new EventSource('/api/events');
    const handlers = EVENT_TYPES.map(type => {
      const handler = (ev: MessageEvent<string>) => {
        try {
          handleStudioEvent(queryClient, type, JSON.parse(ev.data));
        } catch (e) {
          console.error(`studio event ${type}: could not handle`, e);
        }
      };
      source.addEventListener(type, handler);
      return { type, handler };
    });
    return () => {
      for (const { type, handler } of handlers) source.removeEventListener(type, handler);
      source.close();
    };
  }, [queryClient]);
}
