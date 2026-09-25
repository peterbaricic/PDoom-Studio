// inspectorTestUtils.tsx: fixtures and a harness for the inspector's tests (not shipped: only *.test.tsx import it).
// The harness renders the Inspector as the workspace does, with the selected chapter read from the URL's ?ch=.
import { useRouterState } from '@tanstack/react-router';
import type { Health, Job, Manifest } from '@/api/types';
import { JobLogProvider } from '@/shell/LogViewer';
import { mockApi, renderInRouter } from '../test-utils';
import { Inspector } from './Inspector';

// A studio-format storyboard with a table, raw HTML that must stay text, a javascript: link and an outside image.
export const STORYBOARD = `---
title: The Bake-Off
logline: Clawd bakes.
---

# The Bake-Off: storyboard

The idea: a baking show. <script>window.__pwned = true</script><img src=x onerror="window.__pwned = true">

See [the recipe](javascript:window.__pwned=true) and ![a cat in an apron](http://example.com/cat.png).

## 1 · The Kitchen (0–23)

Walkthrough: Clawd preheats the oven.

| Time | Lyric | Shot | Out |
|---|---|---|---|
| 0 | intro | oven door | flour |

## 2 · The Tent (23–38.5)

Walkthrough: The tent goes up.

Chapter two's shots.

## 3 · The Judges (38.5–59)

Walkthrough: Judging.
`;

export const HEALTHY: Health = { claude: true, claudeSignedIn: true, ffmpeg: true };

export function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: 'mine',
    title: 'The Bake-Off',
    logline: 'Clawd bakes.',
    status: 'storyboard',
    example: false,
    options: { wipes: true, cornerMeter: true },
    concept: 'A baking show.',
    files: ['STORYBOARD.md'],
    scripts: [],
    walkthrough: [
      { n: 1, name: 'The Kitchen', start: 0, end: 23, text: 'Clawd preheats the oven.' },
      { n: 2, name: 'The Tent', start: 23, end: 38.5, text: 'The tent goes up.' },
    ],
    fileRevisions: { 'STORYBOARD.md': 2 },
    storyboardErrors: [],
    ...overrides,
  };
}

function InspectorAtUrl(props: { manifest: Manifest; jobs: Job[]; onRemix?: () => void }) {
  const search = useRouterState({ select: s => s.location.search }) as { ch?: number };
  return <Inspector versionId={props.manifest.id} manifest={props.manifest} jobs={props.jobs} chapter={search.ch} onRemix={props.onRemix} />;
}

export interface RenderInspectorOptions {
  manifest?: Manifest;
  jobs?: Job[];
  path?: string;
  health?: Health;
  answers?: Record<string, unknown>;
  onRemix?: () => void;
}

// Renders the inspector at `path` (default /versions/mine), with STORYBOARD.md and /api/health answered, plus
// `answers` (mockApi's table).
export function renderInspector({ manifest: m = manifest(), jobs = [], path, health = HEALTHY, answers = {}, onRemix }: RenderInspectorOptions = {}) {
  const fetchMock = mockApi({
    [`GET /v/${m.id}/STORYBOARD.md`]: () => new Response(STORYBOARD, { headers: { 'content-type': 'text/markdown' } }),
    'GET /api/health': health,
    ...answers,
  });
  const utils = renderInRouter(
    <JobLogProvider>
      <InspectorAtUrl manifest={m} jobs={jobs} onRemix={onRemix} />
    </JobLogProvider>,
    { path: path ?? `/versions/${m.id}` },
  );
  return { ...utils, fetchMock };
}

// The JSON body of every call to "<METHOD> <path>" a mockApi fetch received.
export function bodies(fetchMock: ReturnType<typeof mockApi>, key: string): unknown[] {
  return fetchMock.mock.calls
    .filter(([path, init]) => `${init?.method ?? 'GET'} ${path}` === key)
    .map(([, init]) => JSON.parse(String(init?.body)));
}

// An answer that never comes: the request stays in flight for the rest of the test.
export const never = () => new Promise(() => {});
