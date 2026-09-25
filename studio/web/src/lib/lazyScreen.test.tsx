import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { lazyScreen } from './lazyScreen';

afterEach(() => vi.restoreAllMocks());

describe('lazyScreen', () => {
  test('shows a failed chunk load in place, and Retry loads it afresh', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); // React reports the caught error
    const Loaded = ({ name }: { name: string }) => <p>{`hello ${name}`}</p>;
    const load = vi
      .fn<() => Promise<typeof Loaded>>()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValue(Loaded);
    const Screen = lazyScreen('the test screen', load);

    render(<Screen name="there" />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the test screen: Failed to fetch dynamically imported module");
    expect(load).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // a fresh lazy component: React.lazy alone would rethrow the cached failure without calling load again
    expect(await screen.findByText('hello there')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a later mount reuses the screen that loaded', async () => {
    const Loaded = () => <p>loaded</p>;
    const load = vi.fn(async () => Loaded);
    const Screen = lazyScreen('the test screen', load);
    const first = render(<Screen />);
    expect(await screen.findByText('loaded')).toBeInTheDocument();
    first.unmount();
    render(<Screen />);
    expect(await screen.findByText('loaded')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
