// inspectorControls.tsx: the pieces both inspector panels (StoryboardPanel, ChapterPanel) use: the storyboard's text
// and its rendered Markdown (which the watch view shows too), the Claude model picker and action button (from
// components/ClaudeControls.tsx), and a list of jobs with their logs.
import type { ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Job, JobStatus } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { jobDuration, jobLabel } from '@/shell/jobFormat';
import { useOpenJobLog } from '@/shell/LogViewer';

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
    // A 404 is an answer (no storyboard yet, or the version was deleted), not a hiccup: asking again won't change it.
    retry: (count: number, e: Error) => e.message !== 'not found' && count < 3,
    enabled,
  };
}

// Storyboards are written by Claude, so their Markdown is untrusted: raw HTML stays text (react-markdown's default,
// never rehype-raw), images show their alt text rather than loading anything, and links open in a new tab without
// handing this page (which carries the token) to whatever they point at.
const MARKDOWN_COMPONENTS: Components = {
  img: ({ alt }) => <span className="text-muted-foreground italic">{alt ? `[${alt}]` : '[image]'}</span>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export function StoryboardMarkdown({ markdown, className }: { markdown: string; className?: string }) {
  return (
    <div data-testid="storyboard-markdown" className={cn('storyboard-md', className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {markdown}
      </Markdown>
    </div>
  );
}

// The Claude model picker and the Claude action button live in components/ClaudeControls.tsx (the new-version
// dialog uses them too, without this module's Markdown renderer); re-exported here for the inspector panels.
export { ClaudeButton, ModelSelect, useClaudeUnavailable } from '@/components/ClaudeControls';

export const ACTIVE: JobStatus[] = ['queued', 'running'];

const STATUS_BADGE: Record<JobStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  running: 'default',
  queued: 'secondary',
  done: 'outline',
  cancelled: 'outline',
  failed: 'destructive',
  interrupted: 'destructive',
};

// Jobs, newest first, each with its status, timings, cost, error and a Log button (the app's log viewer).
export function JobList({ jobs, label, empty }: { jobs: Job[]; label: string; empty: ReactNode }) {
  const openJobLog = useOpenJobLog();
  const sorted = [...jobs].sort((a, b) => b.id - a.id);
  if (!sorted.length) return <p className="text-muted-foreground text-sm">{empty}</p>;
  return (
    <ul aria-label={label} className="flex flex-col divide-y">
      {sorted.map(j => {
        const duration = jobDuration(j);
        return (
          <li key={j.id} data-job-id={j.id} className="flex items-center gap-2 py-1.5 text-sm">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="font-medium">{jobLabel(j)}</span>
                <Badge variant={STATUS_BADGE[j.status]}>
                  {j.status}
                  {j.status === 'running' && j.progress > 0 ? ` ${Math.round(j.progress * 100)}%` : ''}
                </Badge>
              </div>
              <div className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
                <span>{new Date(j.started_at ?? j.created_at).toLocaleString()}</span>
                {duration && <span>{duration}</span>}
                {j.cost_usd > 0 && <span>${j.cost_usd.toFixed(2)}</span>}
                {typeof j.params.feedback === 'string' && j.params.feedback && (
                  <span className="truncate" title={j.params.feedback}>
                    “{j.params.feedback}”
                  </span>
                )}
              </div>
              {j.error && (
                <div className="text-destructive truncate text-xs" title={j.error}>
                  {j.error}
                </div>
              )}
            </div>
            <Button size="sm" variant="ghost" onClick={() => openJobLog(j.id)}>
              Log
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
