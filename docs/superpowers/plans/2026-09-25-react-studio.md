# React Studio, Server-Rendered Previews and Frame Cache — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plain-JS studio UI with a redesigned React + TypeScript + Vite app (the timeline workspace), render every preview frame in the sealed headless browser, and keep the frames in a content-addressed 1080p cache shared by previews and final renders.

**Architecture:** The Bun server gains a frame service. A painting pool of sealed headless pages loads version code by content snapshot, paints frames on request by priority, and stores them under segment keys. A final render fills the cache and encodes from it. The React app (built by Vite into `studio/web/dist`, served by Bun on the UI hosts) talks only to the JSON/SSE/frame APIs and never loads version code.

**Tech Stack:**
- **Server:** Bun 1.4 (`Bun.serve`, `bun:sqlite`, `bun test`), puppeteer-core 25, ffmpeg.
- **Web:** Vite, React 19, TypeScript (strict), TanStack Query and TanStack Router, Tailwind CSS v4, shadcn/ui (Radix), react-markdown + remark-gfm.
- **Web tests:** Vitest + Testing Library + jsdom.

**Spec:** [docs/superpowers/specs/2026-09-25-react-studio-design.md](../specs/2026-09-25-react-studio-design.md). Read it before your task; this plan argues from it.

**Plan style:** each task gives exact files, interfaces, behaviour and the tests to write. It does not give every line of code. Follow the surrounding code's style: the server is terse ES modules with comments that explain *why*; the web app is idiomatic React + TypeScript.

## Global Constraints

- Bun is the runtime and package manager (`bun.lock` only). Web dependencies are dev dependencies in the root `package.json`.
- Never touch the user's data:
  - never open the repo's `user.db`, `studio.db`, `.studio/` or `library/`;
  - never write `studio/default.db`;
  - tests use temp data roots (`STUDIO_DATA`), temp `USER_DB`/`DEFAULT_DB` copies and free ports;
  - never use port 8080.
