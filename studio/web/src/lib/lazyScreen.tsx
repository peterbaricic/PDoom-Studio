// lazyScreen.tsx: a route's screen loaded on first use (its own chunk). Used by router.tsx.
import { Suspense, lazy, useCallback, useState, type ComponentType, type ReactElement } from 'react';
import { LoadBoundary } from '@/components/LoadBoundary';
import { Skeleton } from '@/components/ui/skeleton';

// A screen loaded on first use, with a skeleton meanwhile. `load` resolves to the screen component. If its chunk fails to load (the studio was rebuilt since
// this page loaded, say), the failure shows in place with Retry; React.lazy keeps a failed import failed for good, so
// Retry makes a fresh lazy component, kept at module level so later visits reuse the one that loaded.
export function lazyScreen<P extends object>(what: string, load: () => Promise<ComponentType<P>>): (props: P) => ReactElement {
  const make = () => lazy(() => load().then(Screen => ({ default: Screen })));
  let Lazy = make();
  return function LazyScreen(props: P) {
    const [Screen, setScreen] = useState(() => Lazy);
    const retry = useCallback(() => {
      Lazy = make();
      setScreen(() => Lazy);
    }, []);
    return (
      <LoadBoundary what={what} onRetry={retry} className="m-4">
        <Suspense fallback={<Skeleton className="m-4 aspect-video max-w-4xl" />}>
          <Screen {...props} />
        </Suspense>
      </LoadBoundary>
    );
  };
}
