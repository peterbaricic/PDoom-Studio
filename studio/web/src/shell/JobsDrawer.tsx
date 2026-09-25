// JobsDrawer.tsx: every job, newest first, for this version or all of them: kind, chapter, status, when it started,
// how long it ran and what it cost, with its log, and Cancel or Retry where either makes sense.
import { useState } from 'react';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { Job, JobStatus } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { jobDuration, jobLabel } from './jobFormat';
import { useOpenJobLog } from './LogViewer';
import { useSelectedVersion } from './useSelectedVersion';

// ['jobs', { version? }]: one version's jobs, or every version's (GET /api/jobs, the 100 newest).
export function jobsQuery(version?: string) {
  return queryOptions({
    queryKey: ['jobs', version ? { version } : {}],
    queryFn: () => api.get<Job[]>(version ? `/api/jobs?version=${encodeURIComponent(version)}` : '/api/jobs'),
  });
}

const CANCELLABLE: JobStatus[] = ['queued', 'running'];
const RETRYABLE: JobStatus[] = ['failed', 'cancelled', 'interrupted'];
const STATUS_BADGE: Record<JobStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  running: 'default',
  queued: 'secondary',
  done: 'outline',
  cancelled: 'outline',
  failed: 'destructive',
  interrupted: 'destructive',
};

export function JobsDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const selected = useSelectedVersion();
  const [scope, setScope] = useState<'version' | 'all'>('version');
  const version = scope === 'version' ? selected : undefined;
  const { data: jobs = [], error } = useQuery({ ...jobsQuery(version), enabled: open });
  const sorted = [...jobs].sort((a, b) => b.id - a.id);

  const queryClient = useQueryClient();
  const onSettled = () => queryClient.invalidateQueries({ queryKey: ['jobs'] });
  const cancel = useMutation({
    mutationFn: (id: number) => api.post(`/api/jobs/${id}/cancel`),
    onSettled,
    onError: e => toast.error(`Couldn't cancel the job: ${e.message}`),
  });
  const retry = useMutation({
    mutationFn: (id: number) => api.post(`/api/jobs/${id}/retry`),
    onSettled,
    onError: e => toast.error(`Couldn't retry the job: ${e.message}`),
  });
  const openJobLog = useOpenJobLog();

  const scopeButton = (value: 'version' | 'all', label: string, disabled = false) => (
    <Button
      size="sm"
      variant={(version ? 'version' : 'all') === value ? 'secondary' : 'ghost'}
      aria-pressed={(version ? 'version' : 'all') === value}
      disabled={disabled}
      onClick={() => setScope(value)}
    >
      {label}
    </Button>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Jobs</SheetTitle>
          <SheetDescription>{version ? `Jobs for ${version}, newest first.` : 'Jobs for every version, newest first.'}</SheetDescription>
          <div role="group" aria-label="Show jobs for" className="flex gap-1 pt-1">
            {scopeButton('version', 'This version', !selected)}
            {scopeButton('all', 'All versions')}
          </div>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1 px-4 pb-4">
          {error && <p className="text-destructive text-sm">Couldn't load the jobs: {error.message}</p>}
          {!error && !sorted.length && <p className="text-muted-foreground text-sm">No jobs yet.</p>}
          <ul aria-label="Jobs" className="flex flex-col divide-y">
            {sorted.map(j => {
              const duration = jobDuration(j);
              const busy = (cancel.isPending && cancel.variables === j.id) || (retry.isPending && retry.variables === j.id);
              return (
                <li key={j.id} data-job-id={j.id} data-status={j.status} className="flex items-center gap-3 py-2 text-sm">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{jobLabel(j)}</span>
                      {!version && <span className="text-muted-foreground truncate">{j.version_id}</span>}
                      <Badge variant={STATUS_BADGE[j.status]}>
                        {j.status}
                        {j.status === 'running' && j.progress > 0 ? ` ${Math.round(j.progress * 100)}%` : ''}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground flex gap-2 text-xs">
                      <span>{j.started_at ? `started ${new Date(j.started_at).toLocaleString()}` : `queued ${new Date(j.created_at).toLocaleString()}`}</span>
                      {duration && <span>{duration}</span>}
                      {j.cost_usd > 0 && <span>${j.cost_usd.toFixed(2)}</span>}
                    </div>
                    {j.error && <div className="text-destructive truncate text-xs" title={j.error}>{j.error}</div>}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openJobLog(j.id)}>
                      Log
                    </Button>
                    {CANCELLABLE.includes(j.status) && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => cancel.mutate(j.id)}>
                        Cancel
                      </Button>
                    )}
                    {RETRYABLE.includes(j.status) && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => retry.mutate(j.id)}>
                        Retry
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
