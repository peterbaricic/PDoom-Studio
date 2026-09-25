# P(doom) Studio: React redesign, server-rendered previews, frame cache

Status: approved in brainstorming on 2026-09-25, section by section. It builds on
[2026-09-24-studio-design.md](2026-09-24-studio-design.md) and the examples database
([plan](../plans/2026-09-24-examples-db.md)).

## Goals

1. Replace the studio's plain-JS UI (`studio/ui/`) with a **fresh redesign** in React + TypeScript + Vite, using
   TanStack Query, TanStack Router and shadcn/ui on Tailwind v4. The layout is the timeline workspace (direction A).
2. **Never run chapter code in the user's browser.** Previews come from the sealed headless renderer as JPEG frames.
   This removes the remaining egress channels of the in-browser preview (`<link rel=prerender>`, WebRTC from
   about:blank iframes including LAN mDNS, `preconnect`/`dns-prefetch` DNS, TCP on refused frame navigations).
3. Keep rendered frames: a **1080p frame cache** on disk, shared by previews and final renders, so switching views or
   restarting never repaints unchanged work, and a final render of a fully previewed version is mostly encoding.
4. Give the examples database its UI: **Remix**, **Promote**, plus **Delete** for the user's own versions.
5. Bundle the two fonts so renders need no network, and fail a render check when a font doesn't load.

## Success criteria

- Everything possible in today's UI is possible in the new one: create, storyboard review, edit, feedback and approve;
  chapter feedback, history and restore; engine options; final render; watch with the synced walkthrough; jobs with
  live logs, cancel and retry.
- Remix, Promote and Delete have UI.
- Previews play without chapter code ever running in the user's browser.
- Switching chapters, versions or pages, or restarting the studio, never repaints frames whose code didn't change.
- The end-to-end test drives the new UI.

## 1. Architecture

```
Browser (localhost:8080)             Bun studio server                        Headless Chrome (sealed)
React + TS app (built by Vite,  ──►  existing API + guard + token        ──►  painting pool: N pages of
served by Bun)                  ◄──  jobs queue (claude, render)         ◄──  studio.html on w0.localhost
timeline workspace, player     SSE   NEW frame service + frame cache          (dead proxy, sandboxed)
                               JPEG  .studio/cache/frames/…
```

- **Frontend:** the Vite app lives in `studio/web/`. `vite build` outputs to `studio/web/dist/`, which the Bun server
  serves on the UI hosts (localhost, 127.0.0.1, [::1]) with the token injected into `index.html`, as today.
- **Engine page:** `studio.html` and `src/*.js` remain the sealed painting page (plain scripts, p5 global mode) on
  `w0.localhost`. React never loads version code.
- **Removed:** `studio/ui/`, `watch.html`, `src/watch.js`, and the engine's worker-iframe mode (`workerMode` in
  `src/core.js`, the `?worker&parent=` protocol).
- **Unchanged:** `user.db` + `default.db`, jobs, the Claude sandbox, the guard.

## 2. Frontend

### Routes (TanStack Router, typed)

These paths don't collide with the server's `/v/…`, `/work/…`, `/api/…`, `/library/…` or `/thumbs/…`. The server
answers these SPA routes with `index.html`.

| Route | Screen |
|---|---|
| `/` | Redirects to the most recently updated version of the user's, else `/versions/original` |
| `/versions/:id?ch=<1-9>&t=<seconds>` | Timeline workspace; the selected chapter and playhead are in the URL |
| `/versions/:id/watch?render=<renderId>` | Watch a finished render (latest if omitted) |
| `/library` | Gallery of all finished renders (latest per version first) |

### Screens and components (one component per file)

- **App shell**
  - `VersionSidebar`: "Examples" (★, read-only) above "My versions", each with its stage label (concept, storyboard
    to review, building 6/9, ready, rendered); a "+ New version" button.
  - `HeaderBar`: a breadcrumb, `JobsIndicator` ("Jobs: N running · M queued"; opens `JobsDrawer`) and the version menu
    (Remix, Promote, Delete; only the items valid for this version).
