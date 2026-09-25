import { afterEach, describe, expect, test, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { routeTree } from '../router';
import { useSelectedVersion } from './useSelectedVersion';
import { job, mockApi, renderInRouter, renderRouteTree, version } from '../test-utils';

afterEach(() => vi.unstubAllGlobals());

const versions = [
  version({ id: 'original', title: 'P(doom)', example: true, status: 'ready', chapters: 9 }),
  version({ id: 'mine', title: 'My take', status: 'chapters', chapters: 3, updated_at: 10 }),
];

function mockShellApi() {
  return mockApi({
    'GET /api/versions': versions,
    'GET /api/library': [],
    'GET /api/jobs': [job({ id: 1, status: 'running' })],
    'GET /api/health': { claude: true, claudeSignedIn: true, ffmpeg: true },
  });
}

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
    expect(screen.getByRole('main')).toHaveTextContent('Workspace placeholder for version mine');
  });

  test('"/" redirects into the most recently updated version of mine', async () => {
    mockShellApi();
    const { router } = renderRouteTree(routeTree, { path: '/' });
    await screen.findByText('Workspace placeholder for version mine');
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
    'GET /api/health': { claude: true, claudeSignedIn: true, ffmpeg: true },
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
