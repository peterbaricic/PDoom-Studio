import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Revision } from '@/api/types';
import { calls, job } from '../test-utils';
import { HEALTHY, bodies, manifest, never, renderInspector } from './inspectorTestUtils';

afterEach(() => vi.unstubAllGlobals());

const revision = (id: number, overrides: Partial<Revision> = {}): Revision => ({
  id,
  version_id: 'mine',
  path: 'ch/c02_tent.js',
  job_id: null,
  source: 'claude',
  note: `revision ${id}`,
  sha256: null,
  created_at: Date.UTC(2026, 8, 20, 10, id),
  ...overrides,
});

// Chapter 2 is written, at revision 12 (the newest of three); chapter 3 isn't.
const WRITTEN = manifest({
  status: 'chapters',
  files: ['STORYBOARD.md', 'ch/c01_kitchen.js', 'ch/c02_tent.js'],
  fileRevisions: { 'STORYBOARD.md': 2, 'ch/c01_kitchen.js': 5, 'ch/c02_tent.js': 12 },
});
const HISTORY = [revision(12, { note: 'shorter' }), revision(9, { source: 'restore', note: 'restored revision 7' }), revision(7)];
const REVISIONS = 'GET /api/versions/mine/revisions?path=ch%2Fc02_tent.js';

function renderChapter(opts: Parameters<typeof renderInspector>[0] = {}) {
  return renderInspector({ manifest: WRITTEN, path: '/versions/mine?ch=2&t=23', ...opts, answers: { [REVISIONS]: HISTORY, ...opts.answers } });
}

const revise = () => screen.findByRole('button', { name: 'Revise chapter' });
const revisionRow = async (id: number) => {
  await screen.findByRole('list', { name: 'Revisions' });
  return document.querySelector(`[data-revision-id="${id}"]`) as HTMLElement;
};