- **Workspace** (`/versions/:id`)
  - `PreviewPlayer`: plays cached frames in sync with the song, with play/pause, the time, "safe to play in m:ss",
    "Play now (m:ss ready)" and a full-screen mode.
  - `Timeline`: nine chapter blocks sized by their real windows, a playhead, coverage shading (cached frames), a
    working indicator on chapters with a running Claude job, and a lighter indicator for queued ones. Clicking a block
    selects that chapter and seeks to its start; dragging scrubs.
  - `LyricsTrack`: each lyric line under its time span.
  - `RenderBar`: "Final render (1080p MP4)" (disabled with a reason when fewer than 9 chapters exist or a render is
    running), the latest render's date and duration, and "Watch".
  - `Inspector`
    - `StoryboardPanel` (no chapter selected):
      - the rendered storyboard (react-markdown + remark-gfm, raw HTML off);
      - "Edit text" (a textarea, saved as a revision);
      - "Ask for changes" (feedback plus model);
      - Approve (prominent while the stage is "storyboard to review");
      - the concept (editable) with "Redraft storyboard";
      - the engine options (brush wipes, corner meter);
      - the storyboard errors, if any.
    - `ChapterPanel` (a chapter selected):
      - that chapter's section of the storyboard (its heading through the next heading);
      - a feedback box, model and "Revise chapter";
      - the code history with Restore (not on the current revision);
      - this chapter's jobs.
  - Stage behaviour:
    - A concept without a storyboard shows the inspector's storyboard panel with a "writing…" state.
    - The "storyboard to review" stage highlights Approve.
    - While chapters are building, the timeline blocks fill in live.
    - Examples are read-only: all editing controls are hidden and a "Remix" call-to-action appears.
- **Overlays**
  - `JobsDrawer`: every job, newest first, with filters (this version or all) and status. Each row shows kind,
    chapter, status, started time, duration and cost. Log opens `LogViewer`, which appends live and auto-scrolls when
    you're at the bottom. Cancel for queued or running jobs; Retry for failed, cancelled or interrupted ones.
  - `NewVersionDialog`: title (the id is derived as a slug, editable), concept and model, then "Draft storyboard".
  - `RemixDialog`: new title (and id), then navigates to the new version.
  - `PromoteDialog`: explains "moves this version into studio/default.db as an example; it becomes read-only here;
    commit studio/default.db to share it"; disabled while Claude jobs for the version are queued or running.
  - `DeleteVersionDialog`: user versions only.
    - Deletes the version, its files and revisions, its jobs and its cache references.
    - A checkbox "also delete its finished videos" (unchecked by default).
    - Kept videos stay in the library under the deleted version's last title. `renders` gains `title` and `logline`
      columns, filled when a render is created; `listRenders` uses a LEFT JOIN and falls back to them.
- **Watch** (`/versions/:id/watch`): `WatchView` shows the MP4 on the left and the synced walkthrough on the right.
  The current chapter is highlighted and expanded, and clicking one seeks there. Below: "How it was made" (concept,
  storyboard in a collapsible, revision count, feedback notes, Claude cost, render date) and older renders.
- **Library** (`/library`): `LibraryGallery` of poster cards (title, logline, date), with delete per render.
- **Settings** (a small popover in the header): cache size used and cap, and "Clear cache".

### Data flow

- `api/client.ts`:
  - a typed fetch wrapper that adds `X-Studio-Token` from `<meta name="studio-token">`;
  - on 403 "missing or wrong token" it shows "The studio server restarted, reload this page".
- `api/types.ts`: hand-written types mirroring the server's JSON (Version, Manifest, Job, Revision, Render, Coverage,
  Health).
- **TanStack Query keys:** `['versions']`, `['version', id]`, `['jobs', { version? }]`, `['job', jobId]` (with log),
  `['renders']`, `['coverage', id]`, `['health']`, `['cache']`.
- `useStudioEvents` (one `EventSource('/api/events')` per app):
  - `version` → invalidate `['versions']` and `['version', id]`;
  - `job` → invalidate `['jobs']` and `['job', id]`;
  - `log` → append to `['job', id]`'s log via `setQueryData`;
  - `library` → invalidate `['renders']`;
  - `frames` → merge ranges into `['coverage', id]` via `setQueryData`.
- `usePreviewPlayer(versionId)`:
  - schedules frame requests ahead of the playhead (window 48–120 frames, adaptive) and decodes JPEGs with
    `createImageBitmap` (off the main thread);
  - keeps a small bitmap cache and syncs picture to `audio.currentTime`;
  - estimates "safe to play" from coverage plus the measured paint rate. Rules as today: never stutter; wait or
    "Play now" then pause at a gap.
- **Health:** when `/api/health` reports the Claude CLI missing or signed out, a banner explains it and Claude actions
  are disabled with a tooltip.

## 3. Frame cache and frame service

### Keys

A frame at time `t` is fully determined by the engine, the options, `shared.js` and the chapter covering `t`
(verified: rendering is deterministic, byte-identical across runs).

