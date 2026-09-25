// AppShell.tsx: the frame every screen sits in (the root route's component, router.tsx): the health banner across
// the top, the versions sidebar, the header, and the routed screen in <Outlet/>. It also owns the app-wide overlays:
// the job log viewer (opened from anywhere with useOpenJobLog(), LogViewer.tsx) and the toasts.
import { Outlet } from '@tanstack/react-router';
import { Toaster } from '@/components/ui/sonner';
import { HeaderBar } from './HeaderBar';
import { HealthBanner } from './HealthBanner';
import { JobLogProvider } from './LogViewer';
import { VersionSidebar } from './VersionSidebar';

export function AppShell() {
  return (
    <JobLogProvider>
      <div className="flex h-dvh flex-col">
        <HealthBanner />
        <div className="flex min-h-0 flex-1">
          <VersionSidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <HeaderBar />
            <main className="min-h-0 flex-1 overflow-auto">
              <Outlet />
            </main>
          </div>
        </div>
      </div>
      <Toaster position="bottom-right" />
    </JobLogProvider>
  );
}
