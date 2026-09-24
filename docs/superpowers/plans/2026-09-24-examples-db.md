# Examples database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the studio's storage into a git-tracked `default.db` of example versions (the Original, plus versions the user promotes) and a git-ignored `user.db` for the user's own work, and remove the now-duplicated files from the repo.

**Architecture:** The server opens `user.db` and attaches `default.db` read-only. Version, file and revision reads span both databases; every write goes to `user.db`, except Promote, which briefly opens `default.db` for writing. Examples are read-only in the studio: they can be previewed, rendered and remixed into the user's database.

**Tech Stack:** Bun 1.4 (`bun:sqlite`, `bun test`), the existing studio (`studio/*.js`, `studio/ui/*`), `render.mjs`.

**Spec:** [docs/superpowers/specs/2026-09-24-studio-design.md](../specs/2026-09-24-studio-design.md), amended by the design below. The user approved this design in chat on 2026-09-24.

## Design (approved)

- **`studio/default.db`**: tracked in git. It holds example versions with their files and revision history: at first only the Original. The server opens it read-only, so running the studio never modifies it. It uses rollback-journal mode (not WAL), so read-only use creates no `-wal`/`-shm` files next to it.
- **`user.db`**: in the repo root, git-ignored. It holds the user's versions, their files and revisions, and all jobs, logs and renders.
- **Read-only examples.** Examples appear in the version list with an "Example" badge. They can be previewed, final-rendered and thumbnailed. They can't be edited, approved, revised or have files restored.
- **Remix** copies an example's current files into `user.db` as a new version with a new id. Its revisions have source `remix` and the note `remixed from <id>`.
- **Promote** moves a user version into `default.db`: its current files, title, logline, concept, options and status, with a single revision per file (source `promote`). It is then deleted from `user.db`. The version id must not exist in `default.db`. Jobs and renders that reference the id keep working, because the id now resolves to the example. The user commits `default.db` afterwards.
- **Version ids are unique across both databases.** Creating or remixing to an id that exists in either database is refused.
- **Revision ids are unique across both databases.** Example revisions use ids from 1,000,000,000 upward, so `GET /api/revisions/<id>` and `restore` are never ambiguous.
- **Migration, automatic on server start:** if `studio.db` exists and `user.db` doesn't:
  1. Checkpoint `studio.db` and rename it (with any `-wal`/`-shm`) to `user.db`.
  2. Delete the `original` version's files and revisions from it (the Original now lives in `default.db`). Its jobs and renders rows stay.
  3. Print one line saying what happened.
- **Reference material for Claude:** the Original's `STORYBOARD.md` and chapter files leave the repo. Each Claude job's work folder gets them as read-only reference, exported from `default.db` to `reference/original/STORYBOARD.md` and `reference/original/ch/*.js`. They are never imported, because `reference/` paths aren't valid version paths. The prompts point there.
- **Repo cleanup:**
  - Delete `src/ch/`, the root `STORYBOARD.md`, `studio/original-walkthrough.json`, `legacy/` and `pnpm-lock.yaml`. `bun.lock` is the only lockfile.
  - Update `ANIMATION_GUIDE.md` and `README.md` to match. The shared engine stays in `src/` as files.

## Global Constraints

- No new npm dependencies. No frontend build step.
- `studio/default.db` must never be modified by starting the server, running jobs, or running `bun test`. Only Promote and the one-time build script write it.
- Tests use temporary databases, never the repo's `user.db`, `studio.db` or `studio/default.db`. The exceptions are read-only checks of `studio/default.db`.
- The user runs their own studio server on port 8080 against the repo's `studio.db`. Never stop it and never use port 8080.
- `.gitignore`: add `user.db*` and `studio/default.db-*`, and keep `studio.db*` (for the old file until it's migrated).
- Commits end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

---

### Task 0: Lock down the render browser's network, and fix the retry fallback

Carried over from the studio plan's final review (Ruling 13 in that plan's ledger). Chapter code runs in the engine page
(`studio.html` on `w<n>.localhost`). The page's CSP blocks fetch, XHR and subresources, but not top-level navigation,
`window.open`, form submission or WebRTC. So during a sandboxed render, chapter code could still send out data it can see.

**Files:** `render.mjs`, `studio/browser.js`, `studio/app.js`, `studio/queue.js`, tests (`test/render.test.js`, `test/app.test.js`, `test/queue.test.js`).

**Requirements:**
- [ ] In `render.mjs`'s `openPage`, turn on request interception. Abort every request whose origin isn't the page's own
  origin, except `https://fonts.googleapis.com` and `https://fonts.gstatic.com`; this includes top-level navigations away.
  Close any new target (popup) the page opens.
- [ ] `launchBrowser` adds `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` and `--webrtc-ip-handling-policy=disable_non_proxied_udp`.
- [ ] The `studio.html` CSP adds `form-action 'none'` and `base-uri 'none'`.
- [ ] On `w<n>.localhost` hosts, `/api/*` answers 404 except `GET /api/versions/<id>` and `GET /api/work/<id>`, the only
  endpoints `src/loader.js` needs.
