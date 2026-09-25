import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { calls } from '../test-utils';
import { manifest, renderInspector } from './inspectorTestUtils';

afterEach(() => vi.unstubAllGlobals());

describe('Inspector', () => {
  test('with no chapter selected it is the storyboard panel', async () => {
    renderInspector();
    expect(await screen.findByRole('heading', { name: 'Storyboard', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Whole storyboard/ })).toBeNull();
  });

  test('"Whole storyboard" drops the chapter from the URL, keeping the playhead', async () => {
    const { router } = renderInspector({ path: '/versions/mine?ch=2&t=30' });
    fireEvent.click(await screen.findByRole('button', { name: /Whole storyboard/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ t: 30 }));
    expect(await screen.findByRole('button', { name: /Approve and build chapters/ })).toBeInTheDocument();
  });

  test('Escape goes back to the whole storyboard too, but not while typing', async () => {
    const { router } = renderInspector({ path: '/versions/mine?ch=2' });
    const feedback = await screen.findByRole('textbox', { name: 'What should change in this chapter?' });
    fireEvent.keyDown(feedback, { key: 'Escape' });
    // a navigation would have landed by now (the positive case below lands within the same wait)
    await new Promise(r => setTimeout(r, 50));
    expect(router.state.location.search).toEqual({ ch: 2 });
    expect(screen.getByRole('heading', { name: /^Chapter 2/, level: 2 })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(await screen.findByRole('heading', { name: 'Storyboard', level: 2 })).toBeInTheDocument();
  });

  test('reads STORYBOARD.md from the version files, once for both panels', async () => {
    const { fetchMock, router } = renderInspector({ path: '/versions/mine?ch=1' });
    await screen.findByTestId('storyboard-markdown');
    await router.navigate({ to: '/versions/$id', params: { id: 'mine' }, search: {} });
    await screen.findByRole('heading', { name: 'Storyboard', level: 2 });
    expect(calls(fetchMock).filter(c => c === 'GET /v/mine/STORYBOARD.md')).toHaveLength(1);
  });

  test("a storyboard that can't be read says so", async () => {
    renderInspector({ answers: { 'GET /v/mine/STORYBOARD.md': new Response('nope', { status: 404 }) } });
    expect(await screen.findByText("Couldn't load the storyboard: not found")).toBeInTheDocument();
  });

  test('an example offers Remix on both panels', async () => {
    renderInspector({ manifest: manifest({ example: true }), path: '/versions/mine?ch=1' });
    expect(await screen.findByRole('button', { name: /Remix/ })).toBeInTheDocument();
    expect(screen.getByText(/This is an example, so it's read-only/)).toBeInTheDocument();
  });
});
