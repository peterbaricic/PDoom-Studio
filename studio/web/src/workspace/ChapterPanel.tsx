// ChapterPanel.tsx: the inspector with chapter n selected: its section of the storyboard, a feedback box and
// "Revise chapter" (a chapter job; off while one for this chapter is queued or running), the chapter's code history
// with Restore on every revision but the current one (off under the same condition), and this chapter's jobs.
// Examples show the section, history and jobs only.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { Job, Manifest, Revision } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ACTIVE, ClaudeButton, JobList, ModelSelect, StoryboardMarkdown, useClaudeUnavailable } from './inspectorControls';
import { storyboardSection } from './storyboardSections';

export interface ChapterPanelProps {
  versionId: string;
  manifest: Manifest;
  jobs: Job[];
  chapter: number;
  storyboard: string | undefined;
  storyboardError: string | null;
}

export function ChapterPanel({ versionId, manifest, jobs, chapter, storyboard, storyboardError }: ChapterPanelProps) {
  const queryClient = useQueryClient();
  const unavailable = useClaudeUnavailable();
  const editable = !manifest.example;
  const path = manifest.files.find(p => p.startsWith(`ch/c0${chapter}`));
  const current = path ? manifest.fileRevisions[path] : undefined;

  const [model, setModel] = useState('');
  const [feedback, setFeedback] = useState('');

  const chapterJobs = jobs.filter(j => j.kind === 'chapter' && Number(j.params.chapter) === chapter);
  const active = chapterJobs.filter(j => ACTIVE.includes(j.status)).sort((a, b) => b.id - a.id)[0];

  // Under ['version', id, …], so the `version` event that follows a revision or a restore refreshes it too.
  const history = useQuery({
    queryKey: ['version', versionId, 'revisions', path],
    queryFn: () => api.get<Revision[]>(`/api/versions/${encodeURIComponent(versionId)}/revisions?path=${encodeURIComponent(path!)}`),
    enabled: !!path,
  });

  const revise = useMutation({
    mutationFn: (text: string) =>
      api.post<{ id: number }>('/api/jobs', {
        kind: 'chapter',
        versionId,
        params: { chapter, ...(text ? { feedback: text } : {}) },
        model: model || null,
      }),
    onSuccess: () => {
      setFeedback('');
      toast.success(`Claude will revise chapter ${chapter}`);
    },
    onError: e => toast.error(`Couldn't revise chapter ${chapter}: ${e.message}`),
    // Settles once the job list includes the new job, so Revise goes straight from "sending" to "a job is queued".
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  });
  const restore = useMutation({
    mutationFn: (rid: number) => api.post<{ revision: number | null }>(`/api/revisions/${rid}/restore`),
    onSuccess: () => toast.success(`Restored an earlier version of chapter ${chapter}`),
    onError: e => toast.error(`Couldn't restore: ${e.message}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['version', versionId] }),
  });

  const section = storyboard === undefined ? undefined : storyboardSection(storyboard, chapter);
  const reviseBlocked = active
    ? active.status === 'running'
      ? 'Claude is working on this chapter'
      : 'A job for this chapter is queued'
    : null;

  return (
    <div className="flex flex-col gap-4 p-3">
      <section aria-label="Storyboard section" className="flex flex-col gap-2">
        {storyboardError ? (
          <p className="text-destructive text-sm">Couldn't load the storyboard: {storyboardError}</p>
        ) : !manifest.files.includes('STORYBOARD.md') ? (
          <p className="text-muted-foreground text-sm">There's no storyboard yet.</p>
        ) : section === undefined ? (
          <p className="text-muted-foreground text-sm">Loading the storyboard…</p>
        ) : section ? (
          <StoryboardMarkdown markdown={section} />
        ) : (
          <p className="text-muted-foreground text-sm">The storyboard has no section for chapter {chapter}.</p>
        )}
      </section>

      {editable && (
        <section aria-label="Revise" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{path ? 'Revise this chapter' : 'Write this chapter'}</h3>
          <Textarea
            aria-label="What should change in this chapter?"
            placeholder="What should change in this chapter?"
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <ClaudeButton
              unavailable={unavailable}
              size="sm"
              disabled={!!reviseBlocked || revise.isPending}
              title={reviseBlocked ?? undefined}
              onClick={() => revise.mutate(feedback.trim())}
            >
              Revise chapter
            </ClaudeButton>
            <ModelSelect value={model} onChange={setModel} />
          </div>
          {reviseBlocked && <p className="text-muted-foreground text-xs">{reviseBlocked}.</p>}
        </section>
      )}

      <section aria-label="History" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">History</h3>
        {!path ? (
          <p className="text-muted-foreground text-sm">Not written yet.</p>
        ) : history.error ? (
          <p className="text-destructive text-sm">Couldn't load the history: {history.error.message}</p>
        ) : !history.data ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : (
          <ul aria-label="Revisions" className="flex flex-col divide-y">
            {history.data.map(r => (
              <li key={r.id} data-revision-id={r.id} className="flex items-center gap-2 py-1.5 text-sm">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span>
                    {new Date(r.created_at).toLocaleString()} · {r.source}
                  </span>
                  {r.note && (
                    <span className="text-muted-foreground truncate text-xs" title={r.note}>
                      {r.note}
                    </span>
                  )}
                </div>
                {r.id === current ? (
                  <span className="text-muted-foreground text-xs">current</span>
                ) : (
                  editable && (
                    <Button
                      size="sm"
                      variant="outline"
                      // a job for this chapter would write over the restored code when it finishes
                      disabled={restore.isPending || !!reviseBlocked}
                      title={reviseBlocked ?? undefined}
                      onClick={() => restore.mutate(r.id)}
                    >
                      Restore
                    </Button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Chapter jobs" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Jobs</h3>
        <JobList jobs={chapterJobs} label={`Jobs for chapter ${chapter}`} empty="No jobs for this chapter yet." />
      </section>
    </div>
  );
}
