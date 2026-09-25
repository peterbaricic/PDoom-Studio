import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Health } from '@/api/types';
import { calls, mockApi, renderInRouter, version } from '../test-utils';
import { NewVersionDialog } from './NewVersionDialog';

afterEach(() => vi.unstubAllGlobals());

const HEALTHY: Health = { claude: true, claudeSignedIn: true, ffmpeg: true };

function open(answers: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const fetchMock = mockApi({ 'GET /api/health': HEALTHY, 'GET /api/versions': [], ...answers });
  const utils = renderInRouter(<NewVersionDialog open onClose={onClose} />, { path: '/versions/original' });
  return { ...utils, fetchMock, onClose };
}

const title = () => screen.getByRole('textbox', { name: 'Title' });
const id = () => screen.getByRole('textbox', { name: 'Id' });
const concept = () => screen.getByRole('textbox', { name: 'Concept' });
const draft = () => screen.getByRole('button', { name: 'Draft storyboard' });
const bodyOf = (fetchMock: ReturnType<typeof mockApi>, key: string) => {
  const call = fetchMock.mock.calls.find(([path, init]) => `${init?.method ?? 'GET'} ${path}` === key);
  return call && JSON.parse(String(call[1]?.body));
};

describe('NewVersionDialog', () => {
  test('derives the id from the title until the id is edited by hand', async () => {
    open();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'The P(doom) Bake-Off' } });
    expect(id()).toHaveValue('the-p-doom-bake-off');
    fireEvent.change(id(), { target: { value: 'bake-off' } });
    fireEvent.change(title(), { target: { value: 'The Great P(doom) Bake-Off' } });
    expect(id()).toHaveValue('bake-off');
  });

  test('needs a title, a concept and a valid id', async () => {
    open();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'Bake-Off' } });
    expect(draft()).toBeDisabled();
    fireEvent.change(concept(), { target: { value: 'A baking show.' } });
    await waitFor(() => expect(draft()).toBeEnabled());
    fireEvent.change(id(), { target: { value: 'Bake Off' } });
    expect(draft()).toBeDisabled();
    expect(screen.getByText(/lowercase letters, digits and hyphens/)).toBeInTheDocument();
  });

  test('creates the version and queues the storyboard job, then goes to the new version', async () => {
    const { fetchMock, onClose, router } = open({
      'POST /api/versions': version({ id: 'bake-off', title: 'Bake-Off' }),
      'POST /api/jobs': { id: 12 },
    });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'Bake-Off' } });
    fireEvent.change(concept(), { target: { value: 'A baking show.' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Claude model' }), { target: { value: 'sonnet' } });
    await waitFor(() => expect(draft()).toBeEnabled());
    fireEvent.click(draft());

    await waitFor(() => expect(router.state.location.pathname).toBe('/versions/bake-off'));
    expect(calls(fetchMock).filter(c => !c.startsWith('GET'))).toEqual(['POST /api/versions', 'POST /api/jobs']);
    expect(bodyOf(fetchMock, 'POST /api/versions')).toEqual({ id: 'bake-off', title: 'Bake-Off', concept: 'A baking show.' });
    expect(bodyOf(fetchMock, 'POST /api/jobs')).toEqual({ kind: 'storyboard', versionId: 'bake-off', model: 'sonnet' });
    expect(onClose).toHaveBeenCalled();
  });

  test('an id that is taken is said so in the dialog, and nothing is queued', async () => {
    const { fetchMock, onClose, router } = open({
      'POST /api/versions': new Response(JSON.stringify({ error: 'version id already exists: bake-off' }), { status: 400 }),
    });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'Bake-Off' } });
    fireEvent.change(concept(), { target: { value: 'A baking show.' } });
    await waitFor(() => expect(draft()).toBeEnabled());
    fireEvent.click(draft());
    expect(await screen.findByRole('alert')).toHaveTextContent('version id already exists: bake-off');
    expect(calls(fetchMock)).not.toContain('POST /api/jobs');
    expect(router.state.location.pathname).toBe('/versions/original');
    expect(onClose).not.toHaveBeenCalled();
    expect(draft()).toBeEnabled();
  });

  test('if the storyboard job cannot be queued, the new version still opens and says so', async () => {
    const { onClose, router } = open({
      'POST /api/versions': version({ id: 'bake-off', title: 'Bake-Off' }),
      'POST /api/jobs': new Response(JSON.stringify({ error: 'the queue is gone' }), { status: 500 }),
    });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'Bake-Off' } });
    fireEvent.change(concept(), { target: { value: 'A baking show.' } });
    await waitFor(() => expect(draft()).toBeEnabled());
    fireEvent.click(draft());
    await waitFor(() => expect(router.state.location.pathname).toBe('/versions/bake-off'));
    expect(onClose).toHaveBeenCalled();
  });

  test('with Claude signed out, Draft storyboard is off and says why', async () => {
    open({ 'GET /api/health': { claude: true, claudeSignedIn: false, ffmpeg: true } });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'Bake-Off' } });
    fireEvent.change(concept(), { target: { value: 'A baking show.' } });
    await waitFor(() => expect(draft().parentElement).toHaveAttribute('tabindex', '0'));
    expect(draft()).toBeDisabled();
    fireEvent.focus(draft().parentElement!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Claude CLI is signed out');
  });
});
