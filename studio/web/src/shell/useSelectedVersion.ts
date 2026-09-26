// useSelectedVersion.ts: the version the URL is on (/versions/$id and /versions/$id/watch), or undefined elsewhere
// (/library), and whether the screen is that version's at all (useVersionOnScreen). Its own module because the shell's
// pieces (sidebar, header, jobs drawer) all read it and AppShell imports them — keeping it out of AppShell.tsx avoids
// an import cycle.
import { useQuery } from '@tanstack/react-query';
import { useMatchRoute, useParams, useSearch } from '@tanstack/react-router';
import type { Render } from '@/api/types';
import { rendersOf, rendersQuery } from '@/library/renders';

export function useSelectedVersion(): string | undefined {
  return useParams({ strict: false }).id;
}

export interface VersionOnScreen {
  // The id in the URL.
  selected: string | undefined;
  // On the watch view (matched against the routes themselves, not the path's text: a version may well be called
  // "watch").
  watching: boolean;
  // The render being watched, once the library is in.
  watched: Render | undefined;
  // The render named in the URL (?render=) may be a detached one, kept from a deleted version whose id a newer one
  // took: until the library says, the screen can't be said to be the version with that id.
  pending: boolean;
  // The render being watched is detached: it belongs to no version, not even the one with the same id.
  detached: boolean;
}

export function useVersionOnScreen(): VersionOnScreen {
  const selected = useSelectedVersion();
  const matchRoute = useMatchRoute();
  const watching = !!matchRoute({ to: '/versions/$id/watch' });
  const { render: renderId } = useSearch({ strict: false });
  const renders = useQuery({ ...rendersQuery, enabled: !!selected && watching });
  const watched =
    selected && watching
      ? renderId === undefined
        ? rendersOf(renders.data ?? [], selected)[0]
        : renders.data?.find(r => r.id === renderId && r.version_id === selected)
      : undefined;
  return {
    selected,
    watching,
    watched,
    pending: watching && renderId !== undefined && !renders.data && !renders.error,
    detached: !!watched?.detached,
  };
}
