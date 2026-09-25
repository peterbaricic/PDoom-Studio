import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { calls, job } from '../test-utils';
import { STORYBOARD, bodies, manifest, never, renderInspector } from './inspectorTestUtils';

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { __pwned?: boolean }).__pwned;
});

const button = (name: string | RegExp) => screen.findByRole('button', { name });
const approve = () => button(/Approve and build chapters/);

describe('StoryboardPanel', () => {
  test('renders the storyboard as Markdown: headings and tables, no front matter, raw HTML as inert text', async () => {
    const { container } = renderInspector();
    const md = await screen.findByTestId('storyboard-markdown');
    expect(within(md).getByRole('heading', { name: '1 · The Kitchen (0–23)' })).toBeInTheDocument();
    const table = within(md).getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Shot' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: 'oven door' })).toBeInTheDocument();
    expect(md).not.toHaveTextContent('logline:');
    // the <script> and <img onerror> are shown as text, never made into elements or run
    expect(md).toHaveTextContent('<script>window.__pwned = true</script>');
    expect(container.querySelector('script, img')).toBeNull();
    expect((window as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  test('a javascript: link loses its URL, and an image shows only its alt text (nothing is loaded)', async () => {
    const { container } = renderInspector();
    const md = await screen.findByTestId('storyboard-markdown');
    const link = within(md).getByText('the recipe').closest('a')!;
    expect(link.getAttribute('href') ?? '').not.toMatch(/javascript:/i);
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.querySelector('img')).toBeNull();
    expect(md).toHaveTextContent('[a cat in an apron]');
    expect(container.innerHTML).not.toContain('example.com');
  });

  test('in "storyboard to review": Edit, Ask for changes, a prominent Approve, the concept with Redraft, the options', async () => {
    renderInspector();
    expect(await approve()).toBeEnabled();
    expect(await approve()).toHaveAttribute('data-prominent');
    expect(screen.getByRole('button', { name: /Edit text/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'What should change in the storyboard?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask for changes' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('A baking show.');
    expect(screen.getByRole('button', { name: 'Redraft storyboard' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Brush wipes between chapters' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Corner P(doom) meter' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Claude model' })).toHaveValue('');
    expect(screen.queryByRole('button', { name: /Remix/ })).toBeNull();
  });

  test('past review, Approve is disabled and not prominent', async () => {
    renderInspector({ manifest: manifest({ status: 'chapters' }) });
    expect(await approve()).toBeDisabled();
    expect(await approve()).not.toHaveAttribute('data-prominent');
  });

  test('a storyboard with problems lists them, and Approve waits for them to be fixed', async () => {
    renderInspector({ manifest: manifest({ storyboardErrors: ['expected 9 chapters, found 3'] }) });
    expect(await approve()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('expected 9 chapters, found 3');
    expect(screen.getByText("Fix the storyboard's problems first")).toBeInTheDocument();
  });

  test('a concept without a storyboard shows Claude writing it, and asks for no storyboard text', async () => {
    const { fetchMock } = renderInspector({
      manifest: manifest({ status: 'concept', files: [] }),
      jobs: [job({ id: 3, kind: 'storyboard', version_id: 'mine', status: 'running' })],
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Claude is writing the storyboard…');
    expect(screen.getByRole('button', { name: 'Redraft storyboard' })).toBeDisabled();
    expect(await approve()).toBeDisabled();
    expect(calls(fetchMock)).not.toContain('GET /v/mine/STORYBOARD.md');
  });

  test('Edit text saves the storyboard as written, and Save is off while it saves', async () => {
    const { fetchMock } = renderInspector({ answers: { 'PUT /api/versions/mine/files/STORYBOARD.md': never } });
    await screen.findByTestId('storyboard-markdown');
    fireEvent.click(await button(/Edit text/));
    const editor = screen.getByRole('textbox', { name: 'Storyboard text' });
    expect((editor as HTMLTextAreaElement).value).toContain('## 2 · The Tent (23–38.5)');
    fireEvent.change(editor, { target: { value: 'new text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    // the revision the edit started from, so the server can refuse it if the storyboard moved on meanwhile
    expect(bodies(fetchMock, 'PUT /api/versions/mine/files/STORYBOARD.md')).toEqual([{ content: 'new text', baseRevision: 2 }]);
  });

  test('a storyboard that changes while you edit (read again after a version event) blocks Save until you choose', async () => {
    let served = STORYBOARD;
    const { fetchMock, queryClient } = renderInspector({
      answers: {
        'GET /v/mine/STORYBOARD.md': () => new Response(served),
        'PUT /api/versions/mine/files/STORYBOARD.md': { revision: 9, errors: [] },
      },
    });
    await screen.findByTestId('storyboard-markdown');
    fireEvent.click(await button(/Edit text/));
    fireEvent.change(screen.getByRole('textbox', { name: 'Storyboard text' }), { target: { value: 'my edit' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    served = `${STORYBOARD}\nClaude's new ending.\n`;
    await act(() => queryClient.invalidateQueries({ queryKey: ['version', 'mine'] }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The storyboard changed while you were editing');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Storyboard text' })).toHaveValue('my edit'); // nothing lost yet

    // Keep editing: the edit now starts from the new text, and Save replaces it deliberately
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies(fetchMock, 'PUT /api/versions/mine/files/STORYBOARD.md')).toHaveLength(1));
  });

  test('Reload discards the edit and shows the storyboard as it is now', async () => {
    let served = STORYBOARD;
    const { queryClient } = renderInspector({ answers: { 'GET /v/mine/STORYBOARD.md': () => new Response(served) } });
    await screen.findByTestId('storyboard-markdown');
    fireEvent.click(await button(/Edit text/));
    served = '## 1 · Rewritten by Claude (0–23)\n';
    await act(() => queryClient.invalidateQueries({ queryKey: ['version', 'mine'] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload' }));
    expect(screen.queryByRole('textbox', { name: 'Storyboard text' })).toBeNull();
    expect(await screen.findByRole('heading', { name: '1 · Rewritten by Claude (0–23)' })).toBeInTheDocument();
  });

  test('a save the server refuses (the storyboard moved on) shows the same choice, and Save stays blocked', async () => {
    renderInspector({
      answers: {
        'PUT /api/versions/mine/files/STORYBOARD.md': new Response(
          JSON.stringify({ error: 'the storyboard changed since you started editing it — reload it to see the new text' }),
          { status: 409 },
        ),
      },
    });
    await screen.findByTestId('storyboard-markdown');
    fireEvent.click(await button(/Edit text/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The storyboard changed while you were editing');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Storyboard text' })).toBeInTheDocument();
  });

  test('Edit text waits while a storyboard job is queued or running', async () => {
    renderInspector({ jobs: [job({ id: 3, kind: 'storyboard', version_id: 'mine', status: 'running' })] });
    await screen.findByTestId('storyboard-markdown');
    expect(await button(/Edit text/)).toBeDisabled();
  });

  test('Approve waits while an edit is open', async () => {
    renderInspector();
    await screen.findByTestId('storyboard-markdown');
    expect(await approve()).toBeEnabled();
    fireEvent.click(await button(/Edit text/));
    expect(await approve()).toBeDisabled();
    expect(screen.getByText('Save or cancel your edit first')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await approve()).toBeEnabled();
  });

  test.each(['shared', 'chapter'] as const)('Approve waits, saying why, while a %s job of this version is active', async kind => {
    renderInspector({ jobs: [job({ id: 5, kind, version_id: 'mine', status: 'running', params: kind === 'chapter' ? { chapter: 1 } : {} })] });
    expect(await approve()).toBeDisabled();
    expect(screen.getByText(`Wait for the ${kind} job that is running`)).toBeInTheDocument();
  });

  test('a saved edit closes the editor', async () => {
    renderInspector({ answers: { 'PUT /api/versions/mine/files/STORYBOARD.md': { revision: 5, errors: [] } } });
    await screen.findByTestId('storyboard-markdown');
    fireEvent.click(await button(/Edit text/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Storyboard text' })).toBeNull());
    expect(await screen.findByTestId('storyboard-markdown')).toBeInTheDocument();
  });

  test('Ask for changes queues a storyboard job with the feedback and model, and is off while it sends', async () => {
    const { fetchMock } = renderInspector({ answers: { 'POST /api/jobs': never } });
    const ask = await button('Ask for changes');
    expect(ask).toBeDisabled(); // nothing asked yet
    fireEvent.change(screen.getByRole('textbox', { name: 'What should change in the storyboard?' }), { target: { value: ' set it in a food truck ' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Claude model' }), { target: { value: 'opus' } });
    fireEvent.click(ask);
    await waitFor(() => expect(ask).toBeDisabled());
    expect(bodies(fetchMock, 'POST /api/jobs')).toEqual([
      { kind: 'storyboard', versionId: 'mine', params: { feedback: 'set it in a food truck' }, model: 'opus' },
    ]);
  });

  test('Approve approves with the model, and is off while it sends', async () => {
    const { fetchMock } = renderInspector({ answers: { 'POST /api/versions/mine/approve': never } });
    fireEvent.click(await approve());
    await waitFor(async () => expect(await approve()).toBeDisabled());
    expect(bodies(fetchMock, 'POST /api/versions/mine/approve')).toEqual([{ model: null }]);
  });

  test('Redraft saves an edited concept, then queues a storyboard job, and is off meanwhile', async () => {
    const { fetchMock } = renderInspector({ answers: { 'PUT /api/versions/mine': { id: 'mine' }, 'POST /api/jobs': never } });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Concept' }), { target: { value: 'A baking show on the moon.' } });
    const redraft = screen.getByRole('button', { name: 'Redraft storyboard' });
    fireEvent.click(redraft);
    await waitFor(() => expect(calls(fetchMock)).toContain('POST /api/jobs'));
    expect(redraft).toBeDisabled();
    expect(calls(fetchMock).filter(c => c.startsWith('PUT') || c.startsWith('POST'))).toEqual(['PUT /api/versions/mine', 'POST /api/jobs']);
    expect(bodies(fetchMock, 'PUT /api/versions/mine')).toEqual([{ concept: 'A baking show on the moon.' }]);
    expect(bodies(fetchMock, 'POST /api/jobs')).toEqual([{ kind: 'storyboard', versionId: 'mine', model: null }]);
  });

  test('Redraft with the concept unchanged only queues the job', async () => {
    const { fetchMock } = renderInspector({ answers: { 'POST /api/jobs': never } });
    fireEvent.click(await button('Redraft storyboard'));
    await waitFor(() => expect(calls(fetchMock)).toContain('POST /api/jobs'));
    expect(calls(fetchMock)).not.toContain('PUT /api/versions/mine');
  });

  test('an option toggle saves the options, and the toggles are off while it saves', async () => {
    const { fetchMock } = renderInspector({ answers: { 'PUT /api/versions/mine': never } });
    const wipes = await screen.findByRole('checkbox', { name: 'Brush wipes between chapters' });
    fireEvent.click(wipes);
    await waitFor(() => expect(wipes).toBeDisabled());
    expect(wipes).not.toBeChecked(); // shows what it's saving
    expect(screen.getByRole('checkbox', { name: 'Corner P(doom) meter' })).toBeDisabled();
    expect(bodies(fetchMock, 'PUT /api/versions/mine')).toEqual([{ options: { wipes: false, cornerMeter: true } }]);
  });

  test('while a storyboard job is queued, Ask for changes and Redraft wait for it', async () => {
    renderInspector({ jobs: [job({ id: 3, kind: 'storyboard', version_id: 'mine', status: 'queued' })] });
    expect(await screen.findByRole('status')).toHaveTextContent('Claude is about to write the storyboard…');
    fireEvent.change(screen.getByRole('textbox', { name: 'What should change in the storyboard?' }), { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: 'Ask for changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redraft storyboard' })).toBeDisabled();
  });

  test('with Claude signed out, its actions are off and say why', async () => {
    renderInspector({ health: { claude: true, claudeSignedIn: false, ffmpeg: true } });
    await waitFor(async () => expect(await approve()).toBeDisabled());
    fireEvent.change(screen.getByRole('textbox', { name: 'What should change in the storyboard?' }), { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: 'Ask for changes' })).toBeDisabled();
    const redraft = screen.getByRole('button', { name: 'Redraft storyboard' });
    expect(redraft).toBeDisabled();
    fireEvent.focus(redraft.parentElement!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Claude CLI is signed out');
    // editing by hand doesn't need Claude
    expect(screen.getByRole('button', { name: /Edit text/ })).toBeEnabled();
  });

  test('an example shows the storyboard and concept but no editing controls, and offers Remix', async () => {
    const onRemix = vi.fn();
    renderInspector({ manifest: manifest({ id: 'original', example: true, status: 'ready' }), onRemix });
    await screen.findByTestId('storyboard-markdown');
    for (const name of [/Edit text/, /Approve/, 'Ask for changes', 'Redraft storyboard', 'Save']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('A baking show.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Remix/ }));
    expect(onRemix).toHaveBeenCalled();
  });
});
