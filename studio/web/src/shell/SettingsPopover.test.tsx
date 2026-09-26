import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SettingsPopover, formatBytes } from './SettingsPopover';
import { calls, mockApi, renderInRouter } from '../test-utils';

afterEach(() => vi.unstubAllGlobals());

test('formatBytes uses decimal units, like STUDIO_CACHE_GB', () => {
  expect(formatBytes(0)).toBe('0 MB');
  expect(formatBytes(340e6)).toBe('340 MB');
  expect(formatBytes(1.25e9)).toBe('1.3 GB');
  expect(formatBytes(5e9)).toBe('5.0 GB');
});

describe('SettingsPopover', () => {
  test('shows how much of the frame cache is used, and its cap', async () => {
    mockApi({ 'GET /api/cache': { usedBytes: 1.5e9, capBytes: 5e9 } });
    renderInRouter(<SettingsPopover />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(await screen.findByText('1.5 GB of 5.0 GB used')).toBeInTheDocument();
  });

  test('says what old renders\' frames still take, which Clear cache clears too; nothing when there are none', async () => {
    mockApi({ 'GET /api/cache': { usedBytes: 1.5e9, capBytes: 5e9, legacyBytes: 1.2e9 }, 'POST /api/cache/clear': { usedBytes: 0, capBytes: 5e9, legacyBytes: 0 } });
    renderInRouter(<SettingsPopover />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(await screen.findByText("Old renders' frames: 1.2 GB — cleared with Clear cache")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear cache' }));
    await screen.findByText('0 MB of 5.0 GB used');
    expect(screen.queryByText(/Old renders' frames/)).toBeNull();
  });

  test('Clear cache calls the API and shows the new size', async () => {
    const fetchMock = mockApi({
      'GET /api/cache': { usedBytes: 1.5e9, capBytes: 5e9 },
      'POST /api/cache/clear': { usedBytes: 0, capBytes: 5e9 },
    });
    renderInRouter(<SettingsPopover />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await screen.findByText('1.5 GB of 5.0 GB used');
    fireEvent.click(screen.getByRole('button', { name: 'Clear cache' }));
    expect(await screen.findByText('0 MB of 5.0 GB used')).toBeInTheDocument();
    await waitFor(() => expect(calls(fetchMock)).toContain('POST /api/cache/clear'));
  });
});
