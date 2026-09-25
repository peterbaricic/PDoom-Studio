// RenderBar.tsx: "Final render (1080p MP4)" for this version (a render job: studio/render-job.js fills the frame cache
// and encodes from it), disabled with the reason while it can't run: fewer than nine chapters written, or a render
// already queued or running (whose progress it shows). Beside it, the latest render's date and length, and Watch.
import { useId } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FilmIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { Job, Render } from '@/api/types';
import { Button } from '@/components/ui/button';
import { formatDuration } from '@/shell/jobFormat';

export interface RenderBarProps {
  versionId: string;
  // How many of the nine chapters are written; undefined while that isn't known yet.
  chapters: number | undefined;
  // This version's jobs.
  jobs: Job[];
}

export function RenderBar({ versionId, chapters, jobs }: RenderBarProps) {
  const reasonId = useId();
  const queryClient = useQueryClient();
  const { data: renders = [] } = useQuery({ queryKey: ['renders'], queryFn: () => api.get<Render[]>('/api/library') });
  const latest = renders.filter(r => r.version_id === versionId).sort((a, b) => b.created_at - a.created_at)[0];

  const running = jobs.find(j => j.kind === 'render' && j.status === 'running');
  const queued = jobs.find(j => j.kind === 'render' && j.status === 'queued');
  const start = useMutation({
    mutationFn: () => api.post<{ id: number }>('/api/jobs', { kind: 'render', versionId }),
    onSuccess: () => toast.success('Final render queued'),
    onError: e => toast.error(`Couldn't start the render: ${e.message}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  });

  const reason =
    chapters === undefined
      ? null
      : chapters < 9
        ? `needs all 9 chapters (${chapters} of 9 written)`
        : running
          ? 'a render is running'
          : queued
            ? 'a render is queued'
            : null;

  return (
    <div className="bg-card flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border px-3 py-2 text-sm">
      <Button
        size="sm"
        disabled={chapters === undefined || !!reason || start.isPending}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => start.mutate()}
      >
        <FilmIcon aria-hidden />
        Final render (1080p MP4)
      </Button>
      {reason && (
        <span id={reasonId} className="text-muted-foreground">
          {running ? `${reason} · ${Math.floor(running.progress * 100)}%` : reason}
        </span>
      )}
      <span className="text-muted-foreground ml-auto">
        {latest ? (
          <>
            Rendered {new Date(latest.created_at).toLocaleDateString()} {new Date(latest.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {latest.duration_s != null && ` · ${formatDuration(latest.duration_s * 1000)}`}
          </>
        ) : (
          'Not rendered yet'
        )}
      </span>
      {latest && (
        <Button asChild size="sm" variant="outline">
          <Link to="/versions/$id/watch" params={{ id: versionId }} search={{ render: latest.id }}>
            Watch
          </Link>
        </Button>
      )}
    </div>
  );
}
