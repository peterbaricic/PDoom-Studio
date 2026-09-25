// test-utils.tsx: shared helpers for the Vitest component tests (not shipped: nothing outside *.test.tsx imports it).
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRoute,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { Job, Version } from './api/types';

export function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
}

type Answer = unknown | ((init: RequestInit) => unknown);

// Stubs the global fetch with a table of "<METHOD> <path>" answers: a value is sent as a 200 JSON body, a Response
// as is, and a function is called with the request's init first. Anything not in the table is a 404, so a request a
// test didn't expect shows up as a failure rather than hanging.
export function mockApi(answers: Record<string, Answer>) {
  const fn = vi.fn(async (path: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${path}`;
    if (!(key in answers)) return new Response(JSON.stringify({ error: `no mock for ${key}` }), { status: 404 });
    const answer = answers[key];
    const body = typeof answer === 'function' ? (answer as (init: RequestInit) => unknown)(init) : answer;
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

// The "<METHOD> <path>" of every call a mockApi fetch received, in order.
export function calls(fetchMock: ReturnType<typeof mockApi>): string[] {
  return fetchMock.mock.calls.map(([path, init]) => `${init?.method ?? 'GET'} ${path}`);
}

// Renders `ui` as the root of a router with the app's four paths (their own screens left empty), at `path`, so
// components that read route params or render Links work as they do in the app.
export function renderInRouter(ui: ReactNode, { path = '/', queryClient = newQueryClient() } = {}) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        {ui}
        <Outlet />
      </>
    ),
  });
  const leaf = (p: string) => createRoute({ getParentRoute: () => rootRoute, path: p, component: () => null });
  const routeTree = rootRoute.addChildren([leaf('/'), leaf('/versions/$id'), leaf('/versions/$id/watch'), leaf('/library')]);
  return renderRouteTree(routeTree, { path, queryClient });
}

export function renderRouteTree(routeTree: AnyRoute, { path = '/', queryClient = newQueryClient() } = {}) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, router, queryClient };
}

export function version(overrides: Partial<Version> & Pick<Version, 'id'>): Version {
  return {
    title: overrides.id,
    logline: '',
    concept: '',
    options: { wipes: true, cornerMeter: true },
    status: 'concept',
    example: false,
    created_at: 1,
    updated_at: 1,
    chapters: 0,
    ...overrides,
  };
}

export function job(overrides: Partial<Job> & Pick<Job, 'id'>): Job {
  return {
    kind: 'chapter',
    version_id: 'mine',
    params: {},
    status: 'done',
    progress: 0,
    cost_usd: 0,
    model: null,
    error: null,
    created_at: 1_000,
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}
