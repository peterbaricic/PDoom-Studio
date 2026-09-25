import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Job, Render } from '@/api/types';
import { calls, job, mockApi, newQueryClient, renderInRouter, version } from '../test-utils';
import { DeleteVersionDialog } from './DeleteVersionDialog';

afterEach(() => vi.unstubAllGlobals());

const VERSIONS = [version({ id: 'mine', title: 'Bake-Off', status: 'ready', chapters: 9 }), version({ id: 'other', title: 'Other' })];
const render = (id: number, versionId = 'mine'): Render => ({
  id, version_id: versionId, file: `r${id}.mp4`, revision_ids: [], snapshot_id: null, title: 'Bake-Off', logline: '', duration_s: 1,
  render_s: 1, size_bytes: 1, poster: null, created_at: id,
});

function open({ jobs = [] as Job[], path = '/versions/mine', answers = {} as Record<string, unknown> } = {}) {
  const onClose = vi.fn();
  const fetchMock = mockApi({
    'GET /api/versions': VERSIONS,
    'GET /api/jobs?version=mine': jobs,
    'GET /api/library': [render(1), render(2), render(3, 'other')],
    ...answers,
  });
  const queryClient = newQueryClient();
  const utils = renderInRouter(<DeleteVersionDialog versionId="mine" open onClose={onClose} />, { path, queryClient });
  return { ...utils, fetchMock, onClose, queryClient };
}

const confirmBox = () => screen.getByRole('textbox', { name: /Type “Bake-Off” to confirm/ });
const del = () => screen.getByRole('button', { name: 'Delete version' });
const videos = () => screen.getByRole('checkbox', { name: /Also delete its finished videos/ });

describe('DeleteVersionDialog', () => {
  test('asks for the version title to be typed before it deletes anything', async () => {
    const { fetchMock } = open();
    expect(await screen.findByRole('heading', { name: 'Delete “Bake-Off”?' })).toBeInTheDocument();
    await waitFor(() => expect(confirmBox()).toBeEnabled());
    expect(del()).toBeDisabled();
    fireEvent.change(confirmBox(), { target: { value: 'bake-off' } });
    expect(del()).toBeDisabled();
    fireEvent.change(confirmBox(), { target: { value: 'Bake-Off' } });
    expect(del()).toBeEnabled();
    expect(calls(fetchMock)).not.toContain('DELETE /api/versions/mine?videos=0');
  });

  test('keeps the videos by default, and says they stay in the library', async () => {
    const { fetchMock, onClose } = open({ answers: { 'DELETE /api/versions/mine?videos=0': { ok: true } } });
    await screen.findByRole('heading', { name: 'Delete “Bake-Off”?' });
    expect(videos()).not.toBeChecked();
    expect(await screen.findByText(/Its 2 videos stay in the library/)).toBeInTheDocument();
    fireEvent.change(confirmBox(), { target: { value: 'Bake-Off' } });
    fireEvent.click(del());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls(fetchMock)).toContain('DELETE /api/versions/mine?videos=0');
  });

  test('with the box ticked, the videos go too', async () => {
    const { fetchMock, onClose } = open({ answers: { 'DELETE /api/versions/mine?videos=1': { ok: true } } });
    await screen.findByRole('heading', { name: 'Delete “Bake-Off”?' });
    fireEvent.click(videos());
    expect(videos()).toBeChecked();
    expect(screen.getByText(/Its 2 videos are deleted from the library too/)).toBeInTheDocument();
    fireEvent.change(confirmBox(), { target: { value: 'Bake-Off' } });
    fireEvent.click(del());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls(fetchMock)).toContain('DELETE /api/versions/mine?videos=1');
  });

  test('deleting the version on screen leaves it, and nothing keeps asking about it', async () => {
    let deleted = false;
    const onClose = vi.fn();
    const fetchMock = mockApi({
      'GET /api/versions': () => (deleted ? VERSIONS.filter(v => v.id !== 'mine') : VERSIONS),
      'GET /api/jobs?version=mine': [],
      'GET /api/library': [render(1)],
      'DELETE /api/versions/mine?videos=0': () => ((deleted = true), { ok: true }),
    });
    const queryClient = newQueryClient();
    // as the app keeps it: mounted, and closed by onClose
    function Harness() {
      const [open, setOpen] = useState(true);
      return <DeleteVersionDialog versionId="mine" open={open} onClose={() => (onClose(), setOpen(false))} />;
    }
    const { router } = renderInRouter(<Harness />, { path: '/versions/mine', queryClient });
    // what the workspace had asked about it
    queryClient.setQueryData(['version', 'mine'], { id: 'mine' });
    queryClient.setQueryData(['version', 'mine', 'storyboard'], '# Bake-Off');
    queryClient.setQueryData(['coverage', 'mine'], { total: 1, ranges: [], broken: [], segments: {} });
    queryClient.setQueryData(['version', 'other'], { id: 'other' });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await screen.findByRole('heading', { name: 'Delete “Bake-Off”?' });
    await waitFor(() => expect(confirmBox()).toBeEnabled());
    fireEvent.change(confirmBox(), { target: { value: 'Bake-Off' } });
    await waitFor(() => expect(del()).toBeEnabled());
    fireEvent.click(del());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    await waitFor(() => expect(queryClient.getQueryData(['version', 'mine'])).toBeUndefined());
    for (const key of [['version', 'mine', 'storyboard'], ['coverage', 'mine'], ['jobs', { version: 'mine' }]]) {
      expect(queryClient.getQueryData(key), JSON.stringify(key)).toBeUndefined();
    }
    expect(queryClient.getQueryData(['version', 'other'])).toEqual({ id: 'other' });
    const invalidated = invalidate.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
    for (const key of [['versions'], ['renders'], ['jobs']]) expect(invalidated).toContain(JSON.stringify(key));
    // after the delete, only the lists are asked for again: nothing about the version itself
    await new Promise(r => setTimeout(r, 50));
    const after = calls(fetchMock).slice(calls(fetchMock).indexOf('DELETE /api/versions/mine?videos=0') + 1);
    expect(after).toContain('GET /api/versions');
    expect(after.filter(c => c.includes('mine'))).toEqual([]);
  });

  test('deleting a version from elsewhere stays where it is', async () => {
    const { onClose, router } = open({ path: '/library', answers: { 'DELETE /api/versions/mine?videos=0': { ok: true } } });
    await screen.findByRole('heading', { name: 'Delete “Bake-Off”?' });
    fireEvent.change(confirmBox(), { target: { value: 'Bake-Off' } });
    fireEvent.click(del());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(router.state.location.pathname).toBe('/library');
  });

  test('is off while a job of the version is queued or running', async () => {
    open({ jobs: [job({ id: 5, kind: 'render', status: 'running', version_id: 'mine' })] });
    expect(await screen.findByText(/a render job for this version is still running/)).toBeInTheDocument();
    fireEvent.change(confirmBox(), { target: { value: 'Bake-Off' } });
    expect(del()).toBeDisabled();
  });

  test('a refusal stays in the dialog with the reason', async () => {
    const { onClose, router } = open({
      answers: { 'DELETE /api/versions/mine?videos=0': new Response(JSON.stringify({ error: 'a chapter job for this version is still queued' }), { status: 409 }) },
    });
    await screen.findByRole('heading', { name: 'Delete “Bake-Off”?' });
    fireEvent.change(confirmBox(), { target: { value: 'Bake-Off' } });
    fireEvent.click(del());
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't delete it: a chapter job for this version is still queued");
    expect(onClose).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/versions/mine');
  });
});
