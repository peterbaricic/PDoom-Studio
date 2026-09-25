import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';

import { useStudioEvents } from './api/events';
import { router } from './router';
import './styles.css';

// <Toaster/> (components/ui/sonner.tsx) isn't mounted here yet: sonner injects its own CSS at import time via a
// runtime <style> tag (a tsup bundler helper, not a stylesheet link), which the SPA CSP's strict style-src 'self'
// (no 'unsafe-inline') blocks outright — confirmed by test/app.test.js's "no CSP violations" check, which fails the
// moment <Toaster/> is rendered. Whichever task mounts it (the app shell, task 6) needs to deal with that first,
// e.g. by shipping sonner's stylesheet as a real asset and dropping its runtime injection.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } },
});

function App() {
  useStudioEvents(queryClient);
  return <RouterProvider router={router} />;
}

const container = document.getElementById('root');
if (!container) throw new Error('no #root element to mount the studio app into');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
