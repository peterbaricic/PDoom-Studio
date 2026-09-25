// LibraryGallery.tsx: /library — every finished render as a poster card (title, logline, date), each opening the
// watch view. The latest render of each version comes first, then the older ones, newest first. Each card can delete
// its render (DELETE /api/library/:rid removes the video and poster files), after a confirmation.
//
// A render outlives its version: listRenders falls back to the title and logline stored with the render, so a card
// for a deleted version still has its name.
//
// Loaded lazily (router.tsx): its own chunk.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FilmIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { Render } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { libraryFile, renderTitle, rendersQuery } from './renders';

export function LibraryGallery() {
  const { data: renders, error } = useQuery(rendersQuery);
  const [toDelete, setToDelete] = useState<Render | null>(null);

  if (!renders) {
    if (error) return <p className="text-muted-foreground p-6">{`Couldn't load the library: ${error.message}`}</p>;
    return (
      <div className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
        <Skeleton className="aspect-video w-full" />
        <Skeleton className="aspect-video w-full" />
      </div>
    );
  }
  if (!renders.length) {
    return <p className="text-muted-foreground p-6">Nothing rendered yet. When a version has all nine chapters, "Final render" in its workspace puts the video here.</p>;
  }

  const newestFirst = [...renders].sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  const seen = new Set<string>();
  const latest: Render[] = [];
  const older: Render[] = [];
  for (const r of newestFirst) {
    // Renders kept from a deleted version are that version's, not those of a newer one that took its id.
    const version = r.detached ? `detached:${r.version_id}` : r.version_id;
    (seen.has(version) ? older : latest).push(r);
    seen.add(version);
  }

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-8 p-4">
      <Gallery id="latest-renders" title="Latest renders" renders={latest} onDelete={setToDelete} />
      {older.length > 0 && <Gallery id="older-renders" title="Older renders" renders={older} onDelete={setToDelete} />}
      <DeleteRenderDialog render={toDelete} onClose={() => setToDelete(null)} />
    </div>
  );
}

function Gallery({ id, title, renders, onDelete }: { id: string; title: string; renders: Render[]; onDelete: (r: Render) => void }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {renders.map(r => (
          <RenderCard key={r.id} render={r} onDelete={() => onDelete(r)} />
        ))}
      </div>
    </section>
  );
}

function RenderCard({ render, onDelete }: { render: Render; onDelete: () => void }) {
  return (
    <article className="bg-card flex flex-col overflow-hidden rounded-lg border">
      <Link to="/versions/$id/watch" params={{ id: render.version_id }} search={{ render: render.id }} className="group flex flex-col">
        {render.poster ? (
          <img src={libraryFile(render.poster)} alt="" className="aspect-video w-full bg-black object-cover" />
        ) : (
          <div className="bg-muted text-muted-foreground flex aspect-video w-full items-center justify-center">
            <FilmIcon aria-hidden className="size-8" />
          </div>
        )}
        <h3 className="px-3 pt-2 font-semibold group-hover:underline">{renderTitle(render)}</h3>
      </Link>
      {render.logline && <p className="text-muted-foreground px-3 pt-1 text-sm">{render.logline}</p>}
      <div className="mt-auto flex items-center gap-2 px-3 pt-2 pb-2">
        <span className="text-muted-foreground text-xs">{`Rendered ${new Date(render.created_at).toLocaleDateString()}`}</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onDelete} aria-label={`Delete the render of ${renderTitle(render)}`}>
          <Trash2Icon aria-hidden />
          Delete
        </Button>
      </div>
    </article>
  );
}

// Confirms before deleting: the video file is gone for good. While the delete is in flight, nothing in the dialog
// can be pressed and it can't be dismissed; a failure keeps it open with the reason.
function DeleteRenderDialog({ render, onClose }: { render: Render | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  // The render being asked about, kept after `render` goes back to null so the dialog's text stays put while it
  // animates closed.
  const [shown, setShown] = useState(render);
  if (render && render !== shown) setShown(render);
  const r = render ?? shown;
  const del = useMutation({
    mutationFn: (id: number) => api.del<{ ok: true }>(`/api/library/${id}`),
    onSuccess: () => {
      toast.success('Render deleted');
      close();
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['renders'] }),
  });
  const close = () => {
    del.reset();
    onClose();
  };

  return (
    <Dialog open={!!render} onOpenChange={open => !open && !del.isPending && close()}>
      <DialogContent showCloseButton={!del.isPending}>
        <DialogHeader>
          <DialogTitle>{r ? `Delete this render of “${renderTitle(r)}”?` : 'Delete this render?'}</DialogTitle>
          <DialogDescription>
            {`The video file is removed from the library for good${r ? ` (the render from ${new Date(r.created_at).toLocaleString()})` : ''}. The version itself isn't touched.`}
          </DialogDescription>
        </DialogHeader>
        {del.error && (
          <p role="alert" className="text-destructive text-sm">
            {`Couldn't delete it: ${del.error.message}`}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={del.isPending} onClick={close}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={del.isPending || !render} onClick={() => render && del.mutate(render.id)}>
            Delete render
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
