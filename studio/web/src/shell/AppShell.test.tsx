import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { routeTree } from '../router';
import { useSelectedVersion } from './useSelectedVersion';
import { job, mockApi, renderInRouter, renderRouteTree, version } from '../test-utils';

afterEach(() => vi.unstubAllGlobals());

const versions = [
  version({ id: 'original', title: 'P(doom)', example: true, status: 'ready', chapters: 9 }),
  version({ id: 'mine', title: 'My take', status: 'chapters', chapters: 3, updated_at: 10 }),
];

function mockShellApi(extra: Record<string, unknown> = {}) {
  return mockApi({
    'GET /api/versions': versions,
    'GET /api/library': [],
    'GET /api/jobs': [job({ id: 1, status: 'running' })],
    'GET /api/health': { claude: true, claudeSignedIn: true, ffmpeg: true, painter: { ok: true, reason: null } },
    // the workspace at /versions/mine (no chapters written, so no frames to ask for)
    'GET /api/song': { fps: 24, frames: 3759, duration: 156.6, chapters: [[0, 23], [23, 156.6]], lyrics: [] },
    'GET /api/versions/mine': { id: 'mine', title: 'My take', files: [], walkthrough: [] },
    'GET /api/coverage/mine': { total: 3759, ranges: [], broken: [], segments: { 1: null, 2: null } },
    'GET /api/jobs?version=mine': [],
    ...extra,
  });
}

// Radix opens its menu on a pointer press or a key, not a click.
const openMenu = async () => fireEvent.keyDown(await screen.findByRole('button', { name: 'Version actions' }), { key: 'Enter' });
const menuItems = async () => (await screen.findAllByRole('menuitem')).map(i => i.textContent);

