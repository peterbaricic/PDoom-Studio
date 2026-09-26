import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { JobsDrawer } from './JobsDrawer';
import { JobLogProvider } from './LogViewer';
import { calls, job, mockApi, renderInRouter } from '../test-utils';
import type { JobStatus } from '../api/types';

afterEach(() => vi.unstubAllGlobals());

const mineJobs = [
  job({ id: 3, kind: 'chapter', params: { chapter: 4 }, status: 'running', progress: 0.5, started_at: 1_000, cost_usd: 0.42 }),
  job({ id: 9, kind: 'render', status: 'queued' }),
  job({ id: 1, kind: 'storyboard', status: 'done', started_at: 1_000, finished_at: 66_000 }),
];
const otherJobs = [job({ id: 5, kind: 'thumbs', version_id: 'other', status: 'failed' })];

function renderDrawer(path = '/versions/mine') {
  return renderInRouter(
    <JobLogProvider>
      <JobsDrawer open onOpenChange={() => {}} />
    </JobLogProvider>,
    { path },
  );
}

// The job list's requests (the drawer also reads /api/health, for whether Claude's jobs can be retried).
const jobCalls = (fetchMock: ReturnType<typeof mockApi>) => calls(fetchMock).filter(c => c.startsWith('GET /api/jobs'));

// Each job row is a listitem whose accessible content starts with the job's kind.
const rows = async () => within(await screen.findByRole('list', { name: 'Jobs' })).findAllByRole('listitem');

describe('JobsDrawer', () => {
  test("lists this version's jobs newest first", async () => {
    const fetchMock = mockApi({ 'GET /api/jobs?version=mine': mineJobs });
    renderDrawer();
    const items = await rows();
    expect(items.map(r => r.dataset.jobId)).toEqual(['9', '3', '1']);
    expect(items[1]).toHaveTextContent('chapter 4');
    expect(items[1]).toHaveTextContent('running');
    expect(items[1]).toHaveTextContent('$0.42');
    expect(items[2]).toHaveTextContent('1:05'); // 65 s from start to finish
    expect(jobCalls(fetchMock)).toEqual(['GET /api/jobs?version=mine']);
  });

  test('filters to every version, and back', async () => {
    const fetchMock = mockApi({ 'GET /api/jobs?version=mine': mineJobs, 'GET /api/jobs': [...mineJobs, ...otherJobs] });
    renderDrawer();
    expect(await rows()).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'All versions' }));
    await waitFor(async () => expect(await rows()).toHaveLength(4));
    expect((await rows()).map(r => r.dataset.jobId)).toEqual(['9', '5', '3', '1']);
    // Rows name their version once every version is listed.
    expect((await rows())[1]).toHaveTextContent('other');
    expect(screen.getByRole('button', { name: 'All versions' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'This version' }));
    await waitFor(async () => expect(await rows()).toHaveLength(3));
    expect(jobCalls(fetchMock)).toEqual(['GET /api/jobs?version=mine', 'GET /api/jobs']);
  });

  test('lists every version when no version is selected', async () => {
    mockApi({ 'GET /api/jobs': otherJobs });
    renderDrawer('/library');
    expect(await rows()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'This version' })).toBeDisabled();
  });

  test('offers Cancel only for queued or running jobs, and Retry only for failed, cancelled or interrupted ones', async () => {
    const statuses: JobStatus[] = ['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted'];
    mockApi({ 'GET /api/jobs?version=mine': statuses.map((status, i) => job({ id: 10 - i, status })) });
    renderDrawer();
    const items = await rows();
    const buttons = (row: HTMLElement) => within(row).queryAllByRole('button').map(b => b.textContent);
    expect(Object.fromEntries(items.map(r => [r.dataset.status, buttons(r)]))).toEqual({
      queued: ['Log', 'Cancel'],
      running: ['Log', 'Cancel'],
      done: ['Log'],
      failed: ['Log', 'Retry'],
      cancelled: ['Log', 'Retry'],
      interrupted: ['Log', 'Retry'],
    });
  });

  test('Cancel and Retry call the API, then refresh the list', async () => {
    const fetchMock = mockApi({
      'GET /api/jobs?version=mine': [job({ id: 2, status: 'running' }), job({ id: 1, status: 'failed' })],
      'POST /api/jobs/2/cancel': { ok: true },
      'POST /api/jobs/1/retry': { id: 3 },
    });
    renderDrawer();
    const [running, failed] = await rows();
    fireEvent.click(within(running!).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(calls(fetchMock)).toContain('POST /api/jobs/2/cancel'));
    fireEvent.click(within(failed!).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls(fetchMock)).toContain('POST /api/jobs/1/retry'));
    await waitFor(() => expect(calls(fetchMock).filter(c => c === 'GET /api/jobs?version=mine').length).toBeGreaterThanOrEqual(3));
  });

  test('each job stays busy until its own request settles, whatever else is clicked meanwhile', async () => {
    const never = () => new Promise(() => {});
    mockApi({
      'GET /api/jobs?version=mine': [job({ id: 2, status: 'running' }), job({ id: 1, status: 'queued' })],
      'POST /api/jobs/2/cancel': never,
      'POST /api/jobs/1/cancel': never,
    });
    renderDrawer();
    const [a, b] = await rows();
    fireEvent.click(within(a!).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(within(a!).getByRole('button', { name: 'Cancel' })).toBeDisabled());
    fireEvent.click(within(b!).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(within(b!).getByRole('button', { name: 'Cancel' })).toBeDisabled());
    expect(within(a!).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  test('with Claude signed out, Retry is off for Claude\'s jobs and says why, and stays on for the others', async () => {
    const fetchMock = mockApi({
      'GET /api/jobs?version=mine': [
        job({ id: 4, kind: 'storyboard', status: 'failed' }),
        job({ id: 3, kind: 'shared', status: 'interrupted' }),
        job({ id: 2, kind: 'chapter', params: { chapter: 2 }, status: 'cancelled' }),
        job({ id: 1, kind: 'thumbs', status: 'failed' }),
      ],
      'GET /api/health': { claude: true, claudeSignedIn: false, ffmpeg: true, painter: { ok: true, reason: null } },
      'POST /api/jobs/1/retry': { id: 5 },
    });
    renderDrawer();
    const items = await rows();
    const retry = (row: HTMLElement) => within(row).getByRole('button', { name: 'Retry' });
    await waitFor(() => expect(retry(items[0]!)).toBeDisabled());
    expect(retry(items[1]!)).toBeDisabled();
    expect(retry(items[2]!)).toBeDisabled();
    expect(retry(items[3]!)).toBeEnabled();
    fireEvent.focus(retry(items[2]!).parentElement!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Claude CLI is signed out');
    fireEvent.click(retry(items[3]!));
    await waitFor(() => expect(calls(fetchMock)).toContain('POST /api/jobs/1/retry'));
  });

  test('Log opens the log viewer on that job', async () => {
    mockApi({
      'GET /api/jobs?version=mine': [job({ id: 2, status: 'running' })],
      'GET /api/jobs/2': { ...job({ id: 2, status: 'running' }), log: 'painting chapter 4…\n' },
    });
    renderDrawer();
    const [row] = await rows();
    fireEvent.click(within(row!).getByRole('button', { name: 'Log' }));
    expect(await screen.findByText(/painting chapter 4…/)).toBeInTheDocument();
  });
});
