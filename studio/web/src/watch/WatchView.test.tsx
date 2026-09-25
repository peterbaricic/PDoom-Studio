import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Manifest, Render, Revision } from '@/api/types';
import { calls, job, mockApi, renderInRouter } from '../test-utils';
import { storyboardQuery } from '@/workspace/inspectorControls';
import { WatchView } from './WatchView';

afterEach(() => vi.unstubAllGlobals());

const WHEN = Date.UTC(2026, 8, 20, 12, 0);

const render = (overrides: Partial<Render> & Pick<Render, 'id'>): Render => ({
  version_id: 'mine',
  file: `mine-${overrides.id}.mp4`,
  revision_ids: [],
  snapshot_id: null,
  title: 'Mine',
  logline: 'A bake-off, doomed.',
  duration_s: 156.6,
  render_s: 300,
  size_bytes: 1,
  poster: `mine-${overrides.id}.jpg`,
  created_at: WHEN + overrides.id * 60_000,
  ...overrides,
});

const MANIFEST = {
  id: 'mine',
  title: 'Mine',
  logline: 'A bake-off, doomed.',
  status: 'ready',
  example: false,
  options: { wipes: true, cornerMeter: true },
  concept: 'Clawd and the Researcher bake a superintelligence.',
  files: ['STORYBOARD.md'],
  scripts: [],
  walkthrough: [
    { n: 1, name: 'The Lab', start: 0, end: 23, text: 'Night in the lab.' },
    { n: 2, name: 'The Tent', start: 23, end: 38.5, text: 'The bake-off tent fills up.' },
    { n: 3, name: 'The Oven', start: 38.5, end: 59, text: 'Something rises.' },
  ],
  fileRevisions: {},
  storyboardErrors: [],
} satisfies Manifest;

const revision = (id: number, source: string, note: string, path = 'ch/c02_tent.js'): Revision => ({
  id,
  version_id: 'mine',
  path,
  job_id: null,
  source,
  note,
  sha256: null,
  created_at: WHEN - id,
});

const HISTORY = [
  revision(6, 'claude', 'make the tent bigger'),
  revision(5, 'claude', 'chapter job'),
  revision(4, 'manual', 'edited by hand', 'STORYBOARD.md'),
  revision(3, 'restore', 'restored revision 1'),
  revision(2, 'claude', 'storyboard job', 'STORYBOARD.md'),
  revision(1, 'remix', 'remixed from original', 'STORYBOARD.md'),
];

const JOBS = [
  job({ id: 3, kind: 'chapter', cost_usd: 0.5 }),
  job({ id: 2, kind: 'storyboard', cost_usd: 0.25 }),
  job({ id: 1, kind: 'render', cost_usd: 0 }),
];

const RENDERS = [render({ id: 5 }), render({ id: 4, version_id: 'other', title: 'Other' }), render({ id: 3 })];

