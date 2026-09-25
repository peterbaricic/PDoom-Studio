// NewVersionDialog.tsx: a new version from a title (its id, a slug of it, editable), a concept and a model: "Draft
// storyboard" creates the version, asks Claude for its storyboard, and opens it.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { Version } from '@/api/types';
import { ClaudeButton, ModelSelect, useClaudeUnavailable } from '@/components/ClaudeControls';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Field, TitleAndIdFields, useTitleAndId } from './dialogParts';

export function NewVersionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const unavailable = useClaudeUnavailable();
  const fields = useTitleAndId();
  const [concept, setConcept] = useState('');
  const [model, setModel] = useState('');

  const create = useMutation({
    mutationFn: async () => {
      const v = await api.post<Version>('/api/versions', { id: fields.id, title: fields.title.trim(), concept: concept.trim() });
      // The version exists from here on: a storyboard job that can't be queued doesn't undo it (it can be redrafted
      // from the version itself), so that failure is reported, not thrown.
      const queued = await api.post<{ id: number }>('/api/jobs', { kind: 'storyboard', versionId: v.id, model: model || null }).then(
        () => null,
        (e: Error) => e.message,
      );
      return { v, queued };
    },
    onSuccess: ({ v, queued }) => {
      if (queued) toast.error(`Couldn't start the storyboard: ${queued}`);
      else toast.success('Claude is drafting the storyboard');
      onClose();
      void navigate({ to: '/versions/$id', params: { id: v.id } });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['versions'] }),
  });
  const busy = create.isPending;
  const ready = !!fields.title.trim() && !!concept.trim() && fields.idValid;
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    create.reset();
    set(value);
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && !busy && onClose()}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>New version</DialogTitle>
          <DialogDescription>Describe the idea, and Claude drafts a storyboard for you to review. The characters stay the same.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={e => {
            e.preventDefault();
            if (ready && !busy && !unavailable) create.mutate();
          }}
        >
          <TitleAndIdFields fields={{ ...fields, setTitle: edit(fields.setTitle), setId: edit(fields.setId) }} disabled={busy} />
          <Field label="Concept">
            {id => (
              <Textarea
                id={id}
                rows={5}
                value={concept}
                disabled={busy}
                placeholder="The setting, the story, the kind of jokes."
                onChange={e => edit(setConcept)(e.target.value)}
              />
            )}
          </Field>
          {create.error && (
            <p role="alert" className="text-destructive text-sm">
              {`Couldn't create it: ${create.error.message}`}
            </p>
          )}
          <DialogFooter className="items-center sm:justify-between">
            <ModelSelect value={model} onChange={setModel} disabled={busy} />
            <div className="flex gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <ClaudeButton type="submit" unavailable={unavailable} disabled={!ready || busy}>
                Draft storyboard
              </ClaudeButton>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
