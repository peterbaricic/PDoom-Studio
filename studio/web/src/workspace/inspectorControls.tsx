// inspectorControls.tsx: the pieces both inspector panels (StoryboardPanel, ChapterPanel) use: the storyboard's text
// and its rendered Markdown (which the watch view shows too), the Claude model picker, a button for an action that
// runs Claude (off, with the reason as its tooltip, while the CLI is missing or signed out), and a list of jobs with
// their logs.
import type { ComponentProps, ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Job, JobStatus } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { claudeUnavailable, useHealth } from '@/shell/HealthBanner';
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

// '' is the CLI's own default model; the jobs API takes `model: null` for it.
const MODELS: Array<[string, string]> = [
  ['', 'CLI default'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
];

// A native <select>, not Radix's: Radix Select injects a runtime <style> tag, which the SPA CSP blocks.
export function ModelSelect({ value, onChange, disabled }: { value: string; onChange: (model: string) => void; disabled?: boolean }) {
  return (
    <label className="text-muted-foreground flex items-center gap-2 text-xs">
      Claude model
      <select
        aria-label="Claude model"
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-md border px-2 text-sm outline-none focus-visible:ring-[3px] disabled:opacity-50"
      >
        {MODELS.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

// Why actions that run Claude can't right now (the CLI missing or signed out), or null when they can.
export function useClaudeUnavailable(): string | null {
  return claudeUnavailable(useHealth().data);
}

// A button that starts Claude: while `unavailable` is set it's disabled, and hovering or focusing it says why. (A
// disabled button gets no pointer events, so the tooltip hangs on a focusable wrapper instead.)
export function ClaudeButton({ unavailable, disabled, ...props }: ComponentProps<typeof Button> & { unavailable: string | null }) {
  if (!unavailable) return <Button disabled={disabled} {...props} />;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex w-fit">
          <Button disabled {...props} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{unavailable}</TooltipContent>
    </Tooltip>
  );
}

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
