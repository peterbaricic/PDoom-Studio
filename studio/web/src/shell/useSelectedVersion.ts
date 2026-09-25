// useSelectedVersion.ts: the version the URL is on (/versions/$id and /versions/$id/watch), or undefined elsewhere
// (/library). Its own module because the shell's pieces (sidebar, header, jobs drawer) all read it and AppShell
// imports them — keeping it out of AppShell.tsx avoids an import cycle.
import { useParams } from '@tanstack/react-router';

export function useSelectedVersion(): string | undefined {
  return useParams({ strict: false }).id;
}
