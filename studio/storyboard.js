// storyboard.js: reads the parts of STORYBOARD.md the studio relies on (front matter, the nine chapter headings and
// their walkthrough blurbs) and reports anything that doesn't match, so a bad storyboard can go back to Claude.
export const CHAPTER_WINDOWS = [[0, 23], [23, 38.5], [38.5, 59], [59, 73], [73, 95.4], [95.4, 109.4], [109.4, 123.5], [123.5, 140.5], [140.5, 156.6]];

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
