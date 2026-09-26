import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Outlet, createRootRoute, createRoute } from '@tanstack/react-router';
import type { Coverage, Manifest, Song } from '@/api/types';
import { mockApi, newQueryClient, renderRouteTree } from '../test-utils';
import { LoadBoundary } from '@/components/LoadBoundary';
import { Workspace, brokenRecheckMs, workspaceSearch } from './Workspace';

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
function stubApi(overrides: Record<string, unknown> = {}) {
  const frames: string[] = [];
  const api = mockApi({
    'GET /api/song': SONG,
    'GET /api/versions/mine': MANIFEST,
    'GET /api/coverage/mine': COVERAGE,
    ...overrides,
    'GET /api/jobs?version=mine': [],
    'GET /api/library': [],
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      if (path.endsWith('/paint-ahead')) return Promise.resolve(new Response('{}'));
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

  test('a coverage that can\'t be loaded shows as an error in the player', async () => {
    stubApi({ 'GET /api/coverage/mine': new Response(JSON.stringify({ error: 'the frame service is down' }), { status: 500 }) });
    renderWorkspace('/versions/mine');
    expect(await screen.findByRole('alert')).toHaveTextContent('the frame service is down');
  });

  test('the inspector beside the player follows the selected chapter, and goes back to the whole storyboard', async () => {
    stubApi({ 'GET /v/mine/STORYBOARD.md': () => new Response('## 2 · The Tent (23–38.5)\n\nTent shots.\n') });
    const { router } = renderWorkspace('/versions/mine');
    const inspector = await screen.findByRole('complementary', { name: 'Inspector' });
    expect(await within(inspector).findByRole('heading', { name: 'Storyboard', level: 2 })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /^Chapter 2\b/ }));
    expect(await within(inspector).findByRole('heading', { name: 'Chapter 2', level: 2 })).toBeInTheDocument();
    expect(await within(inspector).findByText('Tent shots.')).toBeInTheDocument();
    fireEvent.click(within(inspector).getByRole('button', { name: /Whole storyboard/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ t: 23 }));
    expect(await within(inspector).findByRole('heading', { name: 'Storyboard', level: 2 })).toBeInTheDocument();
    expect(screen.getByText('0:23 / 2:36')).toBeInTheDocument();
  });

  test('a break that runs out is asked about again once it has, not before', async () => {
    let asked = 0;
    const until = Date.now() + 400;
    stubApi({
      'GET /api/coverage/mine': () => {
        asked++;
        return asked === 1 ? { ...COVERAGE, broken: [{ chapter: 2, error: 'timed out', until }] } : COVERAGE;
      },
    });
    renderWorkspace('/versions/mine');
    await waitFor(() => expect(asked).toBe(1));
    await new Promise(r => setTimeout(r, 200));
    expect(asked).toBe(1);
    await waitFor(() => expect(asked).toBe(2), { timeout: 3000 });
    await new Promise(r => setTimeout(r, 1500));
    expect(asked).toBe(2); // nothing broken now: no more asking
  });

  test('shows the lyrics and the render bar', async () => {
    stubApi();
    renderWorkspace('/versions/mine');
    expect(await screen.findByText("I'm upping my P(doom)")).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Final render \(1080p MP4\)/ })).toBeEnabled();
  });

  test('an inspector that fails (its chunk not loading) shows the error in place, and Retry tries again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); // React reports the caught error
    let failing = true;
    function Flaky() {
      if (failing) throw new Error('Failed to fetch dynamically imported module');
      return <p>the inspector</p>;
    }
    const onRetry = vi.fn(() => {
      failing = false;
    });
    render(
      <div>
        <p>the player</p>
        <LoadBoundary what="the inspector" onRetry={onRetry}>
          <Flaky />
        </LoadBoundary>
      </div>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load the inspector: Failed to fetch dynamically imported module");
    expect(screen.getByText('the player')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(await screen.findByText('the inspector')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    vi.mocked(console.error).mockRestore();
  });
});

describe('brokenRecheckMs', () => {
  const at = (broken: Coverage['broken']): Coverage => ({ ...COVERAGE, broken });

  test('nothing broken, or only chapters broken until their code changes: never (a version event says when)', () => {
    expect(brokenRecheckMs(undefined, 0)).toBe(false);
    expect(brokenRecheckMs(at([]), 0)).toBe(false);
    expect(brokenRecheckMs(at([{ chapter: 3, error: 'threw' }]), 0)).toBe(false);
  });

  test('a break that runs out: just after the earliest one does', () => {
    const now = 1_000_000;
    const broken = at([
      { chapter: 3, error: 'threw' },
      { chapter: 5, error: 'timed out', until: now + 40_000 },
      { chapter: 7, error: 'timed out', until: now + 9_000 },
    ]);
    expect(brokenRecheckMs(broken, now)).toBe(9_250);
  });

  test('one that should have run out already (the clock, a slow answer): soon, but not in a tight loop', () => {
    expect(brokenRecheckMs(at([{ chapter: 5, error: 'timed out', until: 500 }]), 1_000)).toBe(1_000);
  });
});
