import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Coverage, Song } from '@/api/types';
import { job, renderInRouter } from '../test-utils';
import { Timeline, type TimelineProps } from './Timeline';

afterEach(() => vi.unstubAllGlobals());

const CHAPTERS: Array<[number, number]> = [
  [0, 23], [23, 38.5], [38.5, 59], [59, 73], [73, 95.4], [95.4, 109.4], [109.4, 123.5], [123.5, 140.5], [140.5, 156.6],
];
const SONG: Song = { fps: 24, frames: 3759, duration: 156.6, chapters: CHAPTERS, lyrics: [] };
const segments = (missing: number[] = []): Coverage['segments'] =>
  Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => [n, missing.includes(n) ? null : `k${n}`]));

function renderTimeline(props: Partial<TimelineProps> = {}) {
  const onSeek = vi.fn();
  const utils = renderInRouter(
    <Timeline
      versionId="mine"
      song={SONG}
      coverage={{ total: 3759, ranges: [], broken: [], segments: segments() }}
      jobs={[]}
      time={0}
      onSeek={onSeek}
      {...props}
    />,
    { path: '/versions/mine' },
  );
  return { ...utils, onSeek };
}

const block = (n: number) => screen.findByRole('button', { name: new RegExp(`^Chapter ${n}\\b`) });

