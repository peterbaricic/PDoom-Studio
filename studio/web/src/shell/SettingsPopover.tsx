// SettingsPopover.tsx: the header's settings: how much of the frame cache is used, its cap (STUDIO_CACHE_GB), and
// "Clear cache".
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SettingsIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { CacheInfo } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// Decimal units, as the cap is set (STUDIO_CACHE_GB=5 is 5e9 bytes).
export function formatBytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

export function SettingsPopover() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { data: cache, error } = useQuery({
    queryKey: ['cache'],
    queryFn: () => api.get<CacheInfo>('/api/cache'),
    enabled: open,
    staleTime: 0,
  });
  const clear = useMutation({
    mutationFn: () => api.post<CacheInfo>('/api/cache/clear'),
    onSuccess: info => {
      queryClient.setQueryData(['cache'], info);
      // Every cached frame is gone, so every version's coverage is stale.
      queryClient.invalidateQueries({ queryKey: ['coverage'] });
      toast.success('Frame cache cleared');
    },
    onError: e => toast.error(`Couldn't clear the frame cache: ${e.message}`),
  });
  const usedPct = cache && cache.capBytes > 0 ? Math.min(100, (cache.usedBytes / cache.capBytes) * 100) : 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Settings">
          <SettingsIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">Frame cache</h2>
          <p className="text-muted-foreground text-xs">Painted preview and render frames, kept so unchanged work is never repainted.</p>
        </div>
        {cache ? (
          <>
            <p className="text-sm">{`${formatBytes(cache.usedBytes)} of ${formatBytes(cache.capBytes)} used`}</p>
            <div
              role="progressbar"
              aria-label="Frame cache used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(usedPct)}
              className="bg-muted h-1.5 overflow-hidden rounded-full"
            >
              {/* A style prop is set through the CSSOM, which the SPA CSP allows (unlike a style attribute in markup). */}
              <div className="bg-primary h-full" style={{ width: `${usedPct}%` }} />
            </div>
          </>
        ) : (
          <p className="text-muted-foreground text-sm">{error ? `Couldn't read the cache: ${error.message}` : 'Loading…'}</p>
        )}
        <Button variant="outline" size="sm" disabled={!cache || clear.isPending} onClick={() => clear.mutate()}>
          Clear cache
        </Button>
      </PopoverContent>
    </Popover>
  );
}
