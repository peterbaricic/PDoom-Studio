import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Outlet, createRootRoute, createRoute } from '@tanstack/react-router';
import type { Coverage, Manifest, Song } from '@/api/types';
import { mockApi, newQueryClient, renderRouteTree } from '../test-utils';
import { Workspace, workspaceSearch } from './Workspace';

afterEach(() => vi.unstubAllGlobals());

const CHAPTERS: Array<[number, number]> = [
  [0, 23], [23, 38.5], [38.5, 59], [59, 73], [73, 95.4], [95.4, 109.4], [109.4, 123.5], [123.5, 140.5], [140.5, 156.6],
];
const SONG: Song = {
  fps: 24,
  frames: 3759,
  duration: 156.6,
  chapters: CHAPTERS,
  lyrics: [[23, 24.4, "I'm upping my P(doom)"]],
};
const segments = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => [n, `k${n}`]));
const COVERAGE: Coverage = { total: 3759, ranges: [], broken: [], segments };
const MANIFEST = {
  id: 'mine',
  title: 'Mine',
  logline: '',
  status: 'ready',
  example: false,
  options: { wipes: true, cornerMeter: true },
  concept: '',
  files: ['STORYBOARD.md', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `ch/c0${n}.js`)],
  scripts: [],
  walkthrough: [],
  fileRevisions: {},
  storyboardErrors: [],
} satisfies Manifest;

// The app's API, with frame requests left waiting (painting takes as long as the test likes).
function stubApi() {
  const frames: string[] = [];
  const api = mockApi({
    'GET /api/song': SONG,
    'GET /api/versions/mine': MANIFEST,
    'GET /api/coverage/mine': COVERAGE,
    'GET /api/jobs?version=mine': [],
    'GET /api/library': [],
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      if (!path.startsWith('/api/frames/')) return api(path, init);
      frames.push(path);
      return new Promise(() => {});
    }),
  );
  return { frames };
}

function renderWorkspace(path: string) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const ws = createRoute({
    getParentRoute: () => root,
    path: '/versions/$id',
    validateSearch: workspaceSearch,
    component: function Route() {
      const { id } = ws.useParams();
      return <Workspace key={id} versionId={id} />;
    },
  });
  return renderRouteTree(root.addChildren([ws]), { path, queryClient: newQueryClient() });
}

describe('Workspace', () => {
  test('puts the playhead where the URL says (t), and asks for that frame first', async () => {
    const { frames } = stubApi();
    renderWorkspace('/versions/mine?t=30');
    expect(await screen.findByText('0:30 / 2:36')).toBeInTheDocument();
    await waitFor(() => expect(frames[0]).toBe('/api/frames/mine/720.jpg?prio=preview'));
  });

  test('clicking a chapter block selects it and seeks to its start, through the URL', async () => {
    stubApi();
    const { router } = renderWorkspace('/versions/mine');
    fireEvent.click(await screen.findByRole('button', { name: /^Chapter 2\b/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ ch: 2, t: 23 }));
    expect(await screen.findByText('0:23 / 2:36')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Chapter 2\b/ })).toHaveAttribute('aria-pressed', 'true');
  });

  test('a chapter in the URL without a time seeks to that chapter\'s start', async () => {
    stubApi();
    renderWorkspace('/versions/mine?ch=3');
    expect(await screen.findByText('0:38 / 2:36')).toBeInTheDocument();
  });

  test('scrubbing moves the playhead and writes it to the URL', async () => {
    stubApi();
    const { router } = renderWorkspace('/versions/mine');
    const track = await screen.findByRole('slider', { name: 'Playhead' });
    track.getBoundingClientRect = () => ({ left: 0, width: 1566, top: 0, height: 20, right: 1566, bottom: 20, x: 0, y: 0, toJSON() {} });
    fireEvent.pointerDown(track, { clientX: 1000, buttons: 1, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 1000, pointerId: 1 });
    expect(await screen.findByText('1:40 / 2:36')).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toEqual({ t: 100 }));
  });

  test('shows the lyrics and the render bar', async () => {
    stubApi();
    renderWorkspace('/versions/mine');
    expect(await screen.findByText("I'm upping my P(doom)")).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Final render \(1080p MP4\)/ })).toBeEnabled();
  });
});
