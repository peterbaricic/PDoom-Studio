import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { JobsIndicator } from './JobsIndicator';
import { JobLogProvider } from './LogViewer';
import { job, mockApi, renderInRouter } from '../test-utils';

afterEach(() => vi.unstubAllGlobals());

const jobs = [
  job({ id: 7, status: 'running' }),
  job({ id: 6, status: 'queued' }),
  job({ id: 5, status: 'running', version_id: 'other' }),
  job({ id: 4, status: 'queued', version_id: 'other' }),
  job({ id: 3, status: 'queued' }),
  job({ id: 2, status: 'done' }),
  job({ id: 1, status: 'failed' }),
];

test('counts running and queued jobs across every version', async () => {
  mockApi({ 'GET /api/jobs': jobs });
  renderInRouter(<JobsIndicator />, { path: '/versions/mine' });
  expect(await screen.findByRole('button', { name: 'Jobs: 2 running · 3 queued' })).toBeInTheDocument();
});

test('opens the jobs drawer', async () => {
  mockApi({ 'GET /api/jobs': jobs, 'GET /api/jobs?version=mine': jobs.filter(j => j.version_id === 'mine') });
  renderInRouter(
    <JobLogProvider>
      <JobsIndicator />
    </JobLogProvider>,
    { path: '/versions/mine' },
  );
  fireEvent.click(await screen.findByRole('button', { name: /^Jobs:/ }));
  expect(await screen.findByRole('dialog', { name: 'Jobs' })).toBeInTheDocument();
});
