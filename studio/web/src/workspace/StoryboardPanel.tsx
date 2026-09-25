// StoryboardPanel.tsx: the inspector with no chapter selected: the storyboard review. The rendered storyboard (or a
// "writing…" state while Claude drafts it) and its problems; "Edit text" (saved as a manual revision); "Ask for
// changes" (a storyboard job with feedback); Approve, which queues shared.js and the nine chapters and stands out
// while the storyboard waits for review; the concept with "Redraft storyboard"; and the engine options. Examples are
// read-only: only the storyboard and the concept show.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, LoaderCircleIcon, PencilIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, api } from '@/api/client';
import type { Job, Manifest, VersionOptions } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useOpenJobLog } from '@/shell/LogViewer';
import { ACTIVE, ClaudeButton, ModelSelect, StoryboardMarkdown, useClaudeUnavailable } from './inspectorControls';
import { withoutFrontMatter } from './storyboardSections';

export interface StoryboardPanelProps {
  versionId: string;
  manifest: Manifest;
  jobs: Job[];
  // STORYBOARD.md's text: undefined while it loads (or when there is none), with the error if it couldn't be read.
  storyboard: string | undefined;
  storyboardError: string | null;
}

// A hand edit in progress: the text being written, and what it started from (the storyboard's text and revision
// then), so a storyboard that changes underneath it (a Claude job, another tab) is noticed instead of overwritten.
interface Draft {
  text: string;
  base: string;
  baseRevision: number | null;
  // The server refused the save: the storyboard had moved on from baseRevision.
  refused: boolean;
}

const OPTIONS: Array<[keyof VersionOptions & string, string]> = [
  ['wipes', 'Brush wipes between chapters'],
  ['cornerMeter', 'Corner P(doom) meter'],
];

