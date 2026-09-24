// prompts.js: the briefs Claude gets in TASK.md. Everything a job needs is in the brief or one Read away.
import { CHAPTER_WINDOWS } from './storyboard.js';

// The one command a job's Claude may run (its Bash allow rule is this plus " *"). Bun reads bunfig.toml (preload
// scripts) and .env from the working directory, Claude's own work folder, before running any script; the empty
// studio config and --no-env-file turn both off. Keep --config= with "=": "-c <path>" is parsed differently.
export const renderCommand = (root, jobId) => `bun --no-env-file --config=${root}/studio/sandbox.bunfig.toml ${root}/render.mjs --work=${jobId}`;

const common = ({ root, jobId, baseUrl }) => `
## The project

This is one version of a 156.6-second music video for the song "I'm Upping My P(doom)", painted with p5.js and p5.brush.
Every version tells a different story with the same song, the same lyric timings and the same characters.

Read these before you start (they are read-only for you):
- \`${root}/ANIMATION_GUIDE.md\`: the painting API, the characters, the style rules and the chapter contract. Follow it.
- \`${root}/src/\`: the shared engine (core.js, clawd.js, cast.js, props.js, timeline.js, lyrics.js). Never edit these.
- \`${root}/src/lyrics.js\`: every lyric line with its start and end time.
- \`${root}/src/ch/\` and \`${root}/STORYBOARD.md\`: the original version, as a reference for quality and detail.

You work only in the current folder. It holds this version's files: \`STORYBOARD.md\`, maybe \`shared.js\`, and \`ch/c0N.js\` chapters.

The song fixes nine chapter windows (seconds):
${CHAPTER_WINDOWS.map(([a, b], i) => `${i + 1}. ${a}–${b}`).join('\n')}

## Checking your work

Render a contact sheet of any times you like and look at it with the Read tool:

    ${renderCommand(root, jobId)} --base=${baseUrl} --sheet=40,45,50 --out=sheet.jpg

Always check before you finish. Fix anything that is broken, blank, off-screen or hidden behind the karaoke bar.
`;

const STORYBOARD_FORMAT = `
## Storyboard format (the studio reads this, so follow it exactly)

Start with front matter:

    ---
    title: <a short title for this version>
    logline: <one sentence that sells it>
    ---

Then a short section on the idea and the cast, then exactly nine chapter headings in order, each written like this:

    ## 1 · The Kitchen (0–23)
    Walkthrough: <two or three sentences for viewers: what happens in this chapter and why it's funny>

The numbers in brackets must be the chapter's window from the list above. After each Walkthrough line, plan the shots
as a table with columns Time | Lyric | Shot | Out, covering every lyric line in the window, like the original storyboard.
`;

export function taskBrief({ kind, version, params, target, root, jobId, baseUrl, exists }) {
  const feedback = params.feedback ? `\n## Feedback from the director\n\n${params.feedback}\n\nChange what the feedback asks for and keep what works.\n` : '';
  if (kind === 'storyboard') return `# Task: ${exists ? 'revise' : 'write'} the storyboard

${exists ? 'Revise `STORYBOARD.md` in this folder.' : 'Write `STORYBOARD.md` in this folder.'} It plans a new version of the video.

## The concept

${version.concept}

Keep Clawd, the Researcher and the troupe of small Clawds and their look. Everything else is new: the setting, the
story, the jokes and the transitions. Something must happen in every shot, and each lyric line gets its own visual
idea. Keep text on screen rare: tell jokes with pictures.
${STORYBOARD_FORMAT}${feedback}${common({ root, jobId, baseUrl })}
Write only \`STORYBOARD.md\`. Don't write any code in this task.
`;

  if (kind === 'shared') return `# Task: write shared.js

Read \`STORYBOARD.md\` and write \`shared.js\`: the sets, props and extra characters that more than one chapter of this
version needs (for example the kitchen, the oven and a chef's hat), so every chapter draws them the same way.

Put everything on one global object, \`const SET = { … };\`, with one drawing function per set piece, each taking the
time \`t\` and position or size arguments. Follow the painting API and the pure-function rules of the animation guide.
If nothing is shared, write \`const SET = {};\`. Don't register any chapters in this file.
${feedback}${common({ root, jobId, baseUrl })}
Write only \`shared.js\`. Check it by rendering a few frames of the original chapters' times; it must load without errors.
`;

  const n = params.chapter, [a, b] = CHAPTER_WINDOWS[n - 1];
  return `# Task: ${exists ? 'revise' : 'write'} chapter ${n}

${exists ? `Revise \`${target}\`` : `Write \`${target}\``}: chapter ${n} of this version, covering ${a}–${b} seconds.
Follow the chapter ${n} section of \`STORYBOARD.md\`.

Register it with \`chapter('<short-name>', ${a}, ${b}, shots)\`, wrapped in an IIFE, exactly as the animation guide
describes. You may use \`SET\` from \`shared.js\` but must not edit that file, and must not touch other chapters.
${feedback}${common({ root, jobId, baseUrl })}
Write only \`${target}\`. Check several contact sheets across ${a}–${b} before you finish.
`;
}
