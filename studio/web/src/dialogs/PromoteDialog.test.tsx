import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Job } from '@/api/types';
import { calls, job, mockApi, renderInRouter, version } from '../test-utils';
import { PromoteDialog } from './PromoteDialog';

afterEach(() => vi.unstubAllGlobals());

const VERSIONS = [version({ id: 'mine', title: 'Bake-Off', status: 'ready', chapters: 9 })];

function open(jobs: Job[], answers: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const fetchMock = mockApi({ 'GET /api/versions': VERSIONS, 'GET /api/jobs?version=mine': jobs, ...answers });
  const utils = renderInRouter(<PromoteDialog versionId="mine" open onClose={onClose} />, { path: '/versions/mine' });
  return { ...utils, fetchMock, onClose };
}

const promote = () => screen.getByRole('button', { name: 'Promote' });

describe('PromoteDialog', () => {
  test('explains what promoting does, including committing studio/default.db', async () => {
    open([]);
    expect(await screen.findByRole('heading', { name: 'Promote “Bake-Off” to an example?' })).toBeInTheDocument();
    const text = screen.getByRole('dialog').textContent;
    expect(text).toContain('moves this version into studio/default.db as an example');
    expect(text).toContain('read-only here');
    expect(text).toContain('commit studio/default.db to share it');
  });

  test.each([
    ['queued', 'storyboard'],
    ['running', 'chapter'],
    ['queued', 'shared'],
  ] as const)('is off while a %s %s job is waiting to write to the version', async (status, kind) => {
    open([job({ id: 3, kind, status, version_id: 'mine' }), job({ id: 2, kind: 'render', status: 'running', version_id: 'mine' })]);
    expect(await screen.findByText(new RegExp(`a ${kind} job for this version is still ${status}`))).toBeInTheDocument();
    expect(promote()).toBeDisabled();
  });

  test('a running render or finished Claude jobs don\'t hold it up; promoting closes the dialog', async () => {
    const { fetchMock, onClose } = open(
      [job({ id: 3, kind: 'chapter', status: 'done', version_id: 'mine' }), job({ id: 4, kind: 'render', status: 'running', version_id: 'mine' })],
      { 'POST /api/versions/mine/promote': version({ id: 'mine', example: true }) },
    );
    await waitFor(() => expect(promote()).toBeEnabled());
    fireEvent.click(promote());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls(fetchMock)).toContain('POST /api/versions/mine/promote');
  });

  test('when its jobs can\'t be read, Promote stays off and says why, with Retry', async () => {
    let fail = true;
    const onClose = vi.fn();
    mockApi({
      'GET /api/versions': VERSIONS,
      'GET /api/jobs?version=mine': () => (fail ? new Response(JSON.stringify({ error: 'database is locked' }), { status: 500 }) : []),
    });
    renderInRouter(<PromoteDialog versionId="mine" open onClose={onClose} />, { path: '/versions/mine' });
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't check this version's jobs: database is locked");
    expect(promote()).toBeDisabled();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(promote()).toBeEnabled());
  });

  test('a refusal stays in the dialog with the reason', async () => {
    const { onClose } = open([], {
      'POST /api/versions/mine/promote': new Response(JSON.stringify({ error: 'default.db does not exist' }), { status: 409 }),
    });
    await waitFor(() => expect(promote()).toBeEnabled());
    fireEvent.click(promote());
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't promote it: default.db does not exist");
    expect(onClose).not.toHaveBeenCalled();
  });
});
