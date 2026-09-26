# P(doom) Studio

A local studio for making your own versions of the music video for *I'm Upping My P(doom)*: same song, same
characters, a new story. You describe a concept, Claude plans the nine chapters and writes the animation code for
each one, and you preview, revise and render the result to a 1080p MP4, all on your own machine.

It comes with the original video as its first example, which you can watch, render or remix into a version of your
own.

## Credits

- **The original video and its code:** [JohnHeibel/PDoomVideo](https://github.com/JohnHeibel/PDoomVideo), the
  [Claude-made music video](https://youtu.be/8j-hR4fJywU) this studio is built on. Its engine, characters, storyboard,
  chapters and animation guide are the starting point for every version made here.
- **Song:** as far as the original project could find, it comes from
  [this YouTube video from 2024](https://www.youtube.com/watch?v=uEB5E67vcPA).
- **Fonts:** [Permanent Marker](https://fonts.google.com/specimen/Permanent+Marker) (Apache License 2.0) and
  [Shantell Sans](https://fonts.google.com/specimen/Shantell+Sans) at weight 800 (SIL Open Font License 1.1), bundled
  in [`assets/fonts/`](assets/fonts/) with their license texts, so painting needs no network access.

## What's here

| Path | What it is |
|---|---|
| [`src/`](src/) | The engine: Clawd, the guest characters, props, lyrics, the timeline and the script loader |
| [`studio.html`](studio.html) | The page every frame is painted in, using p5.js and p5.brush (with `--dev`, also a scrubber) |
| [`render.mjs`](render.mjs) | Paints frames in headless Chromium and encodes MP4s with ffmpeg, from the command line |
| [`studio/`](studio/) | The studio's server: databases, Claude and render jobs, the painting pool and the frame cache |
| [`studio/web/`](studio/web/) | The studio's web UI (React, TypeScript, Vite, Tailwind, shadcn/ui) |
| [`studio/default.db`](studio/default.db) | Example versions, starting with the original video (its storyboard and chapters) |
| [`assets/`](assets/) | The song, and the two fonts the video uses, bundled with their licenses |
| [`ANIMATION_GUIDE.md`](ANIMATION_GUIDE.md) | The style and code guide from the original project, which Claude reads before writing a chapter |
| [`test/`](test/) | Server, engine, renderer and end-to-end tests |
| [`docs/superpowers/`](docs/superpowers/) | The design specs and implementation plans the studio was built from |

## The studio

The studio is a local web app for making new versions of the video: same song, same characters, new story. You
describe a concept, Claude plans nine chapters and writes the code for each, and you preview, revise and render the
result, all on your own machine.

### What you need

- [Bun](https://bun.sh) (tested with 1.4.2)
- ffmpeg, for final renders and thumbnails
- A Chromium-based browser for painting frames: Chrome, Chromium, Edge or Brave, found in its usual place, or a
  headless Chromium that `bun run get-browser` downloads into `.browsers/` (about 100 MB). Set `CHROME_PATH` to use
  any other binary.
- [Claude Code](https://claude.com/claude-code), signed in (`claude auth login`), to create and revise versions.
  Watching, previewing and rendering existing versions works without it.

On macOS, `brew install ffmpeg` and an installed Chrome are enough. On Linux, install ffmpeg and Chromium from your
distribution (for example `sudo apt install ffmpeg chromium`), or use `bun run get-browser`.

### Starting it

```bash
bun install
bun run studio          # then open http://localhost:8080/
```

`bun run studio` (or `bun studio`) builds the web UI whenever its sources have changed, then serves it on port 8080;
`--port=<n>` or `PORT` picks another port. Only one studio can run on the same `user.db` at a time. It listens only
on your own machine.

### Making a version

1. **New version** (in the sidebar) takes a title and a concept. Claude drafts a storyboard: the plan for the nine
   chapters, each with its lines of the song, its shots and its transitions.
2. **Review the storyboard** in the inspector on the right: read it, edit the text yourself, or ask Claude for
   changes. You can also change the concept and have Claude redraft the whole storyboard, and switch the two engine
   options: brush wipes between chapters, and the P(doom) meter in the corner.
3. **Approve** it, and Claude writes the shared code first, then the nine chapters, up to three at a time. Every
   chapter is checked by painting it in the sealed browser; if a check fails, Claude gets the errors and one more try.
4. **Revise** any chapter later: click its block on the timeline, say what should change, and Claude rewrites it.
   Every change, by Claude or by you, is kept as a revision, and **Restore** brings back an earlier one.

Each Claude action has a model picker: CLI default (whatever Claude Code uses), Opus, Sonnet or Haiku. Claude's
buttons are disabled, with the reason, while Claude Code is missing or signed out.

The **jobs** indicator in the header opens a drawer with every job: its status, how long it ran, what Claude Code
reported it cost, its full log, and Cancel or Retry.

### The workspace

- **The timeline**: the song runs left to right as nine chapter blocks, each as wide as its chapter. A block shows
  when Claude is working on it, when it isn't written yet, and when its code is broken (with the error). Click a
  block to open that chapter in the inspector; Escape goes back to the whole storyboard. Drag along the track under
  the blocks to move the playhead. The lyrics run underneath.
- **Previews**: the player above the timeline plays the version with the song (Space plays and pauses; there is a
  full-screen button). Chapter code never runs in your browser: the server paints every frame in its own sealed
  headless Chrome and sends it as a JPEG. **Play** waits until the rest can play without stopping, and shows how long
  that will take; **Play now** starts with what is ready and pauses at the first gap. The shading on the track shows
  which frames are ready. While you play, the server keeps painting ahead of the playhead; it stops shortly after you
  pause or close the page.
- **Thumbnails**: a chapter's strip (three of its frames) shows in the inspector and faintly on its block, once it
  matches the chapter's current code. **Refresh thumbnails** paints them all again.

### The frame cache

Painted frames are kept in `.studio/cache/frames/`, keyed by their content: the engine, the version's options,
`shared.js` and the chapter's code. A frame is painted once and reused by previews, thumbnails and final renders.
Changing a chapter repaints only that chapter; changing the engine (anything in `src/`) repaints everything once.

The cache holds at most 5 GB (`STUDIO_CACHE_GB`) and drops the least recently used frames past that. The settings
menu in the header shows how full it is and can clear it. Renders from before the frame cache kept their frames in
`.studio/frames/<version>/`; nothing uses those any more, and the studio never deletes them by itself: it says at
start how much they hold, and clearing the cache deletes them too.

### Final renders, the library and watching

**Final render** (under the timeline, once all nine chapters are written) paints whatever frames aren't cached yet
and encodes the full 1080p MP4 into `library/`. From an empty cache that takes a while (about 20 minutes here); from
a warm one, mostly just the encode.

**The library** shows every finished render, the latest per version first. **Watching** one plays the video beside a
walkthrough that follows playback, and a "how it was made" section: the concept, the storyboard, the revisions and
your notes to Claude, and what the Claude jobs cost.

### The version menu

The **⋯ menu** in the header acts on the version on screen:

- **Remix** copies it (an example, or one of your own) into a new version of your own, which you can then edit freely.
  Examples offer only Remix.
- **Promote** moves one of your own versions into `studio/default.db`, where it becomes a read-only example for
  everyone once you commit that file.
- **Delete** removes one of your own versions after you type its title: its files, revisions, jobs and thumbnails.
  Its finished videos stay in the library under the version's last title unless you tick **Also delete its finished
  videos**. A kept video is detached from the version, so a new version that later takes the same id doesn't pick it
  up.

### Where your work is kept

| What | Where |
|---|---|
| Your versions, every revision, and all jobs with their logs | `user.db` (git-ignored) |
| Finished videos and their posters | `library/` |
| Claude's work folders, thumbnails and the frame cache | `.studio/` |
| Example versions, starting with the original video | [`studio/default.db`](studio/default.db), tracked in git, read-only to the studio |

On first start, a `studio.db` from before the examples split is moved to `user.db` automatically. Its copy of the
Original is dropped, since that now comes from `studio/default.db`; if you had edited it, it is kept as
`original-edited` instead.

### Settings

| Variable | What it does | Default |
|---|---|---|
| `PORT` (or `--port=<n>`) | The studio's port | `8080` |
| `STUDIO_DATA` | The folder for `user.db`, `library/` and `.studio/` | this project's folder |
| `USER_DB` | Another user database | `$STUDIO_DATA/user.db` |
| `DEFAULT_DB` | Another examples database | `studio/default.db` |
| `STUDIO_CACHE_GB` | The frame cache's size limit, in GB | `5` |
| `STUDIO_PAINTERS` | How many pages paint frames at once (1 to 8) | `3` |
| `CHROME_PATH` | The browser that paints frames | found automatically |
| `CLAUDE_BIN` | The Claude Code command | `claude` |

### Safety

The studio is built so that code written by Claude never runs in your own browser, and nothing it writes can reach
the network:

- Chapter code runs only in the studio's own headless Chrome, behind a dead proxy and strict content security
  policies, on separate `w<n>.localhost` hosts that the UI never shares with.
- Claude Code runs headless with only the permissions it needs: it can read the project, write only in its job's own
  work folder, and run only the studio's render check. Web access and subagents are denied.
- The server listens only on your machine. Every change needs the page's token (new each time the server starts, so
  after a restart an open page asks you to reload it), and requests from other websites are refused.

### Troubleshooting

- **"Previews can't paint: …"** (a banner at the top): the studio can't find or start its painting browser. Install Chrome or Chromium, run
  `bun run get-browser`, or set `CHROME_PATH`. It tries again every 30 seconds.
- **Claude's buttons are disabled**: Claude Code is missing or signed out. Run `claude auth login`.
- **"The studio server restarted — reload this page"**: the server was restarted since the page loaded.
- **"ffmpeg not found"**: install ffmpeg; previews work without it, final renders and thumbnails don't.
- **"another studio is already running on this database"** (when starting it): only one server can use a `user.db`. Stop the other one, or give this
  one its own `STUDIO_DATA`.

### Working on the studio itself

`bun run dev` runs the studio server with `--dev` on port 8080 beside Vite's dev server: open http://localhost:5173/
for hot reloading. Only use it with test data, since `--dev` also accepts changes from that second origin and turns
on the engine's scrubber.

**The engine's scrubber** is a tool for working on the engine, served only with `--dev`:
`http://localhost:8080/studio.html?v=<version>` sends you to `w0.localhost`, where a slider and Play paint the version
live. Unlike everything else in the studio, it runs the version's code in your own browser, so only open it on
versions you trust. It needs a browser that resolves `*.localhost`, such as Chrome or Firefox. For a sealed look at a
version outside the studio, use `render.mjs --sheet` or `--clip` (below).

## Rendering from the command line

```bash
bun render.mjs --frames=0:156.6 --workers=4          # paint the original's frames into out/frames (resumable)
bun render.mjs --encode --out=out/pdoom.mp4          # join the frames and the song into an MP4
bun render.mjs --v=<version> --sheet=23,40,80        # contact sheet of any version
bun render.mjs --v=<version> --clip=0:6 --out=out/test.mp4   # short clip with the song
bun render.mjs --v=<version> --check=1,12,22         # load and paint a few times; exit 1 on any error
```

`--v=<id>` picks a version from the studio's databases (default: the original). Without `--base=<url>` (a running
studio), `render.mjs` starts its own server over the same databases, so `STUDIO_DATA`, `USER_DB` and `DEFAULT_DB`
work here too. With `--base`, it needs that studio's painter secret in `STUDIO_PAINTER_SECRET`, which the studio
gives its own jobs.

`render.mjs` finds Chrome, Chromium, Edge or Brave on macOS, Windows and Linux, or a headless Chromium from
`bun run get-browser`. Pass `--chrome=<path>` or set `CHROME_PATH` to choose one, and `--angle=<backend>` to override
the GPU backend (Metal on macOS, D3D11 on Windows).

## Tests

```bash
bun test               # the server, engine, renderer and end-to-end tests (a few minutes: they drive Chrome)
bun run test:fast      # the same without the tests that launch Chrome or encode with ffmpeg (seconds)
bun run test:web       # the web UI's component tests (Vitest)
bun run typecheck      # the web UI's TypeScript
```

`test:fast` is for quick iteration: it sets `STUDIO_FAST_TESTS=1`, which skips every test written as `slowTest`
(see `test/helpers.js`), and says so when it starts; bun's summary counts them under "skip". Run the full `bun test`
before you commit.

The tests never call the real Claude: every `bun test` process uses `test/fake-claude.js` (see `test/preload.js`).
They run on throwaway data folders and copies of the databases, never on your own.
