import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';

import { useStudioEvents } from './api/events';
import { router } from './router';
import './styles.css';

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
