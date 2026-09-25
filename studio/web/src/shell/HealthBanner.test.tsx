import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { HealthBanner } from './HealthBanner';
import { _resetRestartedForTests, api } from '../api/client';
import { mockApi, renderInRouter } from '../test-utils';

beforeEach(() => _resetRestartedForTests());
afterEach(() => vi.unstubAllGlobals());

const healthy = { claude: true, claudeSignedIn: true, ffmpeg: true, painter: { ok: true, reason: null } };

describe('HealthBanner', () => {
  test('shows nothing when all is well', async () => {
    mockApi({ 'GET /api/health': healthy });
    const { queryClient } = renderInRouter(<HealthBanner />);
    await waitFor(() => expect(queryClient.getQueryData(['health'])).toEqual(healthy));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('says the Claude CLI is signed out, and how to sign in', async () => {
    mockApi({ 'GET /api/health': { ...healthy, claudeSignedIn: false } });
    renderInRouter(<HealthBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Claude CLI is signed out.*claude auth login/);
  });

  test('says when the Claude CLI is missing', async () => {
    mockApi({ 'GET /api/health': { claude: false, claudeSignedIn: null, ffmpeg: true, painter: { ok: true, reason: null } } });
    renderInRouter(<HealthBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Claude Code CLI not found/);
  });

  test('says when ffmpeg is missing', async () => {
    mockApi({ 'GET /api/health': { ...healthy, ffmpeg: false } });
    renderInRouter(<HealthBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/ffmpeg not found/);
  });

  test('asks for a reload once a mutation is refused for a stale token', async () => {
    mockApi({
      'GET /api/health': healthy,
      'POST /api/jobs/1/cancel': new Response(JSON.stringify({ error: 'missing or wrong token' }), { status: 403 }),
    });
    renderInRouter(<HealthBanner />);
    await expect(api.post('/api/jobs/1/cancel')).rejects.toThrow('missing or wrong token');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The studio server restarted — reload this page.');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });
});
