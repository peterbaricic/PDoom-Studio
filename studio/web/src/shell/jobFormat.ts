// jobFormat.ts: how the shell names a job and its timings (shared by JobsDrawer and LogViewer).
import type { Job } from '@/api/types';

// "chapter 4", "storyboard", "render".
export function jobLabel(j: Pick<Job, 'kind' | 'params'>): string {
  const chapter = j.params.chapter;
  return typeof chapter === 'number' || typeof chapter === 'string' ? `${j.kind} ${chapter}` : j.kind;
}

// m:ss (or h:mm:ss) from milliseconds.
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const mmss = `${Math.floor((s % 3600) / 60)}:${String(s % 60).padStart(2, '0')}`;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mmss.padStart(5, '0')}` : mmss;
}

// How long a job ran, or has been running so far; null before it starts.
export function jobDuration(j: Pick<Job, 'started_at' | 'finished_at'>, now = Date.now()): string | null {
  return j.started_at == null ? null : formatDuration((j.finished_at ?? now) - j.started_at);
}
