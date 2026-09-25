// LogViewer.tsx: one job's log in a dialog, growing live as `log` events arrive (api/events.ts appends them to the
// ['job', id] query), and following the end of it only while you're already at the end. JobLogProvider (mounted by
// AppShell) owns which job is open; anything in the app calls useOpenJobLog()(jobId) to open one.
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { JobWithLog } from '@/api/types';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { jobDuration, jobLabel } from './jobFormat';

const OpenJobLogContext = createContext<(jobId: number) => void>(() => {});

// openJobLog(jobId): opens the log viewer on that job.
export function useOpenJobLog(): (jobId: number) => void {
  return useContext(OpenJobLogContext);
}

export function JobLogProvider({ children }: { children: ReactNode }) {
  const [jobId, setJobId] = useState<number | null>(null);
  return (
    <OpenJobLogContext.Provider value={setJobId}>
      {children}
      <LogViewer jobId={jobId} onClose={() => setJobId(null)} />
    </OpenJobLogContext.Provider>
  );
}

// Within this many pixels of the end still counts as "at the bottom" (sub-pixel scroll positions, zoom).
const AT_BOTTOM_SLACK = 8;

// jobId: the job to show, or null to close. While it closes (its exit animation), the dialog keeps showing the job
// it last showed rather than an empty "Loading…" one.
export function LogViewer({ jobId: requestedId, onClose }: { jobId: number | null; onClose: () => void }) {
  const open = requestedId != null;
  const [jobId, setJobId] = useState(requestedId);
  if (requestedId != null && requestedId !== jobId) setJobId(requestedId);
  const { data: job, error } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.get<JobWithLog>(`/api/jobs/${jobId}`),
    enabled: open, // a closed viewer keeps its cached copy to show on the way out, but stops refetching it
  });

  const viewport = useRef<HTMLDivElement>(null);
  // Whether to follow new output: true until you scroll up, true again once you scroll back to the end.
  const following = useRef(true);
  // A layout effect declared before the one that scrolls, so a newly opened log starts at its end even when its
  // text is already cached and arrives in the same render.
  useLayoutEffect(() => {
    following.current = true;
  }, [jobId]);
  const onScroll = () => {
    const el = viewport.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK;
  };
  useLayoutEffect(() => {
    const el = viewport.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [job?.log]);

  const duration = job && jobDuration(job);
  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{job ? `Log · ${jobLabel(job)} · ${job.status}` : `Log · job ${jobId ?? ''}`}</DialogTitle>
          <DialogDescription>
            {job
              ? [`job ${job.id}`, job.version_id, duration, job.error].filter(Boolean).join(' · ')
              : error
                ? `Couldn't load this log: ${error.message}`
                : 'Loading…'}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea
          ref={viewport}
          onScroll={onScroll}
          data-testid="job-log-viewport"
          className="bg-muted/40 h-[60vh] min-h-0 rounded-md border"
        >
          <pre data-testid="job-log" className="p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
            {job?.log || (job ? '(no output yet)' : '')}
          </pre>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
