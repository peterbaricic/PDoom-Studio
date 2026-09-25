// VersionDialogs.tsx: the version dialogs (new version, Remix, Promote, Delete), opened from anywhere in the app
// with useOpenVersionDialog() (the sidebar's "+ New version", the header's version menu, the inspector's Remix).
// AppShell holds the one provider. Each dialog is its own chunk, loaded when first opened; a dialog that can't load
// (the studio was rebuilt since the page loaded, say) says so in a toast, and opening it again tries again. The last
// dialog opened stays mounted while it animates closed.
import { createContext, useCallback, useContext, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { toast } from 'sonner';

export type VersionDialog = { kind: 'new' } | { kind: 'remix' | 'promote' | 'delete'; versionId: string };

interface DialogProps {
  versionId: string;
  open: boolean;
  onClose: () => void;
}

const LOADERS: Record<VersionDialog['kind'], () => Promise<ComponentType<DialogProps>>> = {
  new: () => import('./NewVersionDialog').then(m => m.NewVersionDialog),
  remix: () => import('./RemixDialog').then(m => m.RemixDialog),
  promote: () => import('./PromoteDialog').then(m => m.PromoteDialog),
  delete: () => import('./DeleteVersionDialog').then(m => m.DeleteVersionDialog),
};

const OpenContext = createContext<((dialog: VersionDialog) => void) | null>(null);

// Opens a version dialog; null outside the provider (a component rendered on its own, in a test).
export function useOpenVersionDialog() {
  return useContext(OpenContext);
}

export function VersionDialogsProvider({ children }: { children: ReactNode }) {
  // `key`: a fresh dialog (empty fields) each time one is opened.
  const [shown, setShown] = useState<{ Dialog: ComponentType<DialogProps>; versionId: string; key: number } | null>(null);
  const [open, setOpen] = useState(false);
  const latest = useRef(0);
  const openDialog = useCallback((dialog: VersionDialog) => {
    const n = ++latest.current;
    LOADERS[dialog.kind]().then(
      Dialog => {
        if (n !== latest.current) return; // another one was asked for meanwhile
        setShown({ Dialog, versionId: dialog.kind === 'new' ? '' : dialog.versionId, key: n });
        setOpen(true);
      },
      (e: Error) => toast.error(`Couldn't open the dialog: ${e.message}`),
    );
  }, []);
  const close = useCallback(() => setOpen(false), []);

  return (
    <OpenContext.Provider value={openDialog}>
      {children}
      {shown && <shown.Dialog key={shown.key} versionId={shown.versionId} open={open} onClose={close} />}
    </OpenContext.Provider>
  );
}
