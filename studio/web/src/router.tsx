// router.tsx: the SPA's routes (docs/superpowers/specs/2026-09-25-react-studio-design.md, section 2 "Routes"). Code-
// based (no file-router / codegen step): four routes, none of which collide with the server's own /v/…, /work/…,
// /api/…, /library/… or /thumbs/… — the server answers all of these with index.html (studio/app.js).
//
// Every screen sits inside AppShell (the root route's component: sidebar, header, overlays). The workspace is in the
// main bundle; the watch view and the library are loaded when first visited (lazyScreen), each in its own chunk.
import { Suspense, lazy, useCallback, useState, type ComponentType, type ReactElement } from 'react';
import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { api } from './api/client';
import type { Version } from './api/types';
import { LoadBoundary } from './components/LoadBoundary';
import { Skeleton } from './components/ui/skeleton';
import { AppShell } from './shell/AppShell';
import { Workspace, workspaceSearch } from './workspace/Workspace';

// A screen loaded on first use, with a skeleton meanwhile. If its chunk fails to load (the studio was rebuilt since
// this page loaded, say), the failure shows in place with Retry; React.lazy keeps a failed import failed for good, so
// Retry makes a fresh lazy component, kept at module level so later visits reuse the one that loaded.
function lazyScreen<P extends object>(what: string, load: () => Promise<ComponentType<P>>): (props: P) => ReactElement {
  const make = () => lazy(() => load().then(Screen => ({ default: Screen })));
  let Lazy = make();
  return function LazyScreen(props: P) {
    const [Screen, setScreen] = useState(() => Lazy);
    const retry = useCallback(() => {
      Lazy = make();
      setScreen(() => Lazy);
    }, []);
    return (
      <LoadBoundary what={what} onRetry={retry} className="m-4">
        <Suspense fallback={<Skeleton className="m-4 aspect-video max-w-4xl" />}>
          <Screen {...props} />
        </Suspense>
      </LoadBoundary>
    );
  };
}

const WatchView = lazyScreen('the watch view', () => import('./watch/WatchView').then(m => m.WatchView));
const LibraryGallery = lazyScreen('the library', () => import('./library/LibraryGallery').then(m => m.LibraryGallery));

const rootRoute = createRootRoute({ component: AppShell });

// "/" redirects to the most recently updated version of the user's own (not an example), else /versions/original —
// there's nothing to render here itself.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async () => {
    const versions = await api.get<Version[]>('/api/versions').catch(() => [] as Version[]);
    const mine = versions.filter(v => !v.example).sort((a, b) => b.updated_at - a.updated_at);
    throw redirect({ to: '/versions/$id', params: { id: mine[0]?.id ?? 'original' } });
  },
});

// The timeline workspace, afresh for each version (keyed): its player's requests and state belong to one version.
function WorkspaceRoute() {
  const { id } = workspaceRoute.useParams();
  return <Workspace key={id} versionId={id} />;
}

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/versions/$id',
  validateSearch: workspaceSearch,
  component: WorkspaceRoute,
});

interface WatchSearch {
  render?: number;
}

// Afresh for each version (keyed), like the workspace.
function WatchRoute() {
  const { id } = watchRoute.useParams();
  const { render } = watchRoute.useSearch();
  return <WatchView key={id} versionId={id} renderId={render} />;
}

const watchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/versions/$id/watch',
  validateSearch: (search: Record<string, unknown>): WatchSearch => {
    const render = Number(search.render);
    return Number.isInteger(render) ? { render } : {};
  },
  component: WatchRoute,
});

const libraryRoute = createRoute({ getParentRoute: () => rootRoute, path: '/library', component: LibraryGallery });

export const routeTree = rootRoute.addChildren([indexRoute, workspaceRoute, watchRoute, libraryRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