- [ ] `queue.retry`: when `params.after` points at a job that can no longer finish and there is no `shared.js`, fall back
  to the newest shared job of that version in any status, so retrying that shared job again frees the chapter. Add a test
  for the review's scenario: S1 fails, chapters cancelled, S1 retried as S2, S2 fails, chapter retried, S2 retried as S3,
  S3 done → the chapter runs.
- [ ] Tests:
  - A render test with a chapter that tries `location.href = 'http://example.com/?x=1'`, a `fetch` to an external host,
    and `window.open`. The render still completes, and a local capture server listening on a second loopback port as a
    stand-in external host receives nothing. Use a `127.0.0.2` or `localhost:<other port>` target that counts as a
    different origin.
  - App tests for the `/api` restriction on worker hosts.

---

### Task 1: Store over two databases, and build default.db

**Files:** `studio/db.js` (and tests), new `studio/build-default.js`, new `studio/default.db` (built and committed), `test/db.test.js`, `.gitignore`.

**Requirements:**
- [ ] `openDb(userPath, { defaultPath })` opens `user.db` (created if missing) and attaches `defaultPath` read-only as schema `def` when the file exists. Without `defaultPath`, it behaves exactly as today, and all existing tests must keep passing.
- [ ] Reads span both databases:
  - Every `Version` gains `example: boolean`.
  - `getVersion` and `listVersions` cover both; examples are listed first, then the user's versions by `created_at`.
  - `getFile`, `listFiles`, `history`, `getRevision` and `listRenders` resolve a version's files and revisions from whichever database holds that version.
  - `listRenders` still returns each render's title and logline.
- [ ] Writes guard examples:
  - `createVersion` throws `version id already exists: <id>` if the id exists in either database.
  - `writeFiles`, `updateVersion` and `restore` on an example throw `examples are read-only`.
  - Jobs and renders are always written to `user.db`.
- [ ] `remixVersion(fromId, { id, title })`:
  - Copies the source's current files and metadata into `user.db` as a new version, with revisions of source `remix` and note `remixed from <fromId>`.
  - The new version's status is `ready` if all 9 chapters exist, otherwise the source's status.
- [ ] `promoteVersion(id)`:
  - Refuses if the version is an example, or if `default.db` doesn't exist.
  - Opens `default.db` writable in a separate connection. Writes the version's metadata, its current files and one revision per file (source `promote`, ids ≥ 1,000,000,000) in one transaction.
  - Then deletes the version and its files and revisions from `user.db`, in one transaction.
- [ ] `studio/build-default.js <out.db>`: creates a fresh `default.db` in rollback-journal mode, with the schema and the Original, from the repo's current `STORYBOARD.md`, `studio/original-walkthrough.json` and `src/ch/*.js`. It uses the same title, logline, concept, status `ready` and revision note as today's `importOriginal`, but revision ids start at 1,000,000,000. Run it to create `studio/default.db` and commit that file.
- [ ] Tests (in `test/db.test.js`, using temp files):
  - union listing and the `example` flag;
  - the read-only guards;
  - an id clash across the databases;
  - remix, then promote, then listing;
  - revision ids of examples are ≥ 1e9 and `getRevision` resolves them;
  - opening with `defaultPath` never modifies the default file (compare its bytes and mtime before and after), and creates no `-wal`/`-shm` next to it.

### Task 2: Server, API and renderer use both databases; migration

**Files:** `studio/server.js`, `studio/app.js`, `studio/versions.js`, `render.mjs`, `studio/lock.js` (lock on `user.db`), new `studio/migrate.js`, tests (`test/app.test.js`, `test/server.test.js`, `test/versions.test.js`, `test/render.test.js`, a new `test/migrate.test.js`).

**Requirements:**
- [ ] **Server:** `studio/server.js` uses `USER_DB` (default `<root>/user.db`) and `DEFAULT_DB` (default `<root>/studio/default.db`) environment variables; `STUDIO_DB` is accepted as an alias for `USER_DB`. It runs the migration first, then takes the lock on the user database. It no longer calls `importOriginal`.
- [ ] **`studio/migrate.js`:** `migrateLegacyDb(root, { userPath })` implements the migration exactly as in the design. It prints `Moved studio.db to user.db (the Original now comes from studio/default.db).` It does nothing if `user.db` exists or `studio.db` doesn't.
- [ ] **`render.mjs`:** its in-process server opens the same pair (user `<root>/user.db` falling back to `<root>/studio.db` before migration, plus default `studio/default.db`) without migrating. The `--v=original` default keeps working.
- [ ] **API:**
  - `GET /api/versions` and `/api/versions/<id>` include `example`.
  - Changing an example returns 403 `examples are read-only — remix it first`. That covers: the storyboard PUT, the version PUT, approve, restore of an example revision, and `POST /api/jobs` with kind storyboard, shared or chapter.
  - Render and thumbs jobs are allowed on examples.
  - New `POST /api/versions/<id>/remix` with body `{ id, title }` → 201 with the new version, 409 on an id clash.
  - New `POST /api/versions/<id>/promote` → 200, or 409 with the reason.
  - Both new endpoints publish `version` events.
