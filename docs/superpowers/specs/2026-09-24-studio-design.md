# P(doom) Studio: design

Status: approved in brainstorming, 2026-09-24. Covers sub-projects 1 (multi-version engine) and 2 (studio app).
Sub-project 3 (the five new versions) uses the studio and is planned separately after it exists.

## Goal

One local web app where you can:

- **Create** new versions of the music video: same song, same characters (Clawd, the Researcher, the troupe),
  new story. You describe a concept, Claude drafts a storyboard, you review it, Claude builds the chapters, you
  give per-chapter feedback, and you start a final render.
- **Play** finished renders: a gallery of versions, and a watch page with the video beside a walkthrough that
  follows playback.

Planned versions: cooking show, nature documentary, video game, space opera, road trip, plus any the user imagines
later. The original stays unchanged and becomes one version among many.

## Decisions

| Topic | Decision |
|---|---|
| Runtime | Bun replaces Node for the server, the renderer and tests (Puppeteer and `bun:sqlite` verified under Bun 1.4.2). |
| Storage | One SQLite file, `studio.db`, holds versions, their files, the revision history, jobs and the library index. |
| Stays on disk | The shared engine (`src/*.js`, the same for every version) and final MP4s in `library/` (large, streamed with seeking). |
| Creating content | The studio runs the Claude Code CLI headless (`claude -p`), staged with review points. |
| Renders | Saved to local disk only. |
| UI | Separate **Create** and **Play** tabs. The watch page puts the walkthrough beside the video, synced to playback. |
| Frontend | Plain HTML and JavaScript, no build step, like the existing `studio.html` and `watch.html`. |

## 1. Multi-version engine

### What a version is

A version is a set of files stored in the database:

| Path | Required | Purpose |
|---|---|---|
| `STORYBOARD.md` | yes | The plan: idea, cast, the nine chapters and their shots, and one walkthrough blurb per chapter. |
| `shared.js` | no | Sets, props and extra characters that only this version uses (e.g. the kitchen). Loaded before its chapters. |
| `ch/c01_<name>.js` … `ch/c09_<name>.js` | yes | The chapters. |

Plus metadata in the `versions` row: id (slug), title, logline, concept text, engine options, status.

**Storyboard format** (so the server can read it without guessing):

- It opens with a front-matter block that the server parses:
  ```
  ---
  title: The P(doom) Bake-Off
  logline: Clawd and the Researcher bake a superintelligence. It rises.
  ---
  ```
- Each chapter is a heading, `## <n> · <name> (<start>–<end>)`, followed by one line starting `Walkthrough:`. That
  line is the blurb the watch page shows, and the free-form shot plan follows it.
- A storyboard job whose output doesn't match this format fails validation, with the same single automatic fix
  attempt as code.
- The original's storyboard predates this format. On import, its title and logline are set by hand, and its
  walkthrough blurbs are written once and stored with the version (a `walkthrough.json` file).

### Rules

- **The shared engine is read-only for versions.** `src/core.js`, `clawd.js`, `cast.js`, `props.js`, `timeline.js`
  and `lyrics.js` serve every version. A version only adds its own files, so one version can never break another.
- **The chapter contract is unchanged:** `chapter(name, start, end, shots)`, each shot a pure function of `t`,
  no `Math.random()` (see [ANIMATION_GUIDE.md](../../../ANIMATION_GUIDE.md)).
- **The song fixes the chapter windows** for every version:
  0–23 · 23–38.5 · 38.5–59 · 59–73 · 73–95.4 · 95.4–109.4 · 109.4–123.5 · 123.5–140.5 · 140.5–156.6.
  Lyric timings and karaoke are shared as well.