export function StoryboardPanel({ versionId, manifest, jobs, storyboard, storyboardError }: StoryboardPanelProps) {
  const queryClient = useQueryClient();
  const openJobLog = useOpenJobLog();
  const unavailable = useClaudeUnavailable();
  const editable = !manifest.example;
  const hasStoryboard = manifest.files.includes('STORYBOARD.md');
  const toReview = manifest.status === 'storyboard';
  const vpath = `/api/versions/${encodeURIComponent(versionId)}`;
  // Settles once the version (manifest and storyboard text) has been read again, so a button stays off until what
  // it changed is on screen.
  const refreshVersion = () => queryClient.invalidateQueries({ queryKey: ['version', versionId] });
  const refreshJobs = () => queryClient.invalidateQueries({ queryKey: ['jobs'] });

  const [model, setModel] = useState('');
  const [feedback, setFeedback] = useState('');
  // The concept as edited here, or null while it's untouched (then the saved one shows, and follows changes).
  const [concept, setConcept] = useState<string | null>(null);
  // The hand edit in progress, or null when not editing.
  const [draft, setDraft] = useState<Draft | null>(null);

  const storyboardJob = jobs.filter(j => j.kind === 'storyboard').sort((a, b) => b.id - a.id)[0];
  const writing = storyboardJob && ACTIVE.includes(storyboardJob.status) ? storyboardJob : undefined;
  // shared.js and the chapters being built: the server refuses to approve meanwhile.
  const building = jobs.find(j => (j.kind === 'shared' || j.kind === 'chapter') && ACTIVE.includes(j.status));
  const currentRevision = manifest.fileRevisions['STORYBOARD.md'] ?? null;
  const save = useMutation({
    mutationFn: (d: Draft) =>
      api.put<{ revision: number | null; errors: string[] }>(`${vpath}/files/STORYBOARD.md`, { content: d.text, baseRevision: d.baseRevision }),
    onSuccess: async () => {
      await refreshVersion();
      setDraft(null);
    },
    onError: async e => {
      if (e instanceof ApiError && e.status === 409) {
        setDraft(cur => cur && { ...cur, refused: true });
        await refreshVersion();
      } else toast.error(`Couldn't save the storyboard: ${e.message}`);
    },
  });
  // The storyboard moved on since the edit started (read again after a `version` event, or the save was refused).
  // Not while saving: the save's own re-read changes both, and the server checks the base anyway.
  const conflict =
    !!draft && !save.isPending && (draft.refused || currentRevision !== draft.baseRevision || (storyboard !== undefined && storyboard !== draft.base));
  const openEditor = () => setDraft({ text: storyboard ?? '', base: storyboard ?? '', baseRevision: currentRevision, refused: false });

  const ask = useMutation({
    mutationFn: (text: string) =>
      api.post<{ id: number }>('/api/jobs', { kind: 'storyboard', versionId, params: { feedback: text }, model: model || null }),
    onSuccess: () => {
      setFeedback('');
      toast.success('Asked Claude for changes to the storyboard');
    },
    onError: e => toast.error(`Couldn't ask for changes: ${e.message}`),
    onSettled: refreshJobs,
  });
  const approve = useMutation({
    mutationFn: () => api.post<{ jobs: number[] }>(`${vpath}/approve`, { model: model || null }),
    onSuccess: async () => {
      toast.success('Approved: Claude is building the chapters');
      await refreshVersion();
    },
    onError: e => toast.error(`Couldn't approve: ${e.message}`),
    onSettled: refreshJobs,
  });
  const redraft = useMutation({
    mutationFn: async (text: string) => {
      if (text !== manifest.concept) await api.put(vpath, { concept: text });
      return api.post<{ id: number }>('/api/jobs', { kind: 'storyboard', versionId, model: model || null });
    },
    onSuccess: async () => {
      toast.success('Claude is redrafting the storyboard');
      await refreshVersion();
      setConcept(null);
    },
    onError: e => toast.error(`Couldn't redraft the storyboard: ${e.message}`),
    onSettled: refreshJobs,
  });
  const setOption = useMutation({
    mutationFn: ({ key, value }: { key: string; value: boolean }) => api.put(vpath, { options: { ...manifest.options, [key]: value } }),
    onSuccess: refreshVersion,
    onError: e => toast.error(`Couldn't change the option: ${e.message}`),
  });

  const conceptText = concept ?? manifest.concept;
  const problems = manifest.storyboardErrors;
  const approveBlocked = !hasStoryboard || manifest.status === 'concept'
    ? 'There is no storyboard to approve yet'
    : !toReview
      ? 'Already approved'
      : writing
        ? 'Wait for the storyboard job to finish'
        : building
          ? `Wait for the ${building.kind} job that is ${building.status}`
          : draft
            ? 'Save or cancel your edit first'
            : problems.length
              ? "Fix the storyboard's problems first"
              : null;

  // Approve and the model every Claude action here uses. While the storyboard waits for review, this leads the panel;
  // afterwards it sits under the storyboard, Approve off.
  const review = editable && (
    <section aria-label="Review" className={cn('flex flex-col gap-2 rounded-md', toReview && 'border-primary/60 bg-primary/5 border p-3')}>
      {toReview && <p className="text-sm">Read the storyboard, ask for changes if you like, then approve it to build the nine chapters.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <ClaudeButton
          unavailable={unavailable}
          size={toReview ? 'lg' : 'sm'}
          variant={toReview ? 'default' : 'outline'}
          data-prominent={toReview && !approveBlocked ? '' : undefined}
          disabled={!!approveBlocked || approve.isPending}
          title={approveBlocked ?? undefined}
          onClick={() => approve.mutate()}
        >
          <CheckIcon aria-hidden />
          Approve and build chapters
        </ClaudeButton>
        <ModelSelect value={model} onChange={setModel} />
      </div>
      {toReview && approveBlocked && <p className="text-muted-foreground text-xs">{approveBlocked}</p>}
    </section>
  );

  return (
    <div className="flex flex-col gap-4 p-3">
      {writing && (
        <div role="status" className="bg-muted/40 flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
          <span className="flex-1">
            {writing.status === 'queued' ? 'Claude is about to write the storyboard…' : 'Claude is writing the storyboard…'}
          </span>
          <Button size="sm" variant="ghost" onClick={() => openJobLog(writing.id)}>
            Log
          </Button>
        </div>
      )}
      {!writing && storyboardJob?.status === 'failed' && (
        <p className="text-destructive text-sm">
          The last storyboard job failed{storyboardJob.error ? `: ${storyboardJob.error}` : '.'}{' '}
          <Button size="sm" variant="link" className="h-auto p-0" onClick={() => openJobLog(storyboardJob.id)}>
            Log
          </Button>
        </p>
      )}

      {toReview && review}

      {problems.length > 0 && (
        <div role="alert" className="border-destructive/50 bg-destructive/10 rounded-md border px-3 py-2 text-sm">
          <p className="font-medium">The storyboard doesn't match the format the studio reads:</p>
          <ul className="list-disc pl-5">
            {problems.map(p => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <section aria-label="Storyboard" className="flex flex-col gap-2">
        {/* the inspector's own header already says "Storyboard" */}
        {editable && draft === null && (
          <Button
            size="sm"
            variant="outline"
            className="self-end"
            disabled={(hasStoryboard && storyboard === undefined) || !!writing}
            title={writing ? 'Wait for the storyboard job to finish' : undefined}
            onClick={openEditor}
          >
            <PencilIcon aria-hidden />
            Edit text
          </Button>
        )}
        {draft !== null ? (
          <>
            {conflict && (
              <div role="alert" className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                <p>
                  <span className="font-medium">The storyboard changed while you were editing.</span> Reload to see the new text
                  (your edit is discarded), or keep editing to save yours over it.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setDraft(null)}>
                    Reload
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    // rebased onto the storyboard as it is now: Save then deliberately replaces it
                    disabled={!!writing || (hasStoryboard && storyboard === undefined)}
                    onClick={() => setDraft(d => d && { ...d, base: storyboard ?? '', baseRevision: currentRevision, refused: false })}
                  >
                    Keep editing
                  </Button>
                </div>
              </div>
            )}
            <Textarea
              aria-label="Storyboard text"
              value={draft.text}
              onChange={e => setDraft({ ...draft, text: e.target.value })}
              className="min-h-96 font-mono text-xs"
            />
            {writing && <p className="text-muted-foreground text-xs">Claude is writing the storyboard: wait for it before saving.</p>}
            <div className="flex gap-2">
              <Button size="sm" disabled={save.isPending || conflict || !!writing} onClick={() => save.mutate(draft)}>
                Save
              </Button>
              <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </>
        ) : storyboardError ? (
          <p className="text-destructive text-sm">Couldn't load the storyboard: {storyboardError}</p>
        ) : !hasStoryboard ? (
          <p className="text-muted-foreground text-sm">
            {writing ? 'It will appear here when Claude has written it.' : 'No storyboard yet. Describe the concept below and redraft it.'}
          </p>
        ) : storyboard === undefined ? (
          <p className="text-muted-foreground text-sm">Loading the storyboard…</p>
        ) : (
          <StoryboardMarkdown markdown={withoutFrontMatter(storyboard)} />
        )}
      </section>

      {!toReview && review}

      {editable && hasStoryboard && (
        <section aria-label="Ask for changes" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Ask for changes</h3>
          <Textarea
            aria-label="What should change in the storyboard?"
            placeholder='e.g. "set chapter 5 in a food truck"'
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
          />
          <ClaudeButton
            unavailable={unavailable}
            size="sm"
            variant="secondary"
            className="self-start"
            disabled={!feedback.trim() || !!writing || ask.isPending}
            onClick={() => ask.mutate(feedback.trim())}
          >
            Ask for changes
          </ClaudeButton>
        </section>
      )}

      <section aria-label="Concept" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Concept</h3>
        {editable ? (
          <>
            <Textarea aria-label="Concept" value={conceptText} onChange={e => setConcept(e.target.value)} />
            <ClaudeButton
              unavailable={unavailable}
              size="sm"
              variant="secondary"
              className="self-start"
              disabled={!conceptText.trim() || !!writing || redraft.isPending}
              onClick={() => redraft.mutate(conceptText)}
            >
              Redraft storyboard
            </ClaudeButton>
          </>
        ) : (
          <p className="text-muted-foreground text-sm whitespace-pre-wrap">{manifest.concept || 'No concept written down.'}</p>
        )}
      </section>

      {editable && (
        <section aria-label="Engine options" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Engine options</h3>
          {OPTIONS.map(([key, label]) => {
            const pending = setOption.isPending && setOption.variables?.key === key;
            const checked = pending ? setOption.variables!.value : !!manifest.options[key];
            return (
              <label key={key} className="flex items-center gap-2 text-sm">
                <Checkbox
                  aria-label={label}
                  checked={checked}
                  disabled={setOption.isPending}
                  onCheckedChange={v => setOption.mutate({ key, value: v === true })}
                />
                {label}
              </label>
            );
          })}
        </section>
      )}
    </div>
  );
}
