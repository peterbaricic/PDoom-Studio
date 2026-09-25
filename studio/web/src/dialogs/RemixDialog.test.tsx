import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { calls, mockApi, renderInRouter, version } from '../test-utils';
import { RemixDialog } from './RemixDialog';

afterEach(() => vi.unstubAllGlobals());

const VERSIONS = [version({ id: 'original', title: "I'm Upping My P(doom)", example: true, status: 'ready', chapters: 9 })];

function open(answers: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const fetchMock = mockApi({ 'GET /api/versions': VERSIONS, ...answers });
  const utils = renderInRouter(<RemixDialog versionId="original" open onClose={onClose} />, { path: '/versions/original' });
  return { ...utils, fetchMock, onClose };
}

const id = () => screen.getByRole('textbox', { name: 'Id' });
const remix = () => screen.getByRole('button', { name: 'Remix' });

describe('RemixDialog', () => {
  test('offers a title and id for the copy, from the version remixed', async () => {
    open();
    expect(await screen.findByRole('heading', { name: "Remix “I'm Upping My P(doom)”" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue("I'm Upping My P(doom) (remix)"));
    expect(id()).toHaveValue('i-m-upping-my-p-doom-remix');
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'My Doom' } });
    expect(id()).toHaveValue('my-doom');
  });

  test('remixes, then goes to the new version', async () => {
    const { fetchMock, onClose, router } = open({ 'POST /api/versions/original/remix': version({ id: 'my-doom', title: 'My Doom' }) });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'My Doom' } });
    fireEvent.click(remix());
    await waitFor(() => expect(router.state.location.pathname).toBe('/versions/my-doom'));
    const call = fetchMock.mock.calls.find(([path]) => path === '/api/versions/original/remix')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ id: 'my-doom', title: 'My Doom' });
    expect(onClose).toHaveBeenCalled();
  });

  test('an id that is taken (409) is said so in the dialog, which stays open for another id', async () => {
    let answer = new Response(JSON.stringify({ error: 'version id already exists: my-doom' }), { status: 409 });
    const { fetchMock, onClose, router } = open({ 'POST /api/versions/original/remix': () => answer });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'My Doom' } });
    fireEvent.click(remix());
    expect(await screen.findByRole('alert')).toHaveTextContent('There is already a version with the id “my-doom”. Pick another id.');
    expect(id()).toHaveAttribute('aria-invalid', 'true');
    expect(router.state.location.pathname).toBe('/versions/original');
    expect(onClose).not.toHaveBeenCalled();

    // editing the id clears the error; the next try goes through
    fireEvent.change(id(), { target: { value: 'my-doom-2' } });
    expect(screen.queryByRole('alert')).toBeNull();
    answer = new Response(JSON.stringify(version({ id: 'my-doom-2' })), { status: 201 });
    fireEvent.click(remix());
    await waitFor(() => expect(router.state.location.pathname).toBe('/versions/my-doom-2'));
    expect(calls(fetchMock).filter(c => c.startsWith('POST'))).toHaveLength(2);
  });

  test('other failures show the server\'s reason', async () => {
    open({ 'POST /api/versions/original/remix': new Response(JSON.stringify({ error: 'bad version id: x' }), { status: 400 }) });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'My Doom' } });
    fireEvent.click(remix());
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't remix it: bad version id: x");
  });
});
