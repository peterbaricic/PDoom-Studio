// HeaderBar.tsx: where you are (a breadcrumb), the version menu (Remix, Promote, Delete: only those that apply), the
// library, the jobs indicator and the settings.
import { useQuery } from '@tanstack/react-query';
import { Link, useMatchRoute, useSearch } from '@tanstack/react-router';
import { ChevronRightIcon, CopyIcon, EllipsisIcon, PackageIcon, Trash2Icon } from 'lucide-react';
import { api } from '@/api/client';
import type { Version } from '@/api/types';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useOpenVersionDialog } from '@/dialogs/VersionDialogs';
import { rendersOf, rendersQuery, renderTitle } from '@/library/renders';
import { JobsIndicator } from './JobsIndicator';
import { SettingsPopover } from './SettingsPopover';
import { useSelectedVersion } from './useSelectedVersion';

export function HeaderBar() {
  const selected = useSelectedVersion();
  // Matched against the routes themselves, not the path's text: a version may well be called "watch".
  const matchRoute = useMatchRoute();
  const watching = !!matchRoute({ to: '/versions/$id/watch' });
  const inLibrary = !!matchRoute({ to: '/library' });
  const versions = useQuery({ queryKey: ['versions'], queryFn: () => api.get<Version[]>('/api/versions') });
  const version = versions.data?.find(v => v.id === selected);
  // The render being watched, when it's a render whose version was deleted (the version is missing, or the render
  // is detached, kept from a deleted version whose id a newer one took): it's watched under its own stored title,
  // with nothing to link to, and no version menu (the version it came from is gone).
  const { render: renderId } = useSearch({ strict: false });
  const renders = useQuery({ ...rendersQuery, enabled: !!selected && watching });
  const watched = selected
    ? renderId === undefined
      ? rendersOf(renders.data ?? [], selected)[0]
      : renders.data?.find(r => r.id === renderId && r.version_id === selected)
    : undefined;
  const orphan = watching && (watched?.detached || (!!selected && !!versions.data && !version));
  const current = orphan ? undefined : version;

  // Each crumb after the first; `versionLink` makes it a link back to that version's workspace.
  const crumbs: Array<{ label: string; versionLink?: string }> = [];
  if (selected) {
    const title = current ? current.title || selected : orphan && watched ? renderTitle(watched) : selected;
    crumbs.push({ label: title, versionLink: watching && current ? selected : undefined });
    if (watching) crumbs.push({ label: 'Watch' });
  } else if (inLibrary) {
    crumbs.push({ label: 'Library' });
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4 whitespace-nowrap">
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex items-center gap-1.5 text-sm">
          <li className="text-muted-foreground shrink-0 font-semibold whitespace-nowrap">P(doom) Studio</li>
          {crumbs.map((c, i) => (
            <li key={i} className="flex min-w-0 items-center gap-1.5">
              <ChevronRightIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
              {c.versionLink ? (
                <Link to="/versions/$id" params={{ id: c.versionLink }} className="truncate hover:underline">
                  {c.label}
                </Link>
              ) : (
                <span aria-current={i === crumbs.length - 1 ? 'page' : undefined} className="truncate font-medium">
                  {c.label}
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      {current && <VersionMenu version={current} />}
      <Button asChild variant="ghost" size="sm">
        <Link to="/library">Library</Link>
      </Button>
      <JobsIndicator />
      <SettingsPopover />
    </header>
  );
}

// The ⋯ menu for the version on screen: Remix for any version; Promote and Delete only for the user's own (examples
// are read-only). Not modal, so it doesn't hold the page while the dialog it opens takes over.
function VersionMenu({ version }: { version: Version }) {
  const openDialog = useOpenVersionDialog();
  if (!openDialog) return null;
  const open = (kind: 'remix' | 'promote' | 'delete') => openDialog({ kind, versionId: version.id });
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Version actions">
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => open('remix')}>
          <CopyIcon />
          Remix…
        </DropdownMenuItem>
        {!version.example && (
          <>
            <DropdownMenuItem onSelect={() => open('promote')}>
              <PackageIcon />
              Promote to an example…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => open('delete')}>
              <Trash2Icon />
              Delete…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