function watch({ renderId, answers = {} }: { renderId?: number; answers?: Record<string, unknown> } = {}) {
  const fetchMock = mockApi({
    'GET /api/library': RENDERS,
    'GET /api/versions/mine': MANIFEST,
    'GET /api/versions/mine/history': HISTORY,
    'GET /api/jobs?version=mine': JOBS,
    'GET /v/mine/STORYBOARD.md': new Response('# Storyboard\n\nThe whole plan.', { headers: { 'content-type': 'text/markdown' } }),
    ...answers,
  });
  const utils = renderInRouter(<WatchView versionId="mine" renderId={renderId} />, { path: '/versions/mine/watch' });
  return { ...utils, fetchMock };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const video = () => screen.findByTestId('watch-video') as Promise<HTMLVideoElement>;
const chapter = (name: RegExp) => screen.getByRole('button', { name });

describe('WatchView', () => {
  test('plays the requested render, or the version\'s latest when none is named', async () => {
    watch({ renderId: 3 });
    expect((await video()).getAttribute('src')).toBe('/library/mine-3.mp4');
    expect((await video()).getAttribute('poster')).toBe('/library/mine-3.jpg');
  });

  test('without a render id it plays the latest render of this version', async () => {
    watch();
    expect((await video()).getAttribute('src')).toBe('/library/mine-5.mp4');
    expect(screen.getByRole('heading', { level: 1, name: 'Mine' })).toBeInTheDocument();
    expect(screen.getByText('A bake-off, doomed.')).toBeInTheDocument();
  });

  test('highlights and expands the walkthrough chapter for the video\'s current time', async () => {
    watch({ renderId: 5 });
    const v = await video();
    await screen.findByRole('button', { name: /The Tent/ });
    const item = (name: RegExp) => chapter(name).closest('li')!;

    // at 0 s: chapter 1
    expect(item(/The Lab/)).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('Night in the lab.')).toBeInTheDocument();
    expect(screen.queryByText('The bake-off tent fills up.')).toBeNull();

    v.currentTime = 30;
    fireEvent.timeUpdate(v);
    expect(item(/The Tent/)).toHaveAttribute('aria-current', 'true');
    expect(item(/The Lab/)).not.toHaveAttribute('aria-current');
    expect(screen.getByText('The bake-off tent fills up.')).toBeInTheDocument();
    expect(screen.queryByText('Night in the lab.')).toBeNull();

    // a seek (while paused, no timeupdate) moves it too
    v.currentTime = 40;
    fireEvent.seeked(v);
    expect(item(/The Oven/)).toHaveAttribute('aria-current', 'true');

    // past the last chapter's end, none is current
    v.currentTime = 150;
    fireEvent.timeUpdate(v);
    expect(within(screen.getByRole('list', { name: 'Walkthrough' })).queryAllByRole('listitem').filter(li => li.hasAttribute('aria-current'))).toEqual([]);
  });

  test('clicking a chapter seeks the video there and plays', async () => {
    watch({ renderId: 5 });
    const v = await video();
    const play = vi.spyOn(v, 'play');
    fireEvent.click(await screen.findByRole('button', { name: /The Oven/ }));
    expect(v.currentTime).toBeCloseTo(38.51, 5);
    expect(play).toHaveBeenCalledOnce();
    // and the timeupdate that follows highlights it
    fireEvent.timeUpdate(v);
    expect(chapter(/The Oven/).closest('li')).toHaveAttribute('aria-current', 'true');
  });

  test('"How it was made" shows the concept, revision count, feedback notes, Claude cost and render date', async () => {
    watch({ renderId: 5 });
    const made = await screen.findByRole('region', { name: 'How it was made' });
    expect(within(made).getByText('Clawd and the Researcher bake a superintelligence.')).toBeInTheDocument();
    await within(made).findByText(/6 revisions/);
    expect(within(made).getByText(/2 rounds of feedback/)).toBeInTheDocument();
    // claude and manual notes, not the "<kind> job" placeholders, restores or remixes; oldest first
    const notes = within(made).getByRole('list', { name: 'Feedback' });
    expect(within(notes).getAllByRole('listitem').map(li => li.textContent)).toEqual([
      'STORYBOARD.md: edited by hand',
      'ch/c02_tent.js: make the tent bigger',
    ]);
    expect(within(made).queryByText(/chapter job|storyboard job|restored revision|remixed from/)).toBeNull();
    // the sum of every job's Claude cost
    await within(made).findByText(/Claude cost \$0\.75/);
    expect(within(made).getByText(new RegExp(`rendered ${escape(new Date(WHEN + 5 * 60_000).toLocaleString())} in 5 min`))).toBeInTheDocument();
  });

  test('the storyboard is in a collapsible, rendered from Markdown', async () => {
    watch({ renderId: 5 });
    const made = await screen.findByRole('region', { name: 'How it was made' });
    const summary = await within(made).findByText('Storyboard', { selector: 'summary' });
    expect(summary.tagName).toBe('SUMMARY');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(await within(made).findByRole('heading', { name: 'Storyboard', level: 1 })).toBeInTheDocument();
    expect(within(made).getByText('The whole plan.')).toBeInTheDocument();
  });

  test('the version\'s other renders are linked; other versions\' are not', async () => {
    watch({ renderId: 5 });
    const others = await screen.findByRole('list', { name: 'Other renders' });
    const links = within(others).getAllByRole('link');
    expect(links.map(a => a.getAttribute('href'))).toEqual(['/versions/mine/watch?render=3']);
    expect(links[0]).toHaveTextContent(new Date(WHEN + 3 * 60_000).toLocaleString());
  });

  test('watching an older render links the latest as well', async () => {
    watch({ renderId: 3 });
    const others = await screen.findByRole('list', { name: 'Other renders' });
    expect(within(others).getAllByRole('link').map(a => a.getAttribute('href'))).toEqual(['/versions/mine/watch?render=5']);
    expect(within(others).getByText(/latest/)).toBeInTheDocument();
  });

  test('a render that no longer exists says so and links the library', async () => {
    watch({ renderId: 99 });
    expect(await screen.findByText(/This render no longer exists/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /library/i })).toHaveAttribute('href', '/library');
    expect(screen.queryByTestId('watch-video')).toBeNull();
  });

  test('a render id of another version is not played here', async () => {
    watch({ renderId: 4 });
    expect(await screen.findByText(/This render no longer exists/)).toBeInTheDocument();
  });

  test('a version that was never rendered says so and points back to its workspace', async () => {
    watch({ answers: { 'GET /api/library': [render({ id: 4, version_id: 'other' })], 'GET /api/jobs?version=mine': [job({ id: 1, kind: 'chapter' })] } });
    expect(await screen.findByText("This version hasn't been rendered yet.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to the version/i })).toHaveAttribute('href', '/versions/mine');
  });

  test('a version whose renders were all deleted says so, not that it was never rendered', async () => {
    watch({ answers: { 'GET /api/library': [], 'GET /api/jobs?version=mine': [job({ id: 1, kind: 'render', status: 'done' })] } });
    expect(await screen.findByText(/This version has no renders now/)).toBeInTheDocument();
    expect(screen.queryByText(/hasn't been rendered/)).toBeNull();
  });

  test('while it can\'t tell which, it says so neutrally', async () => {
    watch({ answers: { 'GET /api/library': [], 'GET /api/jobs?version=mine': () => new Promise(() => {}) } });
    expect(await screen.findByText('No render to show.')).toBeInTheDocument();
  });

  test('a render whose version was deleted still shows its stored title, without the version\'s parts', async () => {
    const fetchMock = mockApi({
      'GET /api/library': [render({ id: 8, version_id: 'gone', title: 'The Gone One', logline: 'It was deleted.', file: 'gone-8.mp4', poster: 'gone-8.jpg' })],
      'GET /api/versions/gone': new Response(JSON.stringify({ error: 'no such version' }), { status: 404 }),
    });
    renderInRouter(<WatchView versionId="gone" renderId={8} />, { path: '/versions/gone/watch' });
    expect((await video()).getAttribute('src')).toBe('/library/gone-8.mp4');
    expect(screen.getByRole('heading', { level: 1, name: 'The Gone One' })).toBeInTheDocument();
    expect(screen.getByText('It was deleted.')).toBeInTheDocument();
    const made = screen.getByRole('region', { name: 'How it was made' });
    expect(await within(made).findByText(/This version was deleted/)).toBeInTheDocument();
    expect(within(made).getByText(new RegExp(`Rendered ${escape(new Date(WHEN + 8 * 60_000).toLocaleString())}`))).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Walkthrough' })).toBeNull();
    // one request for the version (a 404 isn't retried), none for what depends on it
    expect(calls(fetchMock).filter(c => c === 'GET /api/versions/gone')).toHaveLength(1);
    expect(calls(fetchMock).some(c => /history|jobs|STORYBOARD/.test(c))).toBe(false);
  });

  test('a version deleted while it is watched: the stale manifest drives nothing, and nothing about it is asked again', async () => {
    let gone = false;
    const notFound = () => new Response(JSON.stringify({ error: 'no such version' }), { status: 404 });
    const { fetchMock, queryClient } = watch({
      renderId: 5,
      answers: {
        'GET /api/versions/mine': () => (gone ? notFound() : MANIFEST),
        'GET /api/versions/mine/history': () => (gone ? [] : HISTORY),
        'GET /api/jobs?version=mine': () => (gone ? [] : JOBS),
        'GET /v/mine/STORYBOARD.md': () => (gone ? notFound() : new Response('# Storyboard')),
      },
    });
    const made = await screen.findByRole('region', { name: 'How it was made' });
    await within(made).findByText(/6 revisions/);
    expect(screen.getByRole('list', { name: 'Walkthrough' })).toBeInTheDocument();

    // deleted: the `version` event refetches it, and the query keeps the manifest it had, alongside the 404
    gone = true;
    const before = calls(fetchMock).length;
    await queryClient.invalidateQueries({ queryKey: ['version', 'mine'] });
    expect(await within(made).findByText(/This version was deleted/)).toBeInTheDocument();
    expect(queryClient.getQueryData(['version', 'mine'])).toEqual(MANIFEST);
    expect(screen.queryByRole('list', { name: 'Walkthrough' })).toBeNull();
    // the refetch asked for the version and what was invalidated with it, once each; then nothing more
    const asked = calls(fetchMock).slice(before);
    expect(asked.filter(c => c === 'GET /api/versions/mine')).toHaveLength(1);
    expect(new Set(asked).size).toBe(asked.length);
    await new Promise(r => setTimeout(r, 50));
    expect(calls(fetchMock).slice(before)).toEqual(asked);
    // and a storyboard that's not there (404) isn't asked for again and again
    const retry = storyboardQuery('mine', true).retry;
    expect([retry(0, new Error('not found')), retry(0, new Error('HTTP 500')), retry(3, new Error('HTTP 500'))]).toEqual([false, true, false]);
  });

  test('a version that fails to load for another reason says so, and still plays the render', async () => {
    const fail = () => new Response(JSON.stringify({ error: 'database is locked' }), { status: 500 });
    const { fetchMock } = watch({ answers: { 'GET /api/versions/mine': fail } });
    expect((await video()).getAttribute('src')).toBe('/library/mine-5.mp4');
    // (retried once, a second later, before giving up)
    await waitFor(() => expect(screen.getByText(/Couldn't load how this version was made: database is locked/)).toBeInTheDocument(), { timeout: 5_000 });
    expect(calls(fetchMock).filter(c => c === 'GET /api/versions/mine')).toHaveLength(2);
    // the rest is still there: the video's title, and nothing claiming the version is gone
    expect(screen.getByRole('heading', { level: 1, name: 'Mine' })).toBeInTheDocument();
    expect(screen.queryByText(/This version was deleted/)).toBeNull();
  }, 10_000);
});
