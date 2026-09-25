// renders.ts: finished renders as the app reads them (GET /api/library, studio/db.js's listRenders), shared by the
// library, the watch view and the workspace's render bar.
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { Render } from '@/api/types';

// Every render, newest first. The `library` event (studio/app.js, on a new or deleted render) invalidates it.
export const rendersQuery = queryOptions({ queryKey: ['renders'], queryFn: () => api.get<Render[]>('/api/library') });

// A render's video or poster, as studio/app.js serves them from <data>/library/.
export const libraryFile = (file: string) => `/library/${encodeURIComponent(file)}`;

// A version's own renders, in the order given: not the detached ones kept from an earlier version with the same id.
export const rendersOf = (renders: Render[], versionId: string) => renders.filter(r => r.version_id === versionId && !r.detached);

// Its name: the version's title, or, once the version is gone, the title stored with the render (listRenders falls
// back to it); the version id if neither was ever set.
export const renderTitle = (r: Pick<Render, 'title' | 'version_id'>) => r.title || r.version_id;
