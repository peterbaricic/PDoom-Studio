import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Job, Render } from '@/api/types';
import { calls, job, mockApi, renderInRouter } from '../test-utils';
import { RenderBar } from './RenderBar';

afterEach(() => vi.unstubAllGlobals());

const render = (overrides: Partial<Render> & Pick<Render, 'id'>): Render => ({
  version_id: 'mine',
  file: `mine-${overrides.id}.mp4`,
  revision_ids: [],
  snapshot_id: null,
  title: 'Mine',
  logline: '',
  duration_s: 156.6,
  render_s: 300,
  size_bytes: 1,
  poster: null,
  created_at: Date.UTC(2026, 8, 20, 12, 0),
  detached: false,
  ...overrides,
});

function renderBar(opts: { chapters?: number; jobs?: Job[]; renders?: Render[]; answers?: Record<string, unknown> } = {}) {
  // chapters: undefined (given as such) means still loading
  const { jobs = [], renders = [], answers = {} } = opts;
  const chapters = 'chapters' in opts ? opts.chapters : 9;
  const fetchMock = mockApi({ 'GET /api/library': renders, ...answers });
  const utils = renderInRouter(<RenderBar versionId="mine" chapters={chapters} jobs={jobs} />, { path: '/versions/mine' });
  return { ...utils, fetchMock };
}

const button = () => screen.findByRole('button', { name: /Final render \(1080p MP4\)/ });

describe('RenderBar', () => {
  test('is disabled with the reason "needs all 9 chapters" while fewer are written', async () => {
    renderBar({ chapters: 6 });
    const b = await button();
    expect(b).toBeDisabled();
    expect(b).toHaveAccessibleDescription(/needs all 9 chapters/);
    expect(screen.getByText(/needs all 9 chapters/)).toBeInTheDocument();
  });

  test('while the version is still loading it is disabled, without claiming chapters are missing', async () => {
    renderBar({ chapters: undefined });
    expect(await button()).toBeDisabled();
    expect(screen.queryByText(/needs all 9 chapters/)).toBeNull();
    expect(await button()).not.toHaveAccessibleDescription(/needs/);
  });

  test('is disabled with the reason "a render is running" while one runs, and shows its progress', async () => {
    renderBar({ jobs: [job({ id: 4, kind: 'render', status: 'running', progress: 0.42 })] });
    const b = await button();
    expect(b).toBeDisabled();
    expect(b).toHaveAccessibleDescription(/a render is running/);
    expect(screen.getByText(/42%/)).toBeInTheDocument();
  });

  test('a queued render disables it too', async () => {
    renderBar({ jobs: [job({ id: 4, kind: 'render', status: 'queued' })] });
    expect(await button()).toBeDisabled();
    expect(await button()).toHaveAccessibleDescription(/a render is queued/);
  });

  test('other jobs and finished renders don\'t block it', async () => {
    renderBar({
      jobs: [
        job({ id: 1, kind: 'render', status: 'done' }),
        job({ id: 2, kind: 'render', status: 'failed' }),
        job({ id: 3, kind: 'chapter', params: { chapter: 2 }, status: 'running' }),
      ],
    });
    expect(await button()).toBeEnabled();
  });

  test('queues a render job for this version', async () => {
    const posted: unknown[] = [];
    const { fetchMock } = renderBar({
      answers: {
        'POST /api/jobs': (init: RequestInit) => {
          posted.push(JSON.parse(String(init.body)));
          return { id: 12 };
        },
      },
    });
    fireEvent.click(await button());
    await waitFor(() => expect(posted).toEqual([{ kind: 'render', versionId: 'mine' }]));
    expect(calls(fetchMock)).toContain('POST /api/jobs');
  });

  test('shows the latest render of this version, its date and duration, with Watch', async () => {
    renderBar({
      renders: [
        render({ id: 9, version_id: 'other', created_at: Date.UTC(2026, 8, 24) }),
        render({ id: 7, created_at: Date.UTC(2026, 8, 22, 9, 30), duration_s: 156.6 }),
        render({ id: 3, created_at: Date.UTC(2026, 8, 1) }),
      ],
    });
    const watch = await screen.findByRole('link', { name: 'Watch' });
    expect(watch).toHaveAttribute('href', '/versions/mine/watch?render=7');
    expect(screen.getByText(/2:37/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(new Date(Date.UTC(2026, 8, 22, 9, 30)).toLocaleDateString()))).toBeInTheDocument();
  });

  test('a render kept from a deleted version with the same id isn\'t this version\'s', async () => {
    renderBar({ renders: [render({ id: 9, detached: true, created_at: Date.UTC(2026, 8, 24) }), render({ id: 7 })] });
    expect(await screen.findByRole('link', { name: 'Watch' })).toHaveAttribute('href', '/versions/mine/watch?render=7');
  });

  test('without a render there is no Watch', async () => {
    renderBar();
    await button();
    await waitFor(() => expect(screen.getByText('Not rendered yet')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Watch' })).toBeNull();
  });
});