- `engineHash` = SHA-256 over `studio.html`, `src/*.js`, the p5 and p5.brush files, and the bundled font files.
- **Segment key** for chapter `n` = SHA-256(`engineHash`, the options JSON with sorted keys, the `shared.js` content
  hash or `-`, chapter `n`'s content hash).
- **Layout:** `<data root>/.studio/cache/frames/<segmentKey>/f<frameIndex>.jpg`. Frames are 1920×1080 JPEG at quality
  0.94, matching today's final-render frames.
- **Cross-chapter dependencies (CAST):** chapters may register characters on the global `CAST` object, and later
  chapters (the Original's curtain call) use them.
  - While painting, the engine page wraps `CAST` in a recording proxy. It remembers which chapter defined each entry
    and which entries a frame reads.
  - The frame service stores a sidecar `f<frameIndex>.deps.json` listing `{chapterPath: contentHash}` for every other
    chapter whose `CAST` entries the frame read (omitted when none).
  - A cached frame counts as valid only if every listed chapter still has that content hash in the version's current
    snapshot.
- **Brush wipes:** frames within 0.3 s of a wipe boundary are drawn by the chapter covering `t` plus the engine's
  wipe, so no extra dependency is needed.
- Content addressing means identical content across versions (a fresh Remix, a restored revision) shares frames.

### Snapshots and content-addressed code

- **Revision hashes:** the `revisions` table gains `sha256 TEXT` (content hash).
  - Filled on write.
  - Backfilled once for existing rows in `user.db` at startup.
  - Filled in `default.db` by the one-time build/promote path. `default.db` is read-only at runtime; a startup check
    computes missing hashes in memory without writing.
- **Snapshot:** `{ options, files: { path: sha256 } }` for a version's current files. It's computed on demand and
  identified by the SHA-256 of its canonical JSON.
- **New server routes, renderer hosts only and GET only:**
  - `GET /api/snapshot/<snapshotId>`: the manifest shape `src/loader.js` expects, with `scripts` pointing at blobs.
  - `GET /api/blob/<sha256>`: file content by hash, looked up in the revisions of either database, served as
    `text/javascript` with the renderer-host CSP and nosniff.
  - These two join `/api/versions/<id>` and `/api/work/<id>` in the renderer-host allow-list.
- **Painting pages** load `studio.html?render&snapshot=<snapshotId>`. The loader fetches the snapshot manifest and
  loads scripts by hash, so any cached key can be (re)painted exactly, even while the version changes.

### Painting pool and priorities

- **Pool:** one sealed render browser (dead proxy, the existing flags) owned by the server, with a pool of
  `STUDIO_PAINTERS` pages (default 3). Chrome shares one GPU, so the total is about 4 frames/s regardless of pool size.
- **Priority queue**, highest first:
  1. `preview` requests for frames at or near the playhead of a version currently open in the UI;
  2. `prefetch` ahead of the playhead;
  3. `render` fill for a running final-render job;
  4. `thumbs`.

  The newest preview request for a version supersedes older preview requests for the same version. Painting is
  per-frame, so a higher-priority request waits at most one frame.
- **Coalescing:** requests for frames already in progress or cached coalesce.
- **Failures:** a failing frame (page error, font missing, a paint over 20 s) marks that segment "broken" with the
  error. It's shown on the timeline block, and further requests for that segment return 409 with the error until its
  key changes.
- **Fonts:** the painting page checks `document.fonts.check` for both fonts after load; failure is a page error.

### Frame API (UI hosts only, GET)

- `GET /api/frames/<versionId>/<frameIndex>.jpg[?prio=preview|prefetch]`:
  - returns the cached frame (`Cache-Control: private, max-age=31536000, immutable`, `ETag` = segment key);
  - or queues it at the given priority and holds the request until it's painted (up to 30 s, then 202 with
    `Retry-After`).
- `GET /api/coverage/<versionId>` → `{ total: 3759, ranges: [[a, b], …], broken: [{ chapter, error }] }` for the
  version's current snapshot.
- SSE `frames` event: `{ versionId, ranges: [[a, b], …] }` (coalesced, at most every 500 ms).
- `GET /api/cache` → `{ usedBytes, capBytes }`; `POST /api/cache/clear` (token-guarded) evicts everything not pinned
  by a running render.

### Final render from the cache

The `render` job:
1. snapshots the version;
2. requests every missing frame at `render` priority, reporting progress as coverage;
3. encodes the MP4 with ffmpeg straight from the cached files (a concat list in frame order) plus the song;
4. takes the poster from the cached frame at 78 s (1872);
5. adds the `renders` row, with the snapshot id replacing today's revision-id list.

`render.mjs` keeps its command-line modes for manual use. Its `--frames`/`--encode` path is no longer used by the
studio.

### Eviction

- **Cap:** `STUDIO_CACHE_GB` (default 5).
- **Bookkeeping:** each segment directory's last use is tracked in a small `cache.json` index (atime isn't reliable).
- **Eviction:** when the cap is exceeded, whole least-recently-used segments are evicted. Segments pinned by a running
  final render are never evicted.