describe('Timeline', () => {
  test('shows nine blocks sized by their windows', async () => {
    renderTimeline();
    const first = await block(1);
    expect(first.style.left).toBe('0%');
    expect(parseFloat(first.style.width)).toBeCloseTo((23 / 156.6) * 100, 6);
    const second = await block(2);
    expect(parseFloat(second.style.left)).toBeCloseTo((23 / 156.6) * 100, 6);
    expect(screen.getAllByRole('button', { name: /^Chapter \d/ })).toHaveLength(9);
  });

  test('clicking a block selects its chapter and seeks to its start, in the URL (?ch=n&t=start)', async () => {
    const { router } = renderTimeline();
    fireEvent.click(await block(3));
    await waitFor(() => expect(router.state.location.search).toEqual({ ch: 3, t: 38.5 }));
    expect(router.state.location.pathname).toBe('/versions/mine');
  });

  test('clicking a block also seeks directly, so the selected block seeks back to its start even when the URL already says so', async () => {
    const { onSeek } = renderTimeline({ selected: 3, time: 50 });
    fireEvent.click(await block(3));
    expect(onSeek).toHaveBeenCalledWith(38.5);
  });

  test('the selected chapter is marked', async () => {
    renderTimeline({ selected: 4 });
    expect(await block(4)).toHaveAttribute('aria-pressed', 'true');
    expect(await block(3)).toHaveAttribute('aria-pressed', 'false');
  });

  test('coverage ranges render as shaded spans on the track', async () => {
    const { container } = renderTimeline({
      coverage: { total: 3759, ranges: [[0, 551], [1000, 1099]], broken: [], segments: segments() },
    });
    await block(1);
    const spans = [...container.querySelectorAll<HTMLElement>('[data-range]')];
    expect(spans.map(s => s.dataset.range)).toEqual(['0-551', '1000-1099']);
    expect(parseFloat(spans[1]!.style.left)).toBeCloseTo((1000 / 3759) * 100, 6);
    expect(parseFloat(spans[1]!.style.width)).toBeCloseTo((100 / 3759) * 100, 6);
  });

  test('a chapter with a running chapter job shows the working indicator; a queued one a lighter one', async () => {
    renderTimeline({
      jobs: [
        job({ id: 1, kind: 'chapter', params: { chapter: 2 }, status: 'running' }),
        job({ id: 2, kind: 'chapter', params: { chapter: 5 }, status: 'queued' }),
        job({ id: 3, kind: 'chapter', params: { chapter: 7 }, status: 'done' }),
        job({ id: 4, kind: 'render', status: 'running' }),
      ],
    });
    expect(within(await block(2)).getByLabelText('Claude is working on this chapter')).toBeInTheDocument();
    expect(within(await block(5)).getByLabelText('queued for Claude')).toBeInTheDocument();
    for (const n of [1, 3, 4, 6, 7, 8, 9]) {
      expect(within(await block(n)).queryByLabelText(/Claude is working|queued for Claude/)).toBeNull();
    }
  });

  test('a broken chapter shows its error in a tooltip', async () => {
    renderTimeline({
      coverage: { total: 3759, ranges: [], broken: [{ chapter: 6, error: 'ReferenceError: blorp is not defined' }], segments: segments() },
    });
    const broken = await block(6);
    expect(broken).toHaveAttribute('data-broken', 'true');
    fireEvent.focus(broken);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('ReferenceError: blorp is not defined');
  });

  test('a chapter that isn\'t written yet says so', async () => {
    renderTimeline({ coverage: { total: 3759, ranges: [], broken: [], segments: segments([8, 9]) } });
    expect(await block(8)).toHaveAccessibleName(/not written yet/);
    expect(await block(1)).not.toHaveAccessibleName(/not written yet/);
  });

  test('the playhead sits at the current time', async () => {
    const { container } = renderTimeline({ time: 78.3 });
    await block(1);
    const playhead = container.querySelector<HTMLElement>('[data-playhead]')!;
    expect(parseFloat(playhead.style.left)).toBeCloseTo(50, 6);
  });

  test('dragging on the track scrubs', async () => {
    const { onSeek } = renderTimeline();
    const track = await screen.findByRole('slider', { name: 'Playhead' });
    track.getBoundingClientRect = () => ({ left: 100, width: 1000, top: 0, height: 20, right: 1100, bottom: 20, x: 100, y: 0, toJSON() {} });
    fireEvent.pointerDown(track, { clientX: 600, buttons: 1, pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(78.3);
    fireEvent.pointerMove(track, { clientX: 350, buttons: 1, pointerId: 1 });
    expect(onSeek.mock.lastCall![0]).toBeCloseTo(39.15, 6);
    fireEvent.pointerUp(track, { clientX: 350, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 900, buttons: 0, pointerId: 1 });
    expect(onSeek).toHaveBeenCalledTimes(2);
  });

  test('the arrow keys step the playhead', async () => {
    const { onSeek } = renderTimeline({ time: 10 });
    const track = await screen.findByRole('slider', { name: 'Playhead' });
    fireEvent.keyDown(track, { key: 'ArrowRight' });
    expect(onSeek).toHaveBeenLastCalledWith(11);
    fireEvent.keyDown(track, { key: 'ArrowLeft' });
    expect(onSeek).toHaveBeenLastCalledWith(9);
  });

  test('a block with a thumbnail strip shows it, faintly, behind its label; one without, or broken, shows none', async () => {
    renderTimeline({
      thumbs: { 1: '/thumbs/mine/c01.jpg?r=5.1', 3: '/thumbs/mine/c03.jpg?r=6.1' },
      coverage: { total: 3759, ranges: [], broken: [{ chapter: 3, error: 'boom' }], segments: segments() },
    });
    const img = (await block(1)).querySelector('img');
    expect(img).toHaveAttribute('src', '/thumbs/mine/c01.jpg?r=5.1');
    expect(img).toHaveAttribute('alt', '');
    expect((await block(2)).querySelector('img')).toBeNull();
    expect((await block(3)).querySelector('img')).toBeNull();
  });

  test('a strip that fails to load is left out, and a new one (its URL changed) gets its chance', async () => {
    function Harness() {
      const [url, setUrl] = useState('/thumbs/mine/c01.jpg?r=5.1');
      return (
        <>
          <button type="button" onClick={() => setUrl('/thumbs/mine/c01.jpg?r=5.2')}>
            new strip
          </button>
          <Timeline versionId="mine" song={SONG} coverage={{ total: 3759, ranges: [], broken: [], segments: segments() }} jobs={[]} thumbs={{ 1: url }} time={0} onSeek={() => {}} />
        </>
      );
    }
    renderInRouter(<Harness />, { path: '/versions/mine' });
    const visibleStrip = async () => {
      const img = (await block(1)).querySelector('img');
      return img && !img.hidden ? img : null;
    };
    fireEvent.error((await visibleStrip())!);
    await waitFor(async () => expect(await visibleStrip()).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'new strip' }));
    await waitFor(async () => expect(await visibleStrip()).toHaveAttribute('src', '/thumbs/mine/c01.jpg?r=5.2'));
  });
});
