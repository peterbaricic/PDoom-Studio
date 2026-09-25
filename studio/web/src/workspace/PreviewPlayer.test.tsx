import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PreviewPlayer } from './PreviewPlayer';
import type { PreviewPlayer as Player } from './usePreviewPlayer';

afterEach(() => vi.restoreAllMocks());

function player(overrides: Partial<Player> = {}): Player {
  return {
    state: 'paused',
    time: 0,
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    playNow: vi.fn(),
    safeIn: null,
    aheadReady: 0,
    error: null,
    painting: false,
    canvasRef: vi.fn(),
    ...overrides,
  };
}

describe('PreviewPlayer', () => {
  test('draws into a 1920x1080 canvas it hands to the player', () => {
    const p = player();
    render(<PreviewPlayer player={p} duration={156.6} />);
    const canvas = (p.canvasRef as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as HTMLCanvasElement;
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
  });

  test('Play, the time, and how long until it is safe to play', () => {
    const p = player({ time: 83.4, safeIn: 125 });
    render(<PreviewPlayer player={p} duration={156.6} />);
    expect(screen.getByText('1:23 / 2:36')).toBeInTheDocument();
    expect(screen.getByText('Safe to play in 2:05')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(p.play).toHaveBeenCalled();
  });

  test('ready to play once it is safe', () => {
    render(<PreviewPlayer player={player({ safeIn: 0 })} duration={156.6} />);
    expect(screen.getByText(/Ready to play/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Play now/ })).toBeNull();
  });

  test('"Play now (m:ss ready)" while part of it is ready', () => {
    const p = player({ safeIn: 300, aheadReady: 12.5 });
    render(<PreviewPlayer player={p} duration={156.6} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play now (0:12 ready)' }));
    expect(p.playNow).toHaveBeenCalled();
  });

  test('waiting: says when it starts, and the button cancels', () => {
    const p = player({ state: 'waiting', safeIn: 42 });
    render(<PreviewPlayer player={p} duration={156.6} />);
    expect(screen.getByText('Starts by itself in about 0:42')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(p.play).toHaveBeenCalled();
  });

  test('playing: the button pauses', () => {
    const p = player({ state: 'playing', safeIn: 0 });
    render(<PreviewPlayer player={p} duration={156.6} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(p.play).toHaveBeenCalled();
  });

  test('shows the error when the playhead\'s chapter is broken', () => {
    render(<PreviewPlayer player={player({ error: 'Chapter 3 failed to paint: boom' })} duration={156.6} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Chapter 3 failed to paint: boom');
  });

  test('full screen uses the Fullscreen API on the player', () => {
    const request = vi.fn(async () => {});
    HTMLElement.prototype.requestFullscreen = request;
    render(<PreviewPlayer player={player()} duration={156.6} />);
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(request).toHaveBeenCalledTimes(1);
    expect((request.mock.contexts[0] as HTMLElement).querySelector('canvas')).not.toBeNull();
  });

  test('the space bar plays and pauses, except while typing', () => {
    const p = player();
    render(
      <>
        <PreviewPlayer player={p} duration={156.6} />
        <textarea aria-label="notes" />
      </>,
    );
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    expect(p.play).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText('notes'), { key: ' ', code: 'Space' });
    expect(p.play).toHaveBeenCalledTimes(1);
  });
});
