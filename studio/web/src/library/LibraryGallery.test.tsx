import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Render } from '@/api/types';
import { calls, mockApi, renderInRouter } from '../test-utils';
import { LibraryGallery } from './LibraryGallery';

afterEach(() => vi.unstubAllGlobals());

const WHEN = Date.UTC(2026, 8, 20, 12, 0);

const render = (overrides: Partial<Render> & Pick<Render, 'id'>): Render => ({
  version_id: 'mine',
  file: `r-${overrides.id}.mp4`,
  revision_ids: [],
  snapshot_id: null,
  title: 'Mine',
  logline: 'A bake-off, doomed.',
  duration_s: 156.6,
  render_s: 300,
  size_bytes: 1,
  poster: `r-${overrides.id}.jpg`,
  created_at: WHEN + overrides.id * 86_400_000,
  detached: false,
  ...overrides,
});

// As GET /api/library answers: newest first.
const RENDERS = [
  render({ id: 6 }),
  render({ id: 5 }),
  render({ id: 4, version_id: 'other', title: 'Other', logline: 'Another take.', poster: null }),
  render({ id: 3, version_id: 'gone', title: 'The Gone One', logline: 'Its version was deleted.' }),
  render({ id: 2, version_id: 'other', title: 'Other', logline: 'Another take.' }),
];

function library(answers: Record<string, unknown> = {}) {
  const fetchMock = mockApi({ 'GET /api/library': RENDERS, ...answers });
  const utils = renderInRouter(<LibraryGallery />, { path: '/library' });
  return { ...utils, fetchMock };
}

const cardLinks = (section: HTMLElement) => within(section).getAllByRole('link').map(a => a.getAttribute('href'));

describe('LibraryGallery', () => {
  test('shows the latest render of each version first, then the older ones, newest first', async () => {
    library();
    const latest = await screen.findByRole('region', { name: 'Latest renders' });
    expect(cardLinks(latest)).toEqual(['/versions/mine/watch?render=6', '/versions/other/watch?render=4', '/versions/gone/watch?render=3']);
    const older = screen.getByRole('region', { name: 'Older renders' });
    expect(cardLinks(older)).toEqual(['/versions/mine/watch?render=5', '/versions/other/watch?render=2']);
  });

  test('a render kept from a deleted version counts apart from a newer version that took its id', async () => {
    library({
      'GET /api/library': [
        render({ id: 8 }),
        render({ id: 7, title: 'The first Mine', detached: true }),
        render({ id: 6, title: 'The first Mine', detached: true }),
      ],
    });
    const latest = await screen.findByRole('region', { name: 'Latest renders' });
    expect(cardLinks(latest)).toEqual(['/versions/mine/watch?render=8', '/versions/mine/watch?render=7']);
    expect(within(latest).getByRole('heading', { name: 'The first Mine' })).toBeInTheDocument();
    expect(cardLinks(screen.getByRole('region', { name: 'Older renders' }))).toEqual(['/versions/mine/watch?render=6']);
  });

  test('a card shows the poster, title, logline and date', async () => {
    library();
    const latest = await screen.findByRole('region', { name: 'Latest renders' });
    const card = within(latest).getAllByRole('article')[0]!;
    expect(within(card).getByRole('heading', { name: 'Mine' })).toBeInTheDocument();
    expect(within(card).getByText('A bake-off, doomed.')).toBeInTheDocument();
    expect(within(card).getByText(new Date(WHEN + 6 * 86_400_000).toLocaleDateString(), { exact: false })).toBeInTheDocument();
    expect(card.querySelector('img')).toHaveAttribute('src', '/library/r-6.jpg');
    // no poster: a placeholder rather than a broken image
    const noPoster = within(latest).getAllByRole('article')[1]!;
    expect(noPoster.querySelector('img')).toBeNull();
    // a render whose version is gone keeps its stored title
    expect(within(latest).getByRole('heading', { name: 'The Gone One' })).toBeInTheDocument();
  });

  test('with nothing rendered it says how to get something here', async () => {
    library({ 'GET /api/library': [] });
    expect(await screen.findByText(/Nothing rendered yet/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Older renders' })).toBeNull();
  });

  test('delete asks for confirmation first; Cancel deletes nothing', async () => {
    const { fetchMock } = library();
    const latest = await screen.findByRole('region', { name: 'Latest renders' });
    fireEvent.click(within(latest).getAllByRole('button', { name: /Delete/ })[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/Delete this render of “Mine”\?/);
    expect(dialog).toHaveTextContent(/video file is removed/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(fetchMock).filter(c => c.startsWith('DELETE'))).toEqual([]);
  });

  test('confirming deletes that render, with the button off while it is in flight', async () => {
    let finish!: (v: unknown) => void;
    const { fetchMock } = library({ 'DELETE /api/library/5': () => new Promise(r => (finish = r)) });
    const older = await screen.findByRole('region', { name: 'Older renders' });
    fireEvent.click(within(older).getAllByRole('button', { name: /Delete/ })[0]!);
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete render' });
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(calls(fetchMock).filter(c => c.startsWith('DELETE'))).toEqual(['DELETE /api/library/5']);
    // a second click while in flight sends nothing more
    fireEvent.click(confirm);
    expect(calls(fetchMock).filter(c => c.startsWith('DELETE'))).toHaveLength(1);

    finish({ ok: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // the library is read again
    await waitFor(() => expect(calls(fetchMock).filter(c => c === 'GET /api/library')).toHaveLength(2));
  });

  test('a failed delete keeps the dialog open with the reason', async () => {
    library({ 'DELETE /api/library/6': new Response(JSON.stringify({ error: 'no such render' }), { status: 404 }) });
    const latest = await screen.findByRole('region', { name: 'Latest renders' });
    fireEvent.click(within(latest).getAllByRole('button', { name: /Delete/ })[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete render' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't delete it: no such render");
    expect(within(dialog).getByRole('button', { name: 'Delete render' })).toBeEnabled();
  });
});
