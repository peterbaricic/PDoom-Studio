// ChapterPanel.tsx: the inspector with chapter n selected: its thumbnail strip (with "Refresh thumbnails", which
// queues the version's thumbs job), its section of the storyboard, a feedback box and
// "Revise chapter" (a chapter job; off while one for this chapter is queued or running), the chapter's code history
// with Restore on every revision but the current one (off under the same condition), and this chapter's jobs.
// Examples show the strip, section, history and jobs only (a thumbs job changes none of their code).
import { useState } from 'react';
import { ImageIcon, RefreshCwIcon } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { Job, Manifest, Revision } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ACTIVE, ClaudeButton, JobList, ModelSelect, StoryboardMarkdown, useClaudeUnavailable } from './inspectorControls';
import { storyboardSection } from './storyboardSections';
import { chapterThumbs } from './thumbs';

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

  const refreshThumbs = useMutation({
    mutationFn: () => api.post<{ id: number }>('/api/jobs', { kind: 'thumbs', versionId }),
    onSuccess: () => toast.success('Painting new thumbnails'),
    onError: e => toast.error(`Couldn't refresh the thumbnails: ${e.message}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  });
  const thumbsBusy = jobs.some(j => j.kind === 'thumbs' && ACTIVE.includes(j.status));

  const section = storyboard === undefined ? undefined : storyboardSection(storyboard, chapter);
  const reviseBlocked = active
    ? active.status === 'running'
      ? 'Claude is working on this chapter'
      : 'A job for this chapter is queued'
    : null;

  return (
    <div className="flex flex-col gap-4 p-3">
      <section aria-label="Thumbnails" data-thumbs className="flex flex-col gap-1.5">
        <ThumbStrip chapter={chapter} src={chapterThumbs(manifest)[chapter]} written={!!path} />
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground -ml-2 w-fit"
          disabled={thumbsBusy || refreshThumbs.isPending}
          title={thumbsBusy ? 'The thumbnails are being painted' : 'Paint every chapter\'s thumbnails again'}
          onClick={() => refreshThumbs.mutate()}
        >
          <RefreshCwIcon aria-hidden className={thumbsBusy ? 'animate-spin' : undefined} />
          Refresh thumbnails
        </Button>
      </section>

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

// The strip, or a placeholder of its size where there's none (or it didn't load). A failure counts for its URL only:
// a new strip gets a fresh chance to load.
function ThumbStrip({ chapter, src, written }: { chapter: number; src: string | undefined; written: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (src && failed !== src) {
    return (
      <img
        src={src}
        alt={`Chapter ${chapter} thumbnails`}
        onError={() => setFailed(src)}
        className="bg-muted aspect-[16/3] w-full rounded-md border object-cover"
      />
    );
  }
  return (
    <div className="bg-muted/40 text-muted-foreground flex aspect-[16/3] w-full items-center justify-center gap-1.5 rounded-md border border-dashed text-xs">
      <ImageIcon aria-hidden className="size-3.5" />
      <span>{written ? 'No thumbnails yet' : 'Not written yet'}</span>
    </div>
  );
}