describe('AppShell', () => {
  test('renders the sidebar, the header and the routed screen', async () => {
    mockShellApi();
    renderRouteTree(routeTree, { path: '/versions/mine' });
    const sidebar = await screen.findByRole('navigation', { name: 'Versions' });
    expect(await within(sidebar).findByRole('link', { name: /My take/ })).toBeInTheDocument();
    const header = screen.getByRole('banner');
    expect(await within(within(header).getByRole('navigation', { name: 'Breadcrumb' })).findByText('My take')).toBeInTheDocument();
    expect(await within(header).findByRole('button', { name: 'Jobs: 1 running · 0 queued' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(await within(screen.getByRole('main')).findByRole('slider', { name: 'Playhead' })).toBeInTheDocument();
  });

  test('"/" redirects into the most recently updated version of mine', async () => {
    mockShellApi();
    const { router } = renderRouteTree(routeTree, { path: '/' });
    await screen.findByRole('slider', { name: 'Playhead' });
    expect(router.state.location.pathname).toBe('/versions/mine');
  });

  test('the breadcrumb names the watch view and the library', async () => {
    mockShellApi();
    const { router } = renderRouteTree(routeTree, { path: '/versions/mine/watch' });
    const breadcrumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(await within(breadcrumb).findByText('My take')).toBeInTheDocument();
    expect(within(breadcrumb).getByText('Watch')).toBeInTheDocument();
    await router.navigate({ to: '/library' });
    expect(await within(breadcrumb).findByText('Library')).toBeInTheDocument();
    expect(within(breadcrumb).queryByText('My take')).toBeNull();
  });
});

test('a version whose id is "watch" is not taken for the watch view', async () => {
  mockApi({
    'GET /api/versions': [...versions, version({ id: 'watch', title: 'Watchful' })],
    'GET /api/library': [],
    'GET /api/jobs': [],
    'GET /api/health': { claude: true, claudeSignedIn: true, ffmpeg: true, painter: { ok: true, reason: null } },
  });
  renderRouteTree(routeTree, { path: '/versions/watch' });
  const breadcrumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
  expect(await within(breadcrumb).findByText('Watchful')).toHaveAttribute('aria-current', 'page');
  expect(within(breadcrumb).queryByText('Watch')).toBeNull();
});

describe('useSelectedVersion', () => {
  function Probe() {
    return <output>{useSelectedVersion() ?? 'none'}</output>;
  }

  test.each([
    ['/versions/mine', 'mine'],
    ['/versions/mine/watch', 'mine'],
    ['/library', 'none'],
  ])('at %s it is %s', async (path, expected) => {
    renderInRouter(<Probe />, { path });
    expect(await screen.findByRole('status')).toHaveTextContent(expected);
  });
});

describe('the version dialogs', () => {
  test('the version menu offers Remix, Promote and Delete for a version of mine', async () => {
    mockShellApi();
    renderRouteTree(routeTree, { path: '/versions/mine' });
    await openMenu();
    expect(await menuItems()).toEqual(['Remix…', 'Promote to an example…', 'Delete…']);
  });

  test('an example\'s menu offers only Remix, which opens the Remix dialog', async () => {
    mockShellApi();
    renderRouteTree(routeTree, { path: '/versions/original/watch' });
    await openMenu();
    expect(await menuItems()).toEqual(['Remix…']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remix…' }));
    expect(await screen.findByRole('heading', { name: 'Remix “P(doom)”' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('P(doom) (remix)'));
  });

  test('Promote and Delete open their dialogs for the version on screen', async () => {
    mockShellApi();
    renderRouteTree(routeTree, { path: '/versions/mine' });
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    expect(await screen.findByRole('heading', { name: 'Delete “My take”?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Promote to an example…' }));
    expect(await screen.findByRole('heading', { name: 'Promote “My take” to an example?' })).toBeInTheDocument();
  });

  test('there is no version menu off a version (the library), nor for one that does not exist', async () => {
    mockShellApi();
    const { router } = renderRouteTree(routeTree, { path: '/library' });
    await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await screen.findByRole('link', { name: /My take/ });
    expect(screen.queryByRole('button', { name: 'Version actions' })).toBeNull();
    await router.navigate({ to: '/versions/$id', params: { id: 'nope' } });
    await screen.findByText(/Couldn't load this version/);
    expect(screen.queryByRole('button', { name: 'Version actions' })).toBeNull();
  });

  test('"New version" in the sidebar opens the new-version dialog', async () => {
    mockShellApi();
    renderRouteTree(routeTree, { path: '/versions/mine' });
    const sidebar = await screen.findByRole('navigation', { name: 'Versions' });
    fireEvent.click(within(sidebar).getByRole('button', { name: 'New version' }));
    expect(await screen.findByRole('heading', { name: 'New version' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Draft storyboard' })).toBeDisabled();
  });

  test('an example\'s Remix call to action in the workspace opens the Remix dialog', async () => {
    mockShellApi({
      'GET /api/versions/original': { id: 'original', title: 'P(doom)', example: true, status: 'ready', files: [], walkthrough: [], concept: '', options: {}, fileRevisions: {}, storyboardErrors: [] },
      'GET /api/coverage/original': { total: 3759, ranges: [], broken: [], segments: { 1: null, 2: null } },
      'GET /api/jobs?version=original': [],
    });
    renderRouteTree(routeTree, { path: '/versions/original' });
    const cta = await within(await screen.findByRole('main')).findByRole('button', { name: /Remix/ }, { timeout: 3000 });
    await waitFor(() => expect(cta).toBeEnabled());
    fireEvent.click(cta);
    expect(await screen.findByRole('heading', { name: 'Remix “P(doom)”' })).toBeInTheDocument();
  });

  test('watching a render kept from a deleted version whose id a newer one took: its own title, no link, no menu', async () => {
    mockShellApi({
      'GET /api/library': [{ id: 8, version_id: 'mine', file: 'old.mp4', revision_ids: [], snapshot_id: null, title: 'The First Take', logline: '',
        duration_s: 1, render_s: 1, size_bytes: 1, poster: null, created_at: 1, detached: true }],
    });
    renderRouteTree(routeTree, { path: '/versions/mine/watch?render=8' });
    const breadcrumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    const crumb = await within(breadcrumb).findByText('The First Take');
    expect(crumb.closest('a')).toBeNull();
    expect(within(breadcrumb).queryByText('My take')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Version actions' })).toBeNull();
  });

  test('watching a render of a deleted version, the breadcrumb names it by the render\'s title and links nowhere', async () => {
    mockShellApi({
      'GET /api/library': [{ id: 8, version_id: 'gone', file: 'gone.mp4', revision_ids: [], snapshot_id: null, title: 'The Gone One', logline: '',
        duration_s: 1, render_s: 1, size_bytes: 1, poster: null, created_at: 1 }],
    });
    renderRouteTree(routeTree, { path: '/versions/gone/watch?render=8' });
    const breadcrumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    const crumb = await within(breadcrumb).findByText('The Gone One');
    expect(crumb.closest('a')).toBeNull();
    expect(within(breadcrumb).queryByRole('link')).toBeNull();
    expect(within(breadcrumb).queryByText('gone')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Version actions' })).toBeNull();
  });
});