- [ ] **Remove `importOriginal`** and its callers. `versions.js` keeps the manifest helpers.
- [ ] **Tests:**
  - Update the existing tests that relied on `importOriginal`. They now copy `studio/default.db` to a temp file (once per test file) and pass the copy in, so they keep working after Task 4 removes the source files.
  - Add API tests for the read-only guards, remix and promote.
  - Add a migration test: a temp `studio.db` holding the Original plus one user version and a job becomes `user.db`, without the Original's files and revisions and with everything else intact.
  - Server test: a second server on the same `USER_DB` is still refused.

### Task 3: UI for examples

**Files:** `studio/ui/create.js`, `studio/ui/play.js` (only if needed), `studio/ui/style.css`, `test/ui.test.js`.

**Requirements:**
- [ ] **Version list:** examples show an "Example" badge (class `badge`) and are listed under an "Examples" heading, above "My versions".
- [ ] **Example workspace (read-only):**
  - Shows the storyboard, tiles, previews, history and final render.
  - Hides or disables: concept editing, Draft storyboard, Approve, Edit text, Ask for changes, Revise chapter and Restore buttons.
  - Shows a **Remix** button (id `remix`). It asks for a new title with `prompt()`, derives the id with the existing `slug()`, calls the remix API, then navigates to the new version.
- [ ] **User version workspace:** a **Promote to examples** button (id `promote`). It uses `confirm()` with the text "Move this version into studio/default.db as an example? It becomes read-only here, and you commit studio/default.db to share it." It then calls the promote API and stays on the (now example) version.
- [ ] **Test:** extend `test/ui.test.js`'s create test. After the nine chapters are done, the new version is promoted (accept the confirm dialog with puppeteer's `page.on('dialog')`). Its workspace then shows the Example badge and the Remix button, and no `#approve`. The test uses temp databases: it passes a temp `DEFAULT_DB` (a copy of `studio/default.db`) so the repo file is never written.

### Task 4: Reference material for Claude, and repo cleanup

**Files:** `studio/claude-job.js`, `studio/prompts.js`, `test/claude-job.test.js`, `ANIMATION_GUIDE.md`, `README.md`, `.gitignore`; deletions: `src/ch/`, `STORYBOARD.md`, `studio/original-walkthrough.json`, `legacy/`, `pnpm-lock.yaml`.

**Requirements:**
- [ ] **Reference files:** every Claude job's work folder gets `reference/original/STORYBOARD.md` and `reference/original/ch/<file>.js`, exported from the `original` version (whichever database holds it). If no `original` version exists, skip them silently.
- [ ] **Never imported:** `readWorkFiles` already ignores `reference/`. Add a test proving a job that edits a reference file imports nothing from it and logs it under "Ignored changes" only if the path is a valid version path. For `reference/…` it's simply not listed.
- [ ] **Prompts:** in `studio/prompts.js`, point to `reference/original/` (inside the work folder) instead of `${root}/src/ch/` and `${root}/STORYBOARD.md`, and state that it's read-only reference material.
- [ ] **Guide:** `ANIMATION_GUIDE.md` says chapters live in versions (a version's `ch/c0N.js`), not `src/ch/`. It points to `reference/original/` for the Original's code. The code example header becomes `// ch/c03.js`.
- [ ] **Deletions:** `studio/build-default.js` needs `src/ch/`, `STORYBOARD.md` and `studio/original-walkthrough.json`, so do this after Task 1's `default.db` is committed. Change the build script to take its input from an existing database's `original` version, or from an `--from-files <dir>` layout. Simplest: have it copy the `original` version from an existing default database (`--from <db>`), and document that the Original's source now lives in `studio/default.db`. Then delete the files.
  - Delete `legacy/`, and the untracked `pnpm-lock.yaml` (a plain `rm`, it isn't tracked).
- [ ] **README:**
  - Remove the `legacy/` and `src/ch/` rows, and the "First generation (legacy/)" link text (keep the sentence, without a link).
  - The `STORYBOARD.md` row becomes `studio/default.db`: "Example versions, starting with the original video (its storyboard and chapters)".
  - Explain `user.db` versus `default.db`, Remix and Promote, and that promoting means committing `studio/default.db`.
- [ ] **Gitignore:** `.gitignore` gets `user.db*` and `studio/default.db-*`.
- [ ] **Verify:**
  - `bun test` passes.
  - `git status` shows `studio/default.db` unchanged after the full test run.
