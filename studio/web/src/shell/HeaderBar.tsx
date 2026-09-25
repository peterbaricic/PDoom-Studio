// HeaderBar.tsx: where you are (a breadcrumb), the library, the jobs indicator and the settings.
import { useQuery } from '@tanstack/react-query';
import { Link, useMatchRoute } from '@tanstack/react-router';
import { ChevronRightIcon } from 'lucide-react';
import { api } from '@/api/client';
import type { Version } from '@/api/types';
import { Button } from '@/components/ui/button';
import { JobsIndicator } from './JobsIndicator';
import { SettingsPopover } from './SettingsPopover';
import { useSelectedVersion } from './useSelectedVersion';

export function HeaderBar() {
  const selected = useSelectedVersion();
  // Matched against the routes themselves, not the path's text: a version may well be called "watch".
  const matchRoute = useMatchRoute();
  const watching = !!matchRoute({ to: '/versions/$id/watch' });
  const inLibrary = !!matchRoute({ to: '/library' });
  const { data: versions = [] } = useQuery({ queryKey: ['versions'], queryFn: () => api.get<Version[]>('/api/versions') });
  const current = versions.find(v => v.id === selected);

  // Each crumb after the first; `versionLink` makes it a link back to that version's workspace.
  const crumbs: Array<{ label: string; versionLink?: string }> = [];
  if (selected) {
    crumbs.push({ label: current?.title || selected, versionLink: watching ? selected : undefined });
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
      <Button asChild variant="ghost" size="sm">
        <Link to="/library">Library</Link>
      </Button>
      <JobsIndicator />
      <SettingsPopover />
    </header>
  );
}
