// VersionSidebar.tsx: every version, "Examples" (★, read-only) above "My versions", each with where it stands, and
// "+ New version".
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { api } from '@/api/client';
import type { Render, Version } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useOpenVersionDialog } from '@/dialogs/VersionDialogs';
import { cn } from '@/lib/utils';
import { useSelectedVersion } from './useSelectedVersion';

// The stage a version is at, as the sidebar names it. `rendered`: whether the library has a finished video of it.
export function stageLabel(v: Version, rendered: boolean): string {
  switch (v.status) {
    case 'concept':
      return 'concept';
    case 'storyboard':
      return 'storyboard to review';
    case 'approved':
    case 'chapters':
      return `building ${v.chapters}/9`;
    case 'ready':
      return rendered ? 'rendered' : 'ready';
  }
}

export function VersionSidebar() {
  const selected = useSelectedVersion();
  const openDialog = useOpenVersionDialog();
  const { data: versions = [] } = useQuery({ queryKey: ['versions'], queryFn: () => api.get<Version[]>('/api/versions') });
  const { data: renders = [] } = useQuery({ queryKey: ['renders'], queryFn: () => api.get<Render[]>('/api/library') });
  const rendered = new Set(renders.map(r => r.version_id));
  const examples = versions.filter(v => v.example);
  const mine = versions.filter(v => !v.example).sort((a, b) => b.updated_at - a.updated_at);

  const item = (v: Version) => (
    <li key={v.id}>
      <Link
        to="/versions/$id"
        params={{ id: v.id }}
        aria-current={v.id === selected ? 'page' : undefined}
        className={cn(
          'hover:bg-accent flex flex-col gap-0.5 rounded-md px-3 py-2 text-sm',
          v.id === selected && 'bg-accent text-accent-foreground',
        )}
      >
        <span className="flex items-center gap-1.5 font-medium">
          <span className="truncate">{v.title || v.id}</span>
          {v.example && (
            <Badge variant="secondary" title="Example: read-only, remix it to change it">
              ★
            </Badge>
          )}
        </span>
        <span className="text-muted-foreground text-xs">{stageLabel(v, rendered.has(v.id))}</span>
      </Link>
    </li>
  );

  return (
    <nav aria-label="Versions" className="bg-card flex w-64 shrink-0 flex-col border-r">
      {openDialog && (
        <div className="border-b p-3">
          <Button variant="outline" size="sm" className="w-full" onClick={() => openDialog({ kind: 'new' })}>
            <PlusIcon />
            New version
          </Button>
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          <section aria-labelledby="sidebar-examples" className="flex flex-col gap-1">
            <h2 id="sidebar-examples" className="text-muted-foreground px-3 text-xs font-semibold tracking-wide uppercase">
              Examples
            </h2>
            <ul className="flex flex-col gap-0.5">{examples.map(item)}</ul>
          </section>
          <section aria-labelledby="sidebar-mine" className="flex flex-col gap-1">
            <h2 id="sidebar-mine" className="text-muted-foreground px-3 text-xs font-semibold tracking-wide uppercase">
              My versions
            </h2>
            {mine.length ? (
              <ul className="flex flex-col gap-0.5">{mine.map(item)}</ul>
            ) : (
              <p className="text-muted-foreground px-3 text-sm">No versions of your own yet.</p>
            )}
          </section>
        </div>
      </ScrollArea>
    </nav>
  );
}
