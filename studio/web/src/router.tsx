// router.tsx: the SPA's routes (docs/superpowers/specs/2026-09-25-react-studio-design.md, section 2 "Routes"). Code-
// based (no file-router / codegen step): four routes, none of which collide with the server's own /v/…, /work/…,
// /api/…, /library/… or /thumbs/… — the server answers all of these with index.html (studio/app.js).
//
// Every screen sits inside AppShell (the root route's component: sidebar, header, overlays). The screen components
// here are still placeholders; later tasks (7-9) fill them in.
import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { api } from './api/client';
import type { Version } from './api/types';
import { AppShell } from './shell/AppShell';

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

interface WorkspaceSearch {
  ch?: number;
  t?: number;
}

function WorkspacePlaceholder() {
  const { id } = workspaceRoute.useParams();
  return <div>Workspace placeholder for version {id}</div>;
}

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/versions/$id',
  validateSearch: (search: Record<string, unknown>): WorkspaceSearch => {
    const ch = Number(search.ch);
    const t = Number(search.t);
    return {
      ...(Number.isInteger(ch) && ch >= 1 && ch <= 9 ? { ch } : {}),
      ...(Number.isFinite(t) && t >= 0 ? { t } : {}),
    };
  },
  component: WorkspacePlaceholder,
});

interface WatchSearch {
  render?: number;
}

function WatchPlaceholder() {
  const { id } = watchRoute.useParams();
  return <div>Watch placeholder for version {id}</div>;
}

const watchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/versions/$id/watch',
  validateSearch: (search: Record<string, unknown>): WatchSearch => {
    const render = Number(search.render);
    return Number.isInteger(render) ? { render } : {};
  },
  component: WatchPlaceholder,
});

function LibraryPlaceholder() {
  return <div>Library placeholder</div>;
}

const libraryRoute = createRoute({ getParentRoute: () => rootRoute, path: '/library', component: LibraryPlaceholder });

export const routeTree = rootRoute.addChildren([indexRoute, workspaceRoute, watchRoute, libraryRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
