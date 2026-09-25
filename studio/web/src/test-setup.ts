import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest runs without globals, so Testing Library can't register its own automatic cleanup: unmount after each test.
afterEach(cleanup);

// jsdom lacks the layout APIs Radix's popper and presence code touch; none of them matter to what the tests check.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;
// jsdom defines this one but only to log "not implemented"; the router calls it on every navigation.
window.scrollTo = () => {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
// jsdom has no media playback or canvas drawing, and logs "not implemented" when either is used: the preview player
// (workspace/usePreviewPlayer.ts) makes an <audio> for the song and draws on a <canvas>. Its own tests pass fakes.
window.HTMLMediaElement.prototype.play = function play() {
  return Promise.resolve();
};
window.HTMLMediaElement.prototype.pause = function pause() {};
window.HTMLMediaElement.prototype.load = function load() {};
window.HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
