import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { LogViewer } from './LogViewer';
import { handleStudioEvent } from '../api/events';
import { job, mockApi, renderInRouter } from '../test-utils';

afterEach(() => vi.unstubAllGlobals());

function renderLog(log = 'line 1\n') {
  mockApi({ 'GET /api/jobs/4': { ...job({ id: 4, status: 'running' }), log } });
  return renderInRouter(<LogViewer jobId={4} onClose={() => {}} />, { path: '/versions/mine' });
}

// jsdom does no layout: give the log's scrolling viewport a fixed size and a content height the test controls.
function fakeLayout(el: HTMLElement, { scrollTop, clientHeight = 100 }: { scrollTop: number; clientHeight?: number }) {
  const layout = { scrollHeight: 1000 };
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => layout.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: scrollTop });
  return layout;
}

describe('LogViewer', () => {
  test("appends live log events for its own job, and ignores other jobs'", async () => {
    const { queryClient } = renderLog();
    const log = await screen.findByText(/line 1/);

    act(() => handleStudioEvent(queryClient, 'log', { id: 4, text: 'line 2\n' }));
    act(() => handleStudioEvent(queryClient, 'log', { id: 5, text: 'someone else\n' }));
    await waitFor(() => expect(log).toHaveTextContent('line 2'));
    expect(log.textContent).toBe('line 1\nline 2\n');
  });

  test('auto-scrolls on new output when you are at the bottom', async () => {
    const { queryClient } = renderLog();
    await screen.findByText(/line 1/);
    const viewport = screen.getByTestId('job-log-viewport');
    const layout = fakeLayout(viewport, { scrollTop: 900 }); // 900 + 100 = 1000: at the bottom
    act(() => viewport.dispatchEvent(new Event('scroll')));

    layout.scrollHeight = 1200;
    act(() => handleStudioEvent(queryClient, 'log', { id: 4, text: 'line 2\n' }));
    await waitFor(() => expect(viewport.scrollTop).toBe(1200));
  });

  test("doesn't move the view when you've scrolled up to read", async () => {
    const { queryClient } = renderLog();
    await screen.findByText(/line 1/);
    const viewport = screen.getByTestId('job-log-viewport');
    const layout = fakeLayout(viewport, { scrollTop: 300 });
    act(() => viewport.dispatchEvent(new Event('scroll')));

    layout.scrollHeight = 1200;
    act(() => handleStudioEvent(queryClient, 'log', { id: 4, text: 'line 2\n' }));
    await screen.findByText(/line 2/);
    expect(viewport.scrollTop).toBe(300);
  });

  test("shows the job's kind and status in its title", async () => {
    renderLog();
    expect(await screen.findByRole('dialog', { name: /chapter · running/ })).toBeInTheDocument();
  });
});
