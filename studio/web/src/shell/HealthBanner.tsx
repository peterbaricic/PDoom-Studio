// HealthBanner.tsx: what's wrong with the studio's surroundings, above everything else. First, a server restart
// since this page loaded (api/client.ts's restartedState, set by a 403 for a stale token): every mutation will fail
// until the page reloads. Then /api/health: the Claude CLI missing or signed out, or ffmpeg missing.
import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlertIcon } from 'lucide-react';
import { api, restartedState } from '@/api/client';
import type { Health } from '@/api/types';
import { Button } from '@/components/ui/button';

// Why Claude actions can't run right now, or null when they can (or when health isn't known yet). For the banner,
// and for disabling Claude actions with this as their tooltip.
export function claudeUnavailable(health: Health | undefined): string | null {
  if (!health) return null;
  if (!health.claude) return 'Claude Code CLI not found: creating and revising versions is disabled.';
  if (health.claudeSignedIn === false) return 'Claude CLI is signed out — run `claude auth login` in a terminal.';
  return null;
}

export function useHealth() {
  // The server asks the CLI at most once a minute; asking as often here lets a fixed problem clear on its own.
  return useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('/api/health'), staleTime: 60_000, refetchInterval: 60_000 });
}

export function HealthBanner() {
  const restarted = useSyncExternalStore(restartedState.subscribe, () => restartedState.value);
  const { data: health } = useHealth();
  const problems = [
    claudeUnavailable(health),
    health && !health.ffmpeg ? 'ffmpeg not found: final renders will fail.' : null,
  ].filter((p): p is string => p != null);

  if (!restarted && !problems.length) return null;
  return (
    <div role="alert" className="flex flex-col gap-1 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-100">
      {restarted && (
        <div className="flex items-center gap-3">
          <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
          <span className="font-medium">The studio server restarted — reload this page.</span>
          <Button size="sm" variant="secondary" onClick={() => location.reload()}>
            Reload
          </Button>
        </div>
      )}
      {problems.map(p => (
        <div key={p} className="flex items-center gap-3">
          <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
          <span>{p}</span>
        </div>
      ))}
    </div>
  );
}
