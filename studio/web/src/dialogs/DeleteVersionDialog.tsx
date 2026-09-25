// DeleteVersionDialog.tsx: deletes one of the user's own versions (the version, its files and revisions, its jobs,
// what the frame cache still had queued for it), once its title has been typed to confirm. Its finished videos stay in
// the library under its title, unless "Also delete its finished videos" is ticked. Off while a job of the version is
// queued or running (the server refuses that too). Deleting the version on screen leaves it for "/", and forgets
// every query about it, so nothing keeps asking the server about a version that's gone.
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { rendersQuery } from '@/library/renders';
import { jobsQuery } from '@/shell/JobsDrawer';
import { useSelectedVersion } from '@/shell/useSelectedVersion';
import { useVersion, versionName } from './dialogParts';

interface Props {
  versionId: string;
  open: boolean;
  onClose: () => void;
}

// Every query about the version goes (cancelling any fetch or retry in flight); the lists it was in are refetched.
function forgetVersion(queryClient: QueryClient, versionId: string) {
  queryClient.removeQueries({ queryKey: ['version', versionId] });
  queryClient.removeQueries({ queryKey: ['coverage', versionId] });
  queryClient.removeQueries({ queryKey: ['jobs', { version: versionId }] });
  for (const queryKey of [['versions'], ['renders'], ['jobs']]) void queryClient.invalidateQueries({ queryKey });
}

const videoCount = (n: number) => (n === 1 ? 'Its video' : `Its ${n} videos`);

export function DeleteVersionDialog({ versionId, open, onClose }: Props) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const selected = useSelectedVersion();
  const { version, loaded } = useVersion(versionId);
  const jobs = useQuery({ ...jobsQuery(versionId), enabled: open && !!version });
  const renders = useQuery({ ...rendersQuery, enabled: open });
  const [typed, setTyped] = useState('');
  const [videos, setVideos] = useState(false);
  const confirmId = useId(), videosId = useId();

  const name = version ? versionName(version) : versionId;
  const busyJob = jobs.data?.filter(j => j.status === 'queued' || j.status === 'running').sort((a, b) => b.id - a.id)[0];
  const rendered = renders.data?.filter(r => r.version_id === versionId).length ?? 0;

  const del = useMutation({
    mutationFn: (withVideos: boolean) => api.del<{ ok: true }>(`/api/versions/${encodeURIComponent(versionId)}?videos=${withVideos ? 1 : 0}`),
    onSuccess: async () => {
      toast.success(`Deleted “${name}”`);
      onClose();
      // Off its screen first, so no mounted view asks for it again once its queries are gone.
      if (selected === versionId) await navigate({ to: '/' });
      forgetVersion(queryClient, versionId);
    },
  });
  const busy = del.isPending;
  const gone = loaded && !version;

  return (
    <Dialog open={open} onOpenChange={o => !o && !busy && onClose()}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{`Delete “${name}”?`}</DialogTitle>
          <DialogDescription>
            This deletes the version for good: its storyboard and chapters with every revision, and its jobs with their logs.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={e => {
            e.preventDefault();
            if (typed.trim() === name && !busy && !busyJob && version) del.mutate(videos);
          }}
        >
          <div className="flex items-start gap-2">
            <Checkbox id={videosId} checked={videos} disabled={busy} onCheckedChange={c => setVideos(c === true)} className="mt-0.5" />
            <div className="flex flex-col gap-0.5">
              <label htmlFor={videosId} className="text-sm font-medium">
                Also delete its finished videos
              </label>
              {rendered > 0 && (
                <span className="text-muted-foreground text-xs">
                  {videos
                    ? `${videoCount(rendered)} ${rendered === 1 ? 'is' : 'are'} deleted from the library too.`
                    : `${videoCount(rendered)} ${rendered === 1 ? 'stays' : 'stay'} in the library, under this title.`}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={confirmId} className="text-sm">
              {`Type “${name}” to confirm`}
            </label>
            <Input
              id={confirmId}
              value={typed}
              disabled={busy || !version}
              autoComplete="off"
              spellCheck={false}
              onChange={e => {
                del.reset();
                setTyped(e.target.value);
              }}
            />
          </div>
          {gone && <p className="text-sm">This version no longer exists.</p>}
          {busyJob && (
            <p className="text-sm">{`Not yet: a ${busyJob.kind} job for this version is still ${busyJob.status}. Let it finish, or cancel it, first.`}</p>
          )}
          {del.error && (
            <p role="alert" className="text-destructive text-sm">
              {`Couldn't delete it: ${del.error.message}`}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={busy || !version || !jobs.data || !!busyJob || typed.trim() !== name}>
              Delete version
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
