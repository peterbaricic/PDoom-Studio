// events.ts: one EventSource('/api/events') per app (studio/events.js), turned into TanStack Query cache updates.
// Exactly the spec's "Data flow" list (docs/superpowers/specs/2026-09-25-react-studio-design.md, section 2):
//   version -> invalidate ['versions'] and ['version', id] (and ['coverage', id]: new code means new segment keys)
//   job     -> invalidate ['jobs'] and ['job', id]
//   log     -> append to ['job', id]'s log via setQueryData (at the event's offset; else refetch it)
//   library -> invalidate ['renders']
//   frames  -> replace ['coverage', id]'s ranges and broken chapters via setQueryData
// And when the stream comes back after dropping, everything is refetched (events may have been missed meanwhile); if
// it came back from a different server run (its `hello` names another boot id), the page is stale at once.
import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { markRestarted } from './client';
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
  seq?: number;
}

const sameSegments = (a: Coverage['segments'] | undefined, b: Coverage['segments']) =>
  !!a && [1, 2, 3, 4, 5, 6, 7, 8, 9].every(n => (a[n] ?? null) === (b[n] ?? null));

// Pure, unit-tested (events.test.ts): the frame service's every `frames` event is the version's whole current
// coverage, not what's new, so its ranges and broken chapters replace prev's. That's how coverage shrinks, too (frames
// evicted to stay under the cap, or the cache cleared). The segment keys go along when the event has them. One older
// than what's cached (by seq: a GET answered after the event was sent) changes nothing.
export function applyFramesEvent(prev: Coverage, e: Pick<FramesEvent, 'ranges' | 'broken' | 'segments' | 'seq'>): Coverage {
  if (e.seq != null && prev.seq != null && e.seq <= prev.seq) return prev;
  const next = { ...prev, ranges: e.ranges, broken: e.broken, ...(e.seq != null && { seq: e.seq }) };
  return e.segments && !sameSegments(prev.segments, e.segments) ? { ...next, segments: e.segments } : next;
}

// A GET /api/coverage answer, unless what's cached is newer (a frames event that came while it was on its way).
export function newerCoverage(cached: Coverage | undefined, answer: Coverage): Coverage {
  return cached?.seq != null && answer.seq != null && cached.seq > answer.seq ? cached : answer;
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

// Feeds one event stream into the query cache; returns what stops it. Reconnection is the browser's own (an
// EventSource retries by itself after an error); what's done here is catching up once it's back: every query is
// refetched, since events published while it was down never arrive. The server opens each stream with a `hello`
// naming its run (studio/events.js): a different one than before means the studio restarted, and this page's token is
// stale — said at once, rather than at the next mutation's 403 (client.ts).
export function watchStudioEvents(queryClient: QueryClient, source: EventSource): () => void {
  let dropped = false;
  let boot: string | undefined;
  // A message event's JSON, handled; one that can't be is logged, not thrown out of the stream's dispatch.
  const onMessage = (type: string, handle: (data: unknown) => void) => (ev: Event) => {
    try {
      handle(JSON.parse((ev as MessageEvent<string>).data));
    } catch (e) {
      console.error(`studio event ${type}: could not handle`, e);
    }
  };
  const listeners: Array<[string, (ev: Event) => void]> = [
    ['error', () => (dropped = true)],
    [
      'open',
      () => {
        if (!dropped) return;
        dropped = false;
        void queryClient.invalidateQueries();
      },
    ],
    [
      'hello',
      onMessage('hello', data => {
        const next = (data as { boot?: string }).boot;
        if (boot && next && next !== boot) markRestarted();
        boot ??= next;
      }),
    ],
    ...EVENT_TYPES.map((type): [string, (ev: Event) => void] => [type, onMessage(type, data => handleStudioEvent(queryClient, type, data))]),
  ];
  for (const [type, fn] of listeners) source.addEventListener(type, fn);
  return () => {
    for (const [type, fn] of listeners) source.removeEventListener(type, fn);
    source.close();
  };
}

// One EventSource per mounted app (main.tsx's App calls this once).
export function useStudioEvents(queryClient: QueryClient): void {
  useEffect(() => watchStudioEvents(queryClient, new EventSource('/api/events')), [queryClient]);
}