- **Engine options** (in the version's metadata, defaults match the original):
  - `wipes` (bool): the brush wipes at 1.5, 38.5, 73.0 and 109.4 s.
  - `cornerMeter` (bool): the small P(doom) meter during the chorus windows.
- **The original** is imported on first start from `src/ch/*.js` and `STORYBOARD.md` (id `original`). The repo files
  stay in place as the upstream copy.

### Loading a version

- The server serves a version's files from the database at `/v/<id>/<path>` (e.g. `/v/cooking-show/ch/c03_rising.js`),
  and its manifest at `/api/versions/<id>` (metadata plus the ordered file list).
- `studio.html?v=<id>` fetches the manifest, applies the engine options, then loads `shared.js` and the chapters in
  order before it reports ready. Without `?v`, it loads `original`.
- A job's work folder can also be loaded, for the pre-import checks: `studio.html?work=<job-id>` reads the files
  from that job's folder instead of the database.
- `watch.html?v=<id>` passes the version on to its background renderers.
- `render.mjs --v=<id>` loads pages from the studio server over http instead of file://. If no server is running, it
  starts one in-process on a free port.

## 2. Studio server

`bun run studio` starts `studio/server.js` at http://localhost:8080.

### What it serves

- The pages: `/` (studio shell with the Create and Play tabs), `studio.html`, `watch.html`, the engine, and
  `node_modules` for p5 and p5.brush.
- Version files and manifests from the database (above).
- Library MP4s at `/library/<render-id>.mp4`, with HTTP Range support so the video can seek.
- A JSON API and a server-sent-events stream, `/api/events`, for job progress and status changes.
- The `w0.localhost`, `w1.localhost`, … origins for the background preview renderers, on the same port.

### Security

- Listens on 127.0.0.1 and ::1 only.
- Generates a random token at every start and embeds it in the studio shell page. Other origins can't read that
  page, so they can't learn the token.
- Every state-changing request (POST, PUT, DELETE) must send the token in an `X-Studio-Token` header. The custom
  header also forces a CORS preflight, which the server never approves for other origins.
- The server checks that the `Origin` header is the studio's own origin, and rejects requests whose `Host` header
  isn't `localhost:<port>`, `127.0.0.1:<port>`, `[::1]:<port>` or `w<n>.localhost:<port>`. The Host check blocks
  DNS rebinding.
- Static file serving keeps the path containment and symlink resolution from `serve.mjs`.

### Data model (`studio.db`)

```sql
versions  (id TEXT PRIMARY KEY, title TEXT, logline TEXT, concept TEXT, options TEXT /* JSON */,
           status TEXT /* concept|storyboard|approved|chapters|ready */, created_at, updated_at)
files     (version_id TEXT, path TEXT, content TEXT, revision_id INTEGER, PRIMARY KEY (version_id, path))
revisions (id INTEGER PRIMARY KEY, version_id TEXT, path TEXT, content TEXT, job_id INTEGER,
           source TEXT /* import|claude|manual|restore */, note TEXT /* feedback or edit summary */, created_at)
jobs      (id INTEGER PRIMARY KEY, kind TEXT, version_id TEXT, params TEXT /* JSON */,
           status TEXT /* queued|running|done|failed|cancelled|interrupted */, progress REAL,
           log TEXT, cost_usd REAL, model TEXT, error TEXT, created_at, started_at, finished_at)
renders   (id INTEGER PRIMARY KEY, version_id TEXT, file TEXT, revision_ids TEXT /* JSON snapshot */,
           duration_s REAL, render_s REAL, size_bytes INTEGER, poster TEXT, created_at)
```

- `files` is the current state, and `revisions` is the full history. Each change writes a revision and updates
  `files` in one transaction.
- Restoring a revision writes a new revision (source `restore`) with the old content, so history is never lost.
- A render stores the revision ids it was made from, so each library entry knows exactly what it shows.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/versions` | List versions with status and latest render. |
| GET | `/api/versions/<id>` | Manifest: metadata, options and ordered file list. |
| POST | `/api/versions` | Create a version from a concept (id, title, concept). |
| PUT | `/api/versions/<id>/files/<path>` | Manual edit (the storyboard text). Writes a revision. |
| GET | `/api/versions/<id>/revisions?path=` | History of one file. |
| POST | `/api/revisions/<rid>/restore` | Restore a revision. |
| POST | `/api/versions/<id>/approve` | Approve the storyboard: queues the shared-setup job and the nine chapter jobs. |
| POST | `/api/jobs` | Queue a job (kind, version, params: feedback, model). |
| POST | `/api/jobs/<jid>/cancel` · `/retry` | Cancel or retry a job. |
| GET | `/api/jobs?version=` | Jobs, with logs. |
| GET | `/api/library` · DELETE `/api/library/<rid>` | Finished renders. |
| GET | `/api/events` | Server-sent events: job progress, status and new revisions. |
| GET | `/api/health` | Whether the Claude CLI and ffmpeg are available, and whether Claude is signed in. |

## 3. Jobs

Jobs are queued in the database and run in two lanes that work side by side:

- **Claude lane:** up to 3 jobs at once.
- **Render lane:** one job at a time, since renders share the GPU.

| Kind | Input | Output |
|---|---|---|
| `storyboard` | the concept, and feedback if this is a revision | `STORYBOARD.md` (with walkthrough blurbs), title, logline |
| `shared` | the approved storyboard | `shared.js`, or nothing if the version doesn't need one |
| `chapter` | the storyboard, `shared.js`, chapter number, and feedback if this is a revision | `ch/c0N_<name>.js` |
| `render` | version id | an MP4 in `library/`, plus a `renders` row with a poster frame |

Approving a storyboard queues `shared` first, then the nine `chapter` jobs, which wait for it.

### How a Claude job runs

1. The server writes the version's current files into `.studio/work/<job-id>/`, along with a brief
   (`TASK.md`) holding the job's instructions, the chapter window, the feedback, and a pointer to the animation
   guide and the shared engine.
2. It runs `claude -p <prompt> --output-format stream-json --verbose --model <model>` with the work folder as the
   working directory. A generated settings file sets the permissions:
   - Read, Glob and Grep across the project.
   - Write and Edit only inside the work folder.
   - Bash only for `bun render.mjs --work=<job-id> --sheet=…`, which renders contact sheets of the work folder so
     Claude can check its chapter visually.
   - No web or network tools.
3. The server parses the stream into the job log and progress, and takes the cost (`total_cost_usd`) from the
   final result.
4. **Validation before import** (chapter and shared jobs): the server loads `studio.html?work=<job-id>` in headless
   Chrome and renders the start, middle and end of the chapter. On a page error or a blank frame, it sends the error
   to Claude for **one** automatic fix attempt. If that also fails, the job fails with the error shown and nothing
   is imported.
5. On success, every changed file in the work folder becomes a new revision (source `claude`, note = the feedback)
   in one transaction. Then the work folder is deleted.
6. On failure or cancel, nothing is imported. The work folder is kept for the failed job's log view until you retry
   or dismiss it.

### Render job

- Runs `bun render.mjs --v=<id> --frames=0:156.6 --workers=4 --frames-dir=.studio/frames/<id>`, then
  `--encode --out=library/<id>-<timestamp>.mp4`.
- Progress comes from the renderer's output.
- Frames are deleted after a successful encode. A retry resumes from the frames already there.
- Saves a poster frame (a JPEG from mid-song) next to the MP4.

### Restarts

On start, the server marks any job that was `running` as `interrupted` and offers a one-click retry. Render retries
resume from their frames.

## 4. The UI

A studio shell at `/` with two tabs.

### Create

- **Left:** the version list, with status (e.g. "chapters 6/9", "storyboard", "queued"), and "+ New version".
- **Main:** a workspace for the selected version, with four steps across the top.
  1. **Concept:** title, concept text, a model picker (defaults to the CLI's default model), and "Draft
     storyboard".
  2. **Storyboard:** the rendered `STORYBOARD.md`, with Approve, "Edit text" (a manual edit, saved as a revision)
     and a feedback box ("Ask for changes", which runs a storyboard revision job).
  3. **Chapters:** nine tiles, each with a thumbnail strip once it exists. Clicking a tile opens a live preview in
     the player (`watch.html?v=` at that chapter), a feedback box (queues a chapter revision) and the revision
     history with Restore.
  4. **Final render:** the full live preview, a "Final render" button and the render queue with progress and ETA.
- **Bottom:** a live job strip showing each running job's step, elapsed time and cost, with Log and Cancel.
- The Create actions are disabled, with an explanation, when `/api/health` reports the Claude CLI missing or signed
  out.

### Play

- A **gallery** of rendered versions: poster frame, title, logline, render date. Versions with several renders show
  the latest, with older ones listed on their watch page.
- A **watch page**:
  - The video (the library MP4) on the left, and the walkthrough on the right. The walkthrough lists the nine
    chapters with their time and blurb (from the storyboard). The current chapter is highlighted and expanded, and
    it follows playback. Click a chapter to seek. On narrow windows the walkthrough moves below the video.
  - **How it was made**: the concept, the storyboard, the revision count with your feedback notes, the total Claude
    cost, and the render date.

## 5. Failures

| Situation | Behaviour |
|---|---|
| Claude CLI missing or signed out | Create actions are disabled with the reason. Play and preview still work. |
| A Claude job's code fails validation | One automatic fix attempt with the error. Then the job fails, nothing is imported, and it can be retried. |
| A Claude job crashes or times out (30 min) | The job fails, nothing is imported, and it can be retried. |
| A render fails | The queue shows the log. Retry resumes from the frames on disk. |
| The server restarts mid-job | The job is marked interrupted and offers a retry. |
| A half-finished import | Can't happen: imports are single transactions at the end of a job. |

## 6. Testing (`bun test`, no Claude usage)

- **Database layer:** creating versions, writing files and revisions, restore, and the original import.
- **Security:** requests without the token, from another origin, or with a spoofed Host header are rejected, and
  path traversal is refused.
- **Job queue:** runs against a fake Claude executable (`CLAUDE_BIN=test/fake-claude.js`) that writes scripted files
  and stream-json output. Covers success, a validation failure with an automatic fix, a final failure, cancel,
  interruption on restart, the lane limits, and the shared-before-chapters ordering.
- **Rendering:** renders a short range of a database-stored version and encodes it to MP4. Also checks that a render
  retry resumes.
- **Browser smoke test** with Puppeteer: the studio shell loads, the original previews in the Create tab, and a
  finished render plays on the watch page with the walkthrough following playback.

## 7. Rollout

1. Build sub-projects 1 and 2. Import the original, then final-render it as the first library entry, which proves
   the full pipeline.
2. Create the **cooking show** in the studio as the pilot, measuring the real Claude cost and time per chapter. The
   user reviews it before the other versions.
3. Create the nature documentary, video game, space opera and road trip.

## 8. Housekeeping

- `serve.mjs` is replaced by `studio/server.js`, which keeps the same URLs for `studio.html` and `watch.html`.
- `package.json` scripts move to Bun: `studio`, `render`, `test`.
- Git-ignored: `studio.db`, `library/`, `.studio/`, `.superpowers/`.
- The README is updated: the studio, versions, and the Bun commands.

## Out of scope

- Uploading to Google Drive or any other cloud.
- Editing chapter code in the browser (chapters change through feedback or restore, and the storyboard through its
  text editor).
- Multiple users, or access from other machines.
- Changing the shared engine, the characters or the song timing from the studio.