- Never run the real Claude CLI; tests use `test/fake-claude.js` via `CLAUDE_BIN`.
- The frame cache is keyed by content:
  - `engineHash` covers `studio.html`, `src/*.js` (the engine scripts), the p5 and p5.brush lib files, and `assets/fonts/*`;
  - segment key = SHA-256 over (`engineHash`, the options JSON with sorted keys, the `shared.js` sha256 or `-`, the chapter's sha256);
  - frames are 1920×1080 JPEG, quality 0.94, at `<data>/.studio/cache/frames/<segmentKey>/f<frameIndex>.jpg`.
- Frame indices run 0..3758 (`N = Math.ceil(156.6 * 24)`), at 24 fps.
- The painting-pool priority order is preview, then prefetch, then render, then thumbs. `STUDIO_PAINTERS` defaults to 3 and `STUDIO_CACHE_GB` to 5.
- Security:
  - the frame, coverage and cache APIs are served on UI hosts only;
  - the snapshot and blob APIs are served on renderer hosts only, GET only;
  - the SPA CSP is exactly `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
  - chapter code never runs in the user's browser.
- Fonts: Permanent Marker (Apache 2.0) and Shantell Sans at weight 800 (OFL 1.1) are bundled in `assets/fonts/` with their licenses. The user approved downloading them from Google Fonts on 2026-09-25.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

These inputs and conditions are implied by the spec and most likely to bite a real user. Each line names the task that owns its test.

1. **A chapter that throws or never finishes painting** must not wedge the pool or the player. That chapter's segment is marked broken, its timeline block shows the error, playback stops cleanly at the gap, and other chapters keep painting. Tests: Task 3 (pool), Task 7 (player).
2. **Claude revises a chapter while you preview.** Frames for the old key must never be mixed into playback after the change; that chapter's coverage resets and repaints; the other chapters stay cached. Tests: Task 3 (coverage by current snapshot), Task 7 (player drops bitmaps whose segment key changed).
3. **Scrubbing rapidly or jumping between chapters and versions** must supersede older preview requests: no pile-up, bounded queue length, and prefetch never starves the playhead frame. Tests: Task 3 (superseding), Task 7 (player cancels in-flight requests).
4. **The server restarts while the UI is open.** Mutations show "The studio server restarted — reload this page.", the event stream reconnects, and frame requests resume after reload. Tests: Task 5 (client 403 handling), Task 11 (end to end: restart, then the reload banner).
5. **The cache cap is hit during a final render.** Segments pinned by the render are never evicted, the render completes, and eviction then trims least-recently-used unpinned segments. Test: Task 3 (eviction with a pinned segment), Task 4 (render under a tiny cap).

## File Map

| File | Responsibility |
|---|---|
| `assets/fonts/*.woff2`, `assets/fonts/LICENSE-*.txt` | Bundled fonts and their licenses |
| `studio/fonts.css` → served as `/assets/fonts/fonts.css` | `@font-face` rules the engine page links |
| `studio/snapshot.js` | Content hashes, snapshots (compute and id), blob lookup |
| `studio/frames/keys.js` | `engineHash`, `segmentKey`, frame↔chapter mapping |
| `studio/frames/cache.js` | Cache directory layout, index (`cache.json`), coverage, eviction, pinning |
| `studio/frames/pool.js` | The sealed painting browser and pages, priority queue, painting, CAST deps, broken segments |
| `studio/frames/service.js` | Wires the cache and pool to requests; coverage; `frames` events |
| `studio/render-job.js` | Final render from the cache (rewritten) |
| `studio/app.js` | New routes: frames, coverage, cache, snapshot, blob, song, delete version; SPA serving and CSP; dev mode |
| `studio/server.js` | Creates the pool and service; build-on-start; `--dev` |
| `src/loader.js` | Loads a version by snapshot (`?snapshot=`), CAST recording proxy |
| `studio/web/` | The React app (package-less; root `package.json`) |
| `studio/web/index.html`, `vite.config.ts`, `tsconfig.json`, `src/main.tsx`, `src/router.tsx` | Scaffold |
| `studio/web/src/api/{client,types,events}.ts` | API client, types, `useStudioEvents` |
| `studio/web/src/components/ui/*` | shadcn components (copied) |
| `studio/web/src/shell/*` | `AppShell`, `VersionSidebar`, `HeaderBar`, `JobsIndicator`, `JobsDrawer`, `LogViewer`, `HealthBanner`, `SettingsPopover` |
| `studio/web/src/workspace/*` | `Workspace`, `PreviewPlayer`, `usePreviewPlayer`, `Timeline`, `LyricsTrack`, `RenderBar`, `Inspector`, `StoryboardPanel`, `ChapterPanel` |
| `studio/web/src/watch/*`, `studio/web/src/library/*` | `WatchView`, `LibraryGallery` |
| `studio/web/src/dialogs/*` | `NewVersionDialog`, `RemixDialog`, `PromoteDialog`, `DeleteVersionDialog` |
| `test/*.test.js` (server), `studio/web/src/**/*.test.tsx` (Vitest), `test/ui.test.js` (end to end) | Tests |

---

### Task 1: Bundle the fonts, check them, close the Google Fonts exceptions

**Files:**
- Create: `assets/fonts/PermanentMarker-Regular.woff2`, `assets/fonts/ShantellSans-ExtraBold.woff2`, `assets/fonts/LICENSE-PermanentMarker.txt` (Apache 2.0), `assets/fonts/LICENSE-ShantellSans.txt` (OFL 1.1), `assets/fonts/fonts.css`
- Modify: `studio.html`, `src/core.js` (setup font check), `studio/app.js` (studioCsp, serving `/assets/fonts/*`), `studio/browser.js` (drop both fonts hosts from `HOST_RESOLVER_RULES` and the proxy bypass list)
- Test: `test/engine.test.js`, `test/render.test.js`, `test/app.test.js`

**Interfaces:**
- Produces: `/assets/fonts/fonts.css` and the font files, served on UI and renderer hosts (GET, with `Content-Type` set). The engine page sets `window.loadError = 'font not loaded: <family>'` when `document.fonts.check` fails after loading. `render.mjs --check` then fails, as it already does on `loadError`.

- [ ] **Step 1:** Download the two fonts. Fetch `https://fonts.googleapis.com/css2?family=Permanent+Marker&family=Shantell+Sans:wght@800&display=block` with a modern Chrome User-Agent (so it returns woff2), download the latin woff2 URLs it lists, and save them under the file names above. Take the license texts from the fonts' Google Fonts repositories (github.com/google/fonts: `apache/permanentmarker/LICENSE.txt`, `ofl/shantellsans/OFL.txt`). Record the URLs and sizes in the report.
- [ ] **Step 2: failing tests.**
  - `test/engine.test.js`: a studio.html page makes no request to any non-loopback host (collect `page.on('request')` URLs), and `document.fonts.check('100px "Permanent Marker"')` and `check('800 50px "Shantell Sans"')` are both true after `window.ready`.
  - `test/render.test.js`: with `assets/fonts/fonts.css` temporarily unreachable (a test-only env flag `STUDIO_TEST_BREAK_FONTS=1` that makes the server 404 it), `render.mjs --check=load` exits 1 with `font not loaded`.
  - `test/app.test.js`: studioCsp contains neither `fonts.googleapis.com` nor `fonts.gstatic.com`, and `/assets/fonts/fonts.css` is served with `text/css`.
- [ ] **Step 3: implement.**
  - `fonts.css` uses `font-display: block` and local `url()`s.
  - `studio.html` links `/assets/fonts/fonts.css` instead of Google.
  - The CSP gets `font-src 'self'; style-src 'self' 'unsafe-inline'`; drop the unsafe-inline only if the engine doesn't need it.
  - In `core.js` setup, after `document.fonts.load(...)`, assert `document.fonts.check` for both fonts; on failure set `window.loadError`.
  - Remove the fonts hosts from `HOST_RESOLVER_RULES` and from the bypass list in `isolationArgs`.
- [ ] **Step 4:** Run `bun test test/engine.test.js test/render.test.js test/app.test.js`. All pass, and the existing pixel-identity test still passes; the fonts must render identically to the Google versions of the same files. If they don't, report the difference.
- [ ] **Step 5:** Commit: "Bundle the fonts and cut the render browser off from Google Fonts".

### Task 2: Content hashes, snapshots, and loading version code by snapshot

**Files:**
- Create: `studio/snapshot.js`, `test/snapshot.test.js`
- Modify: `studio/db.js` (`sha256` column on revisions, filled on write; backfill for `user.db` at open; an in-memory map for default.db rows lacking it), `studio/app.js` (routes), `src/loader.js` (`?snapshot=`), `render.mjs` (`--snapshot=<id>` as an alternative to `--v`/`--work`)

**Interfaces:**
- Produces, in `studio/snapshot.js`:
  - `sha256(text) → hex`;
  - `snapshotOf(db, versionId) → { id, options, files: { [path]: sha } }`, where `id` = sha256 of canonical JSON (sorted keys) of `{ options, files }`;
  - `rememberSnapshot(snap)` and `getSnapshot(id) → snap | null`, an in-memory LRU of 500;
  - `blobBySha(db, sha) → content | null`, searching the revisions of both databases.
- Produces, in `db.js`: `revisions.sha256`; `db.fileSha(versionId, path) → hex | null`.
- Produces these routes, on renderer hosts only, GET only:
  - `GET /api/snapshot/<id>` → the manifest shape `src/loader.js` expects (`{ id, options, scripts: [...], files: [...] }`, with `scripts` as `/api/blob/<sha>` URLs in load order: `shared.js` first, then the chapters by path);
  - `GET /api/blob/<sha>` → `text/javascript; charset=utf-8`, the renderer-host CSP, nosniff; 404 if unknown.
- Both routes join the renderer-host `/api` allow-list.
- The loader: `studio.html?render&snapshot=<id>` loads that manifest.

- [ ] **Step 1: failing tests** (`test/snapshot.test.js`):
  - same content means the same snapshot id;
  - changing a chapter changes the id and only that file's sha;
  - options order doesn't matter;
  - `blobBySha` finds content in both databases;
  - the backfill fills `sha256` for pre-existing rows;
  - the routes 404 on UI hosts and serve on `w0.localhost`;
  - `/api/blob/<unknown>` gives 404;
  - a painting page loaded by snapshot draws the same pixels as `?v=<id>`: a `render.mjs --stills` comparison between `--snapshot` and `--v` for the Original, byte-identical.
- [ ] **Step 2:** Implement. Keep `?v=` and `?work=` working; Claude checks still use `--work`.
- [ ] **Step 3:** Run `bun test`. Everything passes.
- [ ] **Step 4:** Commit: "Load version code by content snapshot".

### Task 3: Frame cache, painting pool and frame service

**Files:**
- Create: `studio/frames/keys.js`, `studio/frames/cache.js`, `studio/frames/pool.js`, `studio/frames/service.js`, `test/frames-keys.test.js`, `test/frames-cache.test.js`, `test/frames-service.test.js`
- Modify: `src/loader.js` (a CAST recording proxy when `?record-cast`), `src/core.js` (`window.paintAt` returns `{ castReads: [...] }` when recording), `studio/app.js`, `studio/server.js`

**Interfaces:**
- Consumes: `snapshotOf`, `rememberSnapshot`, `getSnapshot` (Task 2); `CHAPTER_WINDOWS` from `studio/storyboard.js`; `launchBrowser({ port })` from `studio/browser.js`.
- Produces, in `keys.js`:
  - `FPS = 24`, `N = 3759`;
  - `chapterOfFrame(i) → 1..9` (by `CHAPTER_WINDOWS`, t = i/24);
  - `framesOfChapter(n) → [first, last]`;
  - `engineHash(root) → hex` (memoised; covers the files in Global Constraints);
  - `segmentKey({ engine, options, sharedSha, chapterSha }) → hex`;
  - `segmentKeys(snapshot, engine) → { 1..9: key }` (a missing chapter maps to `null`).
- Produces, in `cache.js`, `createCache({ dir, capBytes })` with:
  - `has(key, i, currentShas) → boolean` (checks the `deps.json` sidecar against `currentShas`);
  - `path(key, i)`;
  - `put(key, i, jpegBytes, deps)`;
  - `touch(key)`;
  - `pin(key)` / `unpin(key)`;
  - `usedBytes()`;
  - `evict()` (whole least-recently-used unpinned segments until usage ≤ cap);
  - `clear()` (all unpinned);
  - `coverage(keys, currentShas) → ranges`;
  - the index is persisted in `<dir>/cache.json`.
- Produces, in `pool.js`, `createPool({ root, port, baseUrl, painters, onPainted })` with:
  - `request({ versionId, snapshotId, key, frame, prio, currentShas }) → Promise<{ ok, error? }>`;
  - `supersede(versionId, prio)`, which drops queued requests of that version and priority;
  - `stats()`;
  - `close()`.
  - Pages load `studio.html?render&record-cast&snapshot=<id>` on `w0.localhost`, with the same guards as `render.mjs`'s `openPage`. That shared code is moved to `studio/frames/page.js` and imported by both, not duplicated.
  - Each paint is `renderAt` to a JPEG at 0.94, plus the `castReads` mapped to `{ chapterPath: sha }` deps.
- Produces, in `service.js`, `createFrameService({ db, cache, pool, events, root })` with:
  - `frame(versionId, i, prio) → { file } | { pending: Promise } | { broken: error }`;
  - `coverage(versionId) → { total, ranges, broken }`;
  - `prefetch(versionId, from, count)`;
  - `fillForRender(versionId, onProgress) → Promise` (pins the keys);
  - it publishes SSE `frames` `{ versionId, ranges }`, coalesced at most every 500 ms.
- Produces these routes, on UI hosts only:
  - `GET /api/frames/<versionId>/<i>.jpg?prio=preview|prefetch`: 200 with the JPEG, `ETag` set to the segment key and immutable caching; or holds up to 30 s, then 202 with `Retry-After: 1`; 409 `{ error }` for a broken segment; 404 for a chapter that doesn't exist;
  - `GET /api/coverage/<versionId>`;
  - `GET /api/cache` → `{ usedBytes, capBytes }`;
  - `POST /api/cache/clear` (token-guarded).
- `studio/server.js` creates the pool (on the server's own port) and the service, and closes the pool on exit.

- [ ] **Step 1: failing tests, keys** (`test/frames-keys.test.js`):
  - `chapterOfFrame` at window boundaries (frame 552 = 23.0 s → chapter 2; frame 551 → chapter 1; the last frame 3758 → chapter 9);
  - `segmentKey` changes with each input and is stable otherwise;
  - `engineHash` changes when a `src/*.js` byte changes (use a temp copy of the root).
- [ ] **Step 2: failing tests, cache** (`test/frames-cache.test.js`):
  - `put`, `has` and `coverage` ranges;
  - a `deps` mismatch means not cached;
  - eviction removes the least-recently-used whole segments;
  - a pinned segment survives eviction even when the cap is tiny (Review Focus 5);
  - `clear` keeps pinned segments;
  - `cache.json` survives a restart (new `createCache` on the same dir).
- [ ] **Step 3: failing tests, service and pool** (`test/frames-service.test.js`; real sealed browser, temp data root, a small version built in a temp `USER_DB` whose chapters paint quickly):
  - a frame request paints once and is served from the cache after that (only one paint per frame, counted via `pool.stats()`);
  - revising a chapter changes only that chapter's coverage; the other chapters stay cached (Review Focus 2);
  - the Original's curtain call records CAST deps on other chapters, and changing one of those chapters invalidates only the dependent frames;
  - a chapter that throws, and one that loops forever (20 s paint timeout; use a test override of 2 s), mark only their segment broken and don't block other chapters' frames (Review Focus 1);
  - 50 rapid preview requests for different frames of one version, followed by `supersede`, leave at most one queued preview per version and paint the latest first (Review Focus 3);
  - the priority order is honoured (a render-priority backlog doesn't delay a preview request by more than one frame);
  - the routes 404 on renderer hosts;
  - a 202 after the hold timeout;
  - `POST /api/cache/clear` needs the token.
- [ ] **Step 4:** Implement. The pool reuses the render browser flags (dead proxy and so on). Painting is per frame so that preemption happens between frames.
- [ ] **Step 5:** Run `bun test`. Everything passes, including the existing egress tests (the pool pages are sealed the same way).
- [ ] **Step 6:** Commit, as one or more logical commits: "Paint previews in a sealed pool and cache frames by content".

### Task 4: Final render from the cache; renders keep their title

**Files:**
- Modify: `studio/render-job.js` (rewrite `render`; `thumbs` read from the cache), `studio/db.js` (`renders.title`, `renders.logline`, `renders.snapshot_id`; `listRenders` LEFT JOIN with fallback), `studio/app.js` (render job preconditions unchanged)
- Test: `test/render-job.test.js`

**Interfaces:**
- Consumes: `frameService.fillForRender`, `cache.path`, `segmentKeys`, `snapshotOf` (Tasks 2 and 3).
- Produces: a render job with `params.frames='a:b'`, which is still supported for tests. It encodes from cached frames with ffmpeg (a concat demuxer list in frame order; audio offset from `a`) and takes the poster from the cached frame 1872 (78 s), or the middle of the range. Render rows carry `snapshot_id`, `title` and `logline`.

- [ ] **Step 1: failing tests:**
  - a short-range render paints only the missing frames: pre-fill half via the frame API, render the range, and assert the paint count equals the missing count;
  - a render of a fully cached range paints nothing;
  - the MP4 duration matches the range (ffprobe);
  - the render row has `snapshot_id`, `title` and `logline`;
  - with `STUDIO_CACHE_GB` tiny (e.g. 0.001), the render still completes and its segments were pinned (Review Focus 5);
  - after deleting the version row, the render still lists with its stored title;
  - cancelling during the fill stops painting and leaves no library entry.
- [ ] **Step 2:** Implement. Remove the old frames-dir path from `render-job.js`. `render.mjs --frames/--encode` stays for manual command-line use.
- [ ] **Step 3:** Run `bun test`. Everything passes.
- [ ] **Step 4:** Commit: "Build final renders from the frame cache".

### Task 5: React app scaffold, API client, events, SPA serving, CSP and dev mode

**Files:**
- Create: `studio/web/index.html`, `studio/web/vite.config.ts`, `studio/web/tsconfig.json`, `studio/web/src/main.tsx`, `studio/web/src/router.tsx`, `studio/web/src/styles.css` (Tailwind v4 `@import "tailwindcss";` plus theme tokens, dark), `studio/web/src/api/client.ts`, `studio/web/src/api/types.ts`, `studio/web/src/api/events.ts`, `studio/web/src/api/client.test.ts`, `studio/web/src/api/events.test.ts`, `studio/web/components.json` (shadcn config), and the shadcn components you'll need, copied in (button, dialog, dropdown-menu, sheet, tabs, textarea, input, select, checkbox, tooltip, toast/sonner, scroll-area, badge, separator, popover, skeleton)
- Modify: `package.json` (scripts `dev`, `build`, `typecheck`, `test:web`; dev dependencies), `studio/app.js` (serve `studio/web/dist` on UI hosts: `index.html` with the token and the SPA CSP for `/`, `/versions/*`, `/library`; hashed assets with long cache; no more `/ui/*` routes once Task 11 lands, but keep them until then), `studio/server.js` (build if stale; `--dev`: accept Origin `http://localhost:5173`, write `<data>/.studio/dev-token` with mode 600, print a warning), new `GET /api/song` → `{ fps, frames, duration, chapters: CHAPTER_WINDOWS, lyrics: LY }` (read `src/lyrics.js` by evaluating it in a new `Function` scope; it's a trusted repo file)
- Test: `test/app.test.js` (SPA serving, CSP, dev mode), Vitest files

**Interfaces:**
- Produces, in `client.ts`:
  - `api.get<T>(path)`, `api.post<T>(path, body?)`, `api.put<T>(path, body)`, `api.del<T>(path)`, which throw `ApiError { status, message }`;
  - a 403 whose message contains `token` sets a global "restarted" flag, which `HealthBanner` shows;
  - `frameUrl(versionId, i, prio)`.
- Produces, in `types.ts`: `Version`, `Manifest` (incl. `walkthrough`, `storyboardErrors`, `fileRevisions`, `example`), `Job`, `JobWithLog`, `Revision`, `Render`, `Coverage`, `Health`, `Song`, `CacheInfo`.
- Produces, in `events.ts`: `useStudioEvents(queryClient)`, whose event handling is exactly the spec's "Data flow" list; and `applyFramesEvent(prev: Coverage, e) → Coverage` (a pure function, unit-tested).
- Produces the router with the spec's routes, and placeholder route components that later tasks fill in.

- [ ] **Step 1: failing tests:**
  - `test/app.test.js`:
    - `/versions/original` and `/library` return the SPA `index.html` with the token, on UI hosts only (404 on `w0.localhost`), carrying the exact SPA CSP header;
    - hashed assets are served with `immutable`;
    - `--dev` mode accepts Origin `http://localhost:5173`, and without it that origin gets 403;
    - the dev token file is mode 600;
    - `/api/song` returns 9 chapters and all lyric lines of `src/lyrics.js` (count them in the test from the file, don't hard-code) with numeric times.
  - Vitest:
    - `client.test.ts`: the token header is sent, `ApiError` fields are set, and a 403 containing `token` sets the restarted flag (Review Focus 4);
    - `events.test.ts`: `applyFramesEvent` merges overlapping and adjacent ranges; the handler invalidates the right keys for each event type.
- [ ] **Step 2:** Implement.
  - The Vite build must emit no inline scripts. Verify by loading the built `index.html` in the headless browser with the SPA CSP and asserting no CSP violations.
  - `bun run build` outputs to `studio/web/dist`.
- [ ] **Step 3:** Run `bun run typecheck`, `bun run test:web` and `bun test`. All green.
- [ ] **Step 4:** Commit: "Scaffold the React studio app and serve it with a strict CSP".

### Task 6: Shell: sidebar, header, jobs drawer, log viewer, health, settings

**Files:**
- Create: `studio/web/src/shell/AppShell.tsx`, `VersionSidebar.tsx`, `HeaderBar.tsx`, `JobsIndicator.tsx`, `JobsDrawer.tsx`, `LogViewer.tsx`, `HealthBanner.tsx`, `SettingsPopover.tsx`, and tests `*.test.tsx`
- Modify: `studio/web/src/router.tsx`

**Interfaces:**
- Consumes: the API client, types and events (Task 5); the routes `/api/versions`, `/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/cancel|retry`, `/api/health`, `/api/cache`, `/api/cache/clear`.
- Produces:
  - `AppShell` renders the sidebar, header and an `<Outlet/>`;
  - `openJobLog(jobId)` is a context function that other components use to open the log viewer;
  - `useSelectedVersion()` returns the version id from the route.

- [ ] **Step 1: failing Vitest tests:**
  - the sidebar groups examples (with the ★ badge) above "My versions", with stage labels per the spec (`building 6/9` when chapters are in progress);
  - the jobs indicator counts running and queued jobs;
  - the drawer lists jobs newest first, filters this version or all, and shows Cancel only for queued or running jobs and Retry only for failed, cancelled or interrupted ones;
  - the log viewer appends `log` events for its job and auto-scrolls only when the user is already at the bottom;
  - the health banner shows the signed-out message when `claudeSignedIn` is false, and the restarted message after a token 403;
  - the settings popover shows used and cap sizes, and Clear calls the API.
- [ ] **Step 2:** Implement with shadcn components (`Sheet` for the drawer, `Dialog` for the log, `Popover`, `Badge`, `ScrollArea`).
- [ ] **Step 3:** Run `bun run typecheck` and `bun run test:web`. Green.
- [ ] **Step 4:** Commit: "Add the studio shell: versions, jobs, logs, health and cache settings".

### Task 7: Workspace: player, timeline, lyrics, render bar

**Files:**
- Create: `studio/web/src/workspace/Workspace.tsx`, `usePreviewPlayer.ts`, `PreviewPlayer.tsx`, `Timeline.tsx`, `timelineGeometry.ts`, `LyricsTrack.tsx`, `RenderBar.tsx`, with tests
- Modify: `studio/web/src/router.tsx`

**Interfaces:**
- Consumes: `/api/song`, `/api/versions/:id`, `/api/coverage/:id`, `frameUrl`, the `frames` events, `/api/jobs?version=`, `/api/library`, and `POST /api/jobs {kind:'render'}`.
- Produces:
  - `timelineGeometry(chapters, width) → blocks[]` and `xToTime` / `timeToX`, as pure functions;
  - `usePreviewPlayer({ versionId, song, coverage, segmentKeys }) → { state: 'paused'|'waiting'|'playing', time, play(), pause(), seek(t), playNow(), safeIn: seconds|null, aheadReady: seconds }`;
  - the playhead time and selected chapter are synced to the URL search params `t` and `ch`.
- The server must expose segment keys per chapter so the player can tell when a chapter's frames change. Add `segments: { 1..9: key|null }` to `/api/coverage/:id`, and write that server change with its test in `test/frames-service.test.js`.

- [ ] **Step 1: failing tests:**
  - `timelineGeometry` gives block widths proportional to windows that sum to the width, and `xToTime(timeToX(t)) ≈ t`.
  - `usePreviewPlayer`, with fake timers, a fake audio element and a fetch mock:
    - it requests frames ahead of the playhead, at most 6 in flight;
    - it cancels in-flight preview requests on a seek, using an AbortController (Review Focus 3);
    - it never draws a frame from an old segment key after `segments[n]` changes (Review Focus 2);
    - it stops at a gap when playing via Play now and resumes when the frame arrives;
    - with a broken segment it shows the error state and doesn't retry in a loop (Review Focus 1);
    - "safe to play" becomes true when the remaining frames are cached.
  - Timeline:
    - clicking a block navigates to `?ch=n&t=start`;
    - coverage ranges render as shaded spans;
    - a chapter with a running chapter job shows the working indicator;
    - a broken chapter shows its error in a tooltip.
  - RenderBar is disabled with the reason "needs all 9 chapters" or "a render is running".
- [ ] **Step 2:** Implement. Draw frames onto a `<canvas>` from `ImageBitmap`s. Audio is the song (`/assets/pdoom.mp3`), and picture syncs to `audio.currentTime`. Full screen uses the Fullscreen API on the player container.
- [ ] **Step 3:** Run typecheck, `test:web` and `bun test`. Green.
- [ ] **Step 4:** Commit: "Add the timeline workspace with server-rendered previews".

### Task 8: Inspector: storyboard and chapter panels

**Files:**
- Create: `studio/web/src/workspace/Inspector.tsx`, `StoryboardPanel.tsx`, `ChapterPanel.tsx`, `storyboardSections.ts`, with tests

**Interfaces:**
- Consumes: `/api/versions/:id` (manifest), `/v/:id/STORYBOARD.md` (raw text; it's served on UI hosts too, as today), `PUT /api/versions/:id/files/STORYBOARD.md`, `PUT /api/versions/:id` (concept, options), `POST /api/jobs` (kinds storyboard and chapter, with `params.feedback` and `model`), `POST /api/versions/:id/approve`, `/api/versions/:id/revisions?path=`, `POST /api/revisions/:rid/restore`, `/api/jobs?version=`.
- Produces: `storyboardSection(markdown, n) → string`, the chapter-`n` section from its `## n ·` heading up to the next `## ` heading (pure, tested).

- [ ] **Step 1: failing tests:**
  - `storyboardSection` handles the Original's legacy headings (`## 1 · The Lab (1.5–23) · …`) and the studio format;
  - with no chapter selected, the StoryboardPanel shows the markdown (tables render; raw `<script>` in the markdown is not executed or inserted as HTML), Edit, Ask for changes and Approve (Approve prominent in the "storyboard to review" stage, disabled otherwise), the concept with Redraft, and the option toggles;
  - examples show none of the editing controls and show "Remix";
  - the ChapterPanel shows that chapter's section, the feedback box and Revise (disabled while a job for this chapter is queued or running), and the history with Restore on non-current revisions, plus this chapter's jobs;
  - every mutation disables its button while in flight.
- [ ] **Step 2:** Implement with react-markdown + remark-gfm (raw HTML disabled), and a model select (CLI default, Opus, Sonnet, Haiku).
- [ ] **Step 3:** Run typecheck and `test:web`. Green.
- [ ] **Step 4:** Commit: "Add the inspector: storyboard review and chapter revisions".

### Task 9: Watch view and library

**Files:**
- Create: `studio/web/src/watch/WatchView.tsx`, `studio/web/src/library/LibraryGallery.tsx`, with tests
- Modify: `studio/app.js`: `DELETE /api/library/:rid` already exists. Also add `GET /api/versions/:id/renders`, or filter `/api/library` client-side; client-side filtering is simpler.

**Interfaces:**
- Consumes: `/api/library`, `/api/versions/:id`, `/api/versions/:id/history`, `/api/jobs?version=`, and `/library/<file>` (MP4 and poster).

- [ ] **Step 1: failing tests:**
  - WatchView highlights the walkthrough chapter for the video's `currentTime` and seeks when a chapter is clicked;
  - "How it was made" shows the concept, the revision count, feedback notes (claude and manual revisions with notes that aren't `"<kind> job"`), the Claude cost sum and the render date;
  - older renders are linked;
  - a render whose version was deleted still shows its stored title;
  - LibraryGallery shows the latest render per version first, and delete asks for confirmation.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run typecheck and `test:web`. Green.
- [ ] **Step 4:** Commit: "Add the watch view and the library".

### Task 10: Dialogs: new version, Remix, Promote, Delete (with the Delete API)

**Files:**
- Create: `studio/web/src/dialogs/NewVersionDialog.tsx`, `RemixDialog.tsx`, `PromoteDialog.tsx`, `DeleteVersionDialog.tsx`, `slug.ts`, with tests
- Modify: `studio/db.js` (`deleteVersion(id, { videos })`), `studio/app.js` (`DELETE /api/versions/:id?videos=0|1`, token-guarded), `studio/frames/cache.js` (unpinned references can simply age out; there's no explicit per-version index to clean)
- Test: `test/db.test.js`, `test/app.test.js`

**Interfaces:**
- Produces: `db.deleteVersion(id, { videos: boolean }) → { deletedRenders: string[] }`. It refuses examples (`examples are read-only — remix it first`) and refuses while the version has queued or running jobs (409). It deletes versions, files, revisions and jobs; renders are deleted with their files only when `videos` is set. The API returns 200 `{ ok: true }` and publishes `version` and `library` events.

- [ ] **Step 1: failing tests:**
  - db and API: a delete cascades; `videos=0` keeps the render rows and MP4 files (they still list with their title); `videos=1` removes them; examples give 403; a running job gives 409;
  - Vitest:
    - `slug` derives an id from the title the same way as the server's id rule (`^[a-z0-9][a-z0-9-]{0,40}$`);
    - NewVersionDialog creates the version and queues the storyboard job, then navigates;
    - RemixDialog handles a 409 id clash with an inline error;
    - PromoteDialog shows the commit explanation and is disabled while Claude jobs are queued or running;
    - DeleteVersionDialog requires typing the version title to confirm and passes `videos` from the checkbox.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run typecheck, `test:web` and `bun test`. Green.
- [ ] **Step 4:** Commit: "Add new-version, Remix, Promote and Delete".

### Task 11: End-to-end tests, remove the old UI, README

**Files:**
- Rewrite: `test/ui.test.js` (against the React app)
- Delete: `studio/ui/`, `watch.html`, `src/watch.js`; the `workerMode` path in `src/core.js`; and the `?worker` handling, `/ui/*` routes and `watch.html` serving in `studio/app.js`
- Modify: `README.md`, `ANIMATION_GUIDE.md` (if it mentions the old UI)

- [ ] **Step 1:** Rewrite `test/ui.test.js`. It runs the built app with the server (`--port=0`, temp data root, a temp `DEFAULT_DB` copy, the fake Claude) and uses Puppeteer:
  1. create a new version, see the storyboard, approve it, see all nine chapter blocks become ready;
  2. play the preview until frames arrive and the coverage shading grows;
  3. run a final render on a short range (`params.frames` via the API) and see it in the library and the watch view;
  4. remix the Original, promote the new version (the dialog is accepted), delete a version;
  5. assert that during the whole run the browser never requested `/v/<id>/…*.js` or loaded any script except `/assets/…` Vite chunks (proof that chapter code never runs in the user's browser);
  6. restart the server mid-session, then trigger a mutation and see the restarted banner (Review Focus 4).
- [ ] **Step 2:** Delete the old UI and worker mode. Grep for leftovers (`studio/ui`, `watch.html`, `workerMode`, `?worker`).
- [ ] **Step 3:** Update the README: `bun run studio`, `bun run dev`, the timeline workspace, previews and the frame cache (5 GB cap, `STUDIO_CACHE_GB`), Remix, Promote and Delete in the UI, and the fonts bundled with licenses.
- [ ] **Step 4:** Run the full `bun test`, `bun run test:web` and `bun run typecheck`. All green. `studio/default.db` is unchanged.
- [ ] **Step 5:** Commit: "Replace the old UI with the React studio".
