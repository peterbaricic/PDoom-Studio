// storyboard.js: reads the parts of STORYBOARD.md the studio relies on (front matter, the nine chapter headings and
// their walkthrough blurbs) and reports anything that doesn't match, so a bad storyboard can go back to Claude.
export const CHAPTER_WINDOWS = [[0, 23], [23, 38.5], [38.5, 59], [59, 73], [73, 95.4], [95.4, 109.4], [109.4, 123.5], [123.5, 140.5], [140.5, 156.6]];

// The chapter() registrations a version's scripts made, as the painting page reports them ({ owner: the script's path
// or null, name, start, end }), against CHAPTER_WINDOWS. The frame cache keys each frame by the window it falls in, and
// the engine draws a window only with its own chapter file's registrations or shared.js's (chapterAt in
// src/timeline.js), so a chapter reaching past its window is never drawn there: it's an authoring mistake, not a
// cache hazard. So only a job's own target is held to this (target: its chapter number, or 'shared'; null: every
// registration, for render.mjs --check run by hand): a chapter file may register only inside its own window (as many
// sub-windows as it likes), shared.js anywhere (its hash is in every key), and nothing else at all. The song ends
// inside the last window, so a registration may run past its end (the Original's finale ends at DUR + 1). Another
// file's mistakes never fail a job about a different file: Claude can't change them. Returns the errors, one line each.
const chapterOfScript = owner => +(/^ch\/c0([1-9])[_.]/.exec(owner || '')?.[1] || 0);
export function chapterWindowErrors(registrations, target = null) {
  const errors = [], eps = 1e-9, songEnd = CHAPTER_WINDOWS.at(-1)[1];
  const mine = target === 'shared' ? r => r.owner === 'shared.js' : target ? r => chapterOfScript(r.owner) === +target : () => true;
  for (const { owner, name, start, end } of registrations.filter(mine)) {
    if (owner === 'shared.js') continue;
    const what = `chapter('${name}', ${start}, ${end})`, n = chapterOfScript(owner);
    if (!n) { errors.push(`${what} is called from ${owner || 'outside the version\'s files'}: only a chapter file (ch/c0<n>…js) or shared.js may call chapter()`); continue; }
    const [a, b] = CHAPTER_WINDOWS[n - 1];
    if (!(Number.isFinite(start) && Number.isFinite(end) && start < end)) errors.push(`${owner}: ${what} is not a window of time (start before end)`);
    else if (start < a - eps || Math.min(end, songEnd) > b + eps) errors.push(`${owner}: ${what} reaches outside chapter ${n}'s window (${a}–${b} s)`);
  }
  return errors;
}

const HEADING = /^## (\d+)\s*[·:-]\s*(.+?)\s*\(([\d.]+)\s*[–-]\s*([\d.]+)\)\s*$/gm;

export function parseStoryboard(text) {
  const errors = [], meta = {};
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!fm) errors.push('missing front matter block (--- title: … logline: … ---)');
  else for (const line of fm[1].split('\n')) { const m = /^(\w+):\s*(.*)$/.exec(line.trim()); if (m) meta[m[1]] = m[2].trim(); }
  if (fm && !meta.title) errors.push('front matter has no title');
  if (fm && !meta.logline) errors.push('front matter has no logline');

  const heads = [...text.matchAll(HEADING)];
  const chapters = heads.map((m, k) => {
    const body = text.slice(m.index + m[0].length, k + 1 < heads.length ? heads[k + 1].index : text.length);
    const w = /^Walkthrough:\s*(.+)$/m.exec(body);
    return { n: +m[1], name: m[2], start: +m[3], end: +m[4], walkthrough: w ? w[1].trim() : '' };
  });
  if (chapters.length !== 9) errors.push(`expected 9 chapters, found ${chapters.length}`);
  chapters.forEach((c, i) => {
    if (c.n !== i + 1) errors.push(`chapter headings must be numbered 1–9 in order (found ${c.n} in position ${i + 1})`);
    const win = CHAPTER_WINDOWS[c.n - 1];
    if (win && (Math.abs(win[0] - c.start) > .05 || Math.abs(win[1] - c.end) > .05)) errors.push(`chapter ${c.n} must cover ${win[0]}–${win[1]}, not ${c.start}–${c.end}`);
    if (!c.walkthrough) errors.push(`chapter ${c.n} has no "Walkthrough:" line`);
  });
  return { title: meta.title || '', logline: meta.logline || '', chapters, errors };
}
