// RemixDialog.tsx: a copy of a version (an example, or one of the user's own) as a new version of the user's, under
// a new title and id; then it opens. No Claude involved: the copy has the same storyboard and chapters.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { ApiError, api } from '@/api/client';
import type { Version } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TitleAndIdFields, useTitleAndId, useVersion, versionName } from './dialogParts';

interface Props {
  versionId: string;
  open: boolean;
  onClose: () => void;
}

export function RemixDialog({ versionId, open, onClose }: Props) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { version } = useVersion(versionId);
  const fields = useTitleAndId();
  // The copy's title starts as the source's, marked as a remix, once the source is known (and nothing's been typed).
  const [seeded, setSeeded] = useState(false);
  if (version && !seeded) {
    setSeeded(true);
    if (!fields.title) fields.setTitle(`${versionName(version)} (remix)`);
  }

  const remix = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.post<Version>(`/api/versions/${encodeURIComponent(versionId)}/remix`, { id, title }),
    onSuccess: v => {
      toast.success(`Remixed as “${versionName(v)}”`);
      onClose();
      void navigate({ to: '/versions/$id', params: { id: v.id } });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['versions'] }),
  });
  const busy = remix.isPending;
  const taken = remix.error instanceof ApiError && remix.error.status === 409;
  const ready = !!fields.title.trim() && fields.idValid;

  return (
    <Dialog open={open} onOpenChange={o => !o && !busy && onClose()}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{version ? `Remix “${versionName(version)}”` : 'Remix'}</DialogTitle>
          <DialogDescription>
            A copy of its storyboard and chapters becomes a new version of your own, to change as you like. The original stays as it is.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={e => {
            e.preventDefault();
            if (ready && !busy) remix.mutate({ id: fields.id, title: fields.title.trim() });
          }}
        >
          <TitleAndIdFields
            fields={{
              ...fields,
              setTitle: t => (remix.reset(), fields.setTitle(t)),
              setId: v => (remix.reset(), fields.setId(v)),
            }}
            taken={taken}
            disabled={busy}
          />
          {remix.error && (
            <p role="alert" className="text-destructive text-sm">
              {taken
                ? `There is already a version with the id “${remix.variables?.id}”. Pick another id.`
                : `Couldn't remix it: ${remix.error.message}`}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || busy}>
              Remix
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