describe('ChapterPanel', () => {
  test("shows that chapter's section of the storyboard, and only that", async () => {
    renderChapter();
    expect(await screen.findByRole('heading', { name: 'Chapter 2 · The Tent' })).toBeInTheDocument();
    const md = await screen.findByTestId('storyboard-markdown');
    expect(within(md).getByRole('heading', { name: '2 · The Tent (23–38.5)' })).toBeInTheDocument();
    expect(md).toHaveTextContent("Chapter two's shots.");
    expect(md).not.toHaveTextContent('The Kitchen');
    expect(md).not.toHaveTextContent('Judging');
  });

  test('shows the feedback box, the model and Revise; Revise queues a chapter job and is off while it sends', async () => {
    const { fetchMock } = renderChapter({ answers: { 'POST /api/jobs': never } });
    fireEvent.change(await screen.findByRole('textbox', { name: 'What should change in this chapter?' }), { target: { value: 'more flour ' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Claude model' }), { target: { value: 'haiku' } });
    const button = await revise();
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(bodies(fetchMock, 'POST /api/jobs')).toEqual([
      { kind: 'chapter', versionId: 'mine', params: { chapter: 2, feedback: 'more flour' }, model: 'haiku' },
    ]);
  });

  test('Revise without feedback asks for a plain rewrite', async () => {
    const { fetchMock } = renderChapter({ answers: { 'POST /api/jobs': never } });
    fireEvent.click(await revise());
    await waitFor(() => expect(calls(fetchMock)).toContain('POST /api/jobs'));
    expect(bodies(fetchMock, 'POST /api/jobs')).toEqual([{ kind: 'chapter', versionId: 'mine', params: { chapter: 2 }, model: null }]);
  });

  test.each(['queued', 'running'] as const)('Revise is off while a job for this chapter is %s', async status => {
    renderChapter({ jobs: [job({ id: 4, kind: 'chapter', params: { chapter: 2 }, status })] });
    expect(await revise()).toBeDisabled();
    expect(screen.getByText(status === 'running' ? 'Claude is working on this chapter.' : 'A job for this chapter is queued.')).toBeInTheDocument();
  });

  test("other chapters' jobs, and finished ones, don't block it", async () => {
    renderChapter({
      jobs: [
        job({ id: 4, kind: 'chapter', params: { chapter: 3 }, status: 'running' }),
        job({ id: 5, kind: 'chapter', params: { chapter: 2 }, status: 'failed' }),
        job({ id: 6, kind: 'render', status: 'running' }),
      ],
    });
    expect(await revise()).toBeEnabled();
  });

  test('the history marks the current revision and offers Restore on the others', async () => {
    renderChapter();
    const current = await revisionRow(12);
    expect(current).toHaveTextContent('shorter');
    expect(within(current).getByText('current')).toBeInTheDocument();
    expect(within(current).queryByRole('button', { name: 'Restore' })).toBeNull();
    for (const id of [9, 7]) expect(within(await revisionRow(id)).getByRole('button', { name: 'Restore' })).toBeEnabled();
    expect(await revisionRow(9)).toHaveTextContent('restored revision 7');
  });

  test('Restore restores that revision, and the Restore buttons are off while it does', async () => {
    const { fetchMock } = renderChapter({ answers: { 'POST /api/revisions/7/restore': never } });
    fireEvent.click(within(await revisionRow(7)).getByRole('button', { name: 'Restore' }));
    await waitFor(async () => expect(within(await revisionRow(7)).getByRole('button', { name: 'Restore' })).toBeDisabled());
    expect(within(await revisionRow(9)).getByRole('button', { name: 'Restore' })).toBeDisabled();
    expect(calls(fetchMock)).toContain('POST /api/revisions/7/restore');
  });

  test('a restore that goes through reads the history again', async () => {
    const { fetchMock } = renderChapter({ answers: { 'POST /api/revisions/7/restore': { revision: 13 } } });
    fireEvent.click(within(await revisionRow(7)).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(calls(fetchMock).filter(c => c === REVISIONS)).toHaveLength(2));
    expect(calls(fetchMock).indexOf('POST /api/revisions/7/restore')).toBeLessThan(calls(fetchMock).lastIndexOf(REVISIONS));
    await waitFor(async () => expect(within(await revisionRow(7)).getByRole('button', { name: 'Restore' })).toBeEnabled());
  });

  test.each(['queued', 'running'] as const)('Restore is off too while a job for this chapter is %s', async status => {
    renderChapter({ jobs: [job({ id: 4, kind: 'chapter', params: { chapter: 2 }, status })] });
    for (const id of [9, 7]) expect(within(await revisionRow(id)).getByRole('button', { name: 'Restore' })).toBeDisabled();
  });

  test("lists this chapter's jobs, newest first, each with its log", async () => {
    const { fetchMock } = renderChapter({
      jobs: [
        job({ id: 4, kind: 'chapter', params: { chapter: 2, feedback: 'more flour' }, status: 'done', cost_usd: 0.42 }),
        job({ id: 8, kind: 'chapter', params: { chapter: 2 }, status: 'failed', error: 'boom' }),
        job({ id: 6, kind: 'chapter', params: { chapter: 3 }, status: 'done' }),
        job({ id: 7, kind: 'storyboard', status: 'done' }),
      ],
      answers: { 'GET /api/jobs/8': { ...job({ id: 8, kind: 'chapter', params: { chapter: 2 }, status: 'failed' }), log: 'the log' } },
    });
    const list = await screen.findByRole('list', { name: 'Jobs for chapter 2' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map(r => r.getAttribute('data-job-id'))).toEqual(['8', '4']);
    expect(rows[0]).toHaveTextContent('boom');
    expect(rows[1]).toHaveTextContent('$0.42');
    expect(rows[1]).toHaveTextContent('more flour');
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Log' }));
    await waitFor(() => expect(screen.getByTestId('job-log')).toHaveTextContent('the log'));
    expect(calls(fetchMock)).toContain('GET /api/jobs/8');
  });

  test('a chapter not written yet has no history to ask for', async () => {
    const { fetchMock } = renderChapter({ path: '/versions/mine?ch=3' });
    expect(await screen.findByText('Not written yet.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Write this chapter' })).toBeInTheDocument();
    expect(calls(fetchMock).filter(c => c.includes('/revisions'))).toEqual([]);
  });

  test('an example shows the section, history and jobs, without Revise or Restore', async () => {
    renderChapter({
      manifest: { ...WRITTEN, id: 'mine', example: true },
      jobs: [job({ id: 4, kind: 'chapter', params: { chapter: 2 }, status: 'done' })],
    });
    await revisionRow(12);
    expect(screen.queryByRole('button', { name: 'Revise chapter' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByTestId('storyboard-markdown')).toHaveTextContent("Chapter two's shots.");
    expect(screen.getByRole('list', { name: 'Jobs for chapter 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remix/ })).toBeInTheDocument();
  });

  test('with the Claude CLI missing, Revise is off and says why', async () => {
    renderChapter({ health: { claude: false, claudeSignedIn: null, ffmpeg: true, painter: { ok: true, reason: null } } });
    await waitFor(async () => expect(await revise()).toBeDisabled());
    fireEvent.focus((await revise()).parentElement!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Claude Code CLI not found');
  });

  describe('thumbnails', () => {
    const strip = () => screen.queryByRole('img', { name: 'Chapter 2 thumbnails' });

    test('shows the chapter\'s strip, its URL naming the chapter\'s revision and when the strip was written', async () => {
      renderChapter({ manifest: { ...WRITTEN, thumbs: { 1: 50, 2: 1_700_000_000_250 } } });
      await screen.findByRole('heading', { name: 'Chapter 2 · The Tent' });
      expect(strip()).toHaveAttribute('src', '/thumbs/mine/c02.jpg?r=12.1700000000250');
    });

    test('without a strip, a placeholder (nothing is asked for that isn\'t there)', async () => {
      const { fetchMock } = renderChapter({ manifest: { ...WRITTEN, thumbs: { 1: 50 } } });
      expect(await screen.findByText('No thumbnails yet')).toBeInTheDocument();
      expect(strip()).toBeNull();
      expect(calls(fetchMock).some(c => c.includes('/thumbs/'))).toBe(false);
    });

    test('a strip that fails to load shows the placeholder instead', async () => {
      renderChapter({ manifest: { ...WRITTEN, thumbs: { 2: 99 } } });
      await screen.findByRole('heading', { name: 'Chapter 2 · The Tent' });
      fireEvent.error(strip()!);
      expect(await screen.findByText('No thumbnails yet')).toBeInTheDocument();
    });

    test('a chapter not written yet has no strip, whatever is on disk from before', async () => {
      renderChapter({ manifest: { ...WRITTEN, thumbs: { 3: 99 } }, path: '/versions/mine?ch=3&t=38.5' });
      expect(await screen.findByText('Not written yet', { selector: '[data-thumbs] *' })).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'Chapter 3 thumbnails' })).toBeNull();
    });

    test('Refresh thumbnails queues a thumbs job for the version', async () => {
      const { fetchMock } = renderChapter({ answers: { 'POST /api/jobs': { id: 40 } } });
      fireEvent.click(await screen.findByRole('button', { name: 'Refresh thumbnails' }));
      await waitFor(() => expect(bodies(fetchMock, 'POST /api/jobs')).toEqual([{ kind: 'thumbs', versionId: 'mine' }]));
    });

    test.each(['queued', 'running'] as const)('Refresh thumbnails is off while a thumbs job is %s', async status => {
      renderChapter({ jobs: [job({ id: 30, kind: 'thumbs', status })] });
      expect(await screen.findByRole('button', { name: 'Refresh thumbnails' })).toBeDisabled();
    });

    test('Refresh thumbnails is off, saying why, while a render of the version is queued or running', async () => {
      renderChapter({ jobs: [job({ id: 31, kind: 'render', status: 'queued' })] });
      const button = await screen.findByRole('button', { name: 'Refresh thumbnails' });
      expect(button).toBeDisabled();
      fireEvent.focus(button.parentElement!);
      expect(await screen.findByRole('tooltip')).toHaveTextContent('A final render of this version is under way');
    });

    test('Refresh thumbnails is off, saying why, while previews can\'t be painted', async () => {
      renderChapter({ health: { ...HEALTHY, painter: { ok: false, reason: 'no Chromium-based browser found' } } });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh thumbnails' })).toBeDisabled());
      fireEvent.focus(screen.getByRole('button', { name: 'Refresh thumbnails' }).parentElement!);
      expect(await screen.findByRole('tooltip')).toHaveTextContent("Previews can't paint: no Chromium-based browser found");
    });

    test('an example can refresh its thumbnails too (it changes none of its code)', async () => {
      renderChapter({ manifest: { ...WRITTEN, example: true } });
      expect(await screen.findByRole('button', { name: 'Refresh thumbnails' })).toBeEnabled();
    });
  });
});
