// PromoteDialog.tsx: moves one of the user's versions into studio/default.db as an example. Off while a Claude job
// (storyboard, shared, chapter) of the version is queued or running: it would go on to write into what is by then a
// read-only example, and the server refuses it too.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { JobKind, Version } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { jobsQuery } from '@/shell/JobsDrawer';
import { JobsError, useVersion, versionName } from './dialogParts';

const CLAUDE_KINDS: JobKind[] = ['storyboard', 'shared', 'chapter'];

interface Props {
  versionId: string;
  open: boolean;
  onClose: () => void;
}

export function PromoteDialog({ versionId, open, onClose }: Props) {
  const queryClient = useQueryClient();
  const { version } = useVersion(versionId);
  const jobs = useQuery({ ...jobsQuery(versionId), enabled: open });
  const busyJob = jobs.data
    ?.filter(j => CLAUDE_KINDS.includes(j.kind) && (j.status === 'queued' || j.status === 'running'))
    .sort((a, b) => b.id - a.id)[0];

  const promote = useMutation({
    mutationFn: () => api.post<Version>(`/api/versions/${encodeURIComponent(versionId)}/promote`),
    onSuccess: v => {
      toast.success(`“${versionName(v)}” is an example now`);
      onClose();
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['versions'] });
      void queryClient.invalidateQueries({ queryKey: ['version', versionId] });
    },
  });
  const busy = promote.isPending;

  return (
    <Dialog open={open} onOpenChange={o => !o && !busy && onClose()}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{version ? `Promote “${versionName(version)}” to an example?` : 'Promote to an example?'}</DialogTitle>
          <DialogDescription>
            Promoting moves this version into studio/default.db as an example; it becomes read-only here; commit studio/default.db to share it.
          </DialogDescription>
        </DialogHeader>
        <p className="text-muted-foreground text-sm">Its jobs and renders stay where they are. To change it afterwards, remix it.</p>
        {busyJob && (
          <p className="text-sm">{`Not yet: a ${busyJob.kind} job for this version is still ${busyJob.status}. Let it finish, or cancel it, first.`}</p>
        )}
        <JobsError jobs={jobs} />
        {promote.error && (
          <p role="alert" className="text-destructive text-sm">
            {`Couldn't promote it: ${promote.error.message}`}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !jobs.data || !!busyJob} onClick={() => promote.mutate()}>
            Promote
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