## 4. Build, security, testing, cleanup

### Build and run

- **Packages:** one root `package.json`, Bun as package manager. The new dev dependencies are:
  - `vite`, `@vitejs/plugin-react`, `typescript`;
  - `react`, `react-dom`;
  - `@tanstack/react-query`, `@tanstack/react-router`;
  - `tailwindcss` v4 with `@tailwindcss/vite`;
  - shadcn/ui components copied into `studio/web/src/components/ui/`, plus their Radix dependencies;
  - `react-markdown`, `remark-gfm`;
  - `vitest`, `@testing-library/react`, `jsdom`.
- **Scripts:**
  - `bun run studio`: builds `studio/web` when any source file is newer than `studio/web/dist/index.html`, then starts
    the server.
  - `bun run dev`: the server with `--dev` plus the Vite dev server on 5173 (proxying `/api`, `/library`, `/thumbs`,
    `/assets`).
  - `bun run build`: `vite build`.
  - `bun run typecheck`: `tsc --noEmit`, strict.
  - `bun test` (server) and `bun run test:web` (Vitest).
- **Dev mode:**
  - the server accepts Origin `http://localhost:5173` and prints a warning;
  - it writes the per-start token to `<data root>/.studio/dev-token` (mode 600);
  - a Vite plugin injects it into `index.html`;
  - without `--dev`, neither happens.

### Security

- **SPA CSP (UI hosts):** `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:;
  media-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`.
  The Vite build must work without inline scripts.
- **Fonts:** Permanent Marker (Apache 2.0) and Shantell Sans (the weight in use, OFL 1.1) are bundled in
  `assets/fonts/` with their license texts. `studio.html` uses local `@font-face`.
  - Google Fonts is removed from the engine CSP, the render browser's proxy bypass list and the DNS exceptions, so the
    render browser can reach only the studio's port.
  - The user approved downloading the two font files on 2026-09-25.
- **The frame and cache APIs** are UI-host only. The snapshot and blob APIs are renderer-host only, GET only.
- **Unchanged:** the token, the Origin/Host guard, read-only examples, and the Claude sandbox.

### Testing

- **Server (`bun test`):** all existing tests, plus:
  - segment keys (options, `shared.js`, chapter changes, engine hash);
  - CAST dependency recording and invalidation, using the Original's curtain call;
  - snapshot and blob routes (host restrictions);
  - priorities and coalescing;
  - eviction and pinning;
  - a broken segment;
  - a final render from the cache (a short range) and a render reusing a fully cached range (no paints);
  - Delete (API and cascade);
  - dev-mode origin and token handling;
  - the font check.
- **Web (Vitest + Testing Library):**
  - timeline geometry (blocks sized by windows, seek maths);
  - `usePreviewPlayer` scheduling and "safe to play";
  - the `useStudioEvents` reducer;
  - the API client's 403 handling;
  - components: Timeline, Inspector panels, JobsDrawer, dialogs.
- **End to end (Puppeteer on the built app, fake Claude):**
  1. new version → storyboard → approve → nine chapters;
  2. preview plays from the cache (frames arrive, the coverage bar fills);
  3. final render on a short range;
  4. watch view;
  5. Remix of the Original;
  6. Promote (on a temp `default.db` copy);
  7. Delete.
- **Security:** the existing egress tests keep passing. One new test proves no page on UI hosts ever loads version
  code (the SPA never requests `/v/…` scripts).

### Build order (each step leaves a working studio)

1. Bundle the fonts, add the font check, and remove Google Fonts from the render browser, CSP and resolver.
2. Content hashes on revisions, snapshots, and the snapshot and blob routes; the loader loads by snapshot.
3. Frame cache, painting pool, frame service and coverage API, with CAST dependencies and eviction.
4. Final render from the cache.
5. React app scaffold: Vite, TypeScript, Tailwind, shadcn, Router, Query, the API client, events, the SPA CSP, and
   dev mode.
6. Shell: sidebar, header, jobs drawer and log viewer.
7. Workspace: player, timeline, lyrics, render bar, inspector (storyboard and chapter panels).
8. Watch view, library and settings.
9. Dialogs: new version, Remix, Promote, Delete (plus the Delete API).
10. End-to-end tests; remove `studio/ui/`, `watch.html`, `src/watch.js` and the worker mode; update the README.

## Out of scope

- Multi-user, remote access, cloud storage or upload.
- Editing chapter code in the browser.
- Mobile layouts beyond "usable on a narrow window".
- Changing the engine, characters or song timing.
