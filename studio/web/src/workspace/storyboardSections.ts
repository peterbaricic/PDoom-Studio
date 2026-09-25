// storyboardSections.ts: the parts of a STORYBOARD.md the inspector shows on their own. Pure string work, no
// Markdown parser: a chapter's section is its "## n · Name (start–end)" heading up to the next "## " heading, which
// is what studio/storyboard.js reads a chapter as too. The separator may be ·, : or - (as the server accepts), and
// anything may follow the window (the Original's legacy headings add colour notes: "## 1 · The Lab (1.5–23) · …").

// Chapter n's section, heading included, up to (not including) the next level-2 heading; '' when there's none.
export function storyboardSection(markdown: string, n: number): string {
  const lines = markdown.split(/(?<=\n)/); // keeps each line's own ending, so the section is the text as written
  const heading = new RegExp(`^## ${n}\\s*[·:-]`);
  const start = lines.findIndex(l => heading.test(l));
  if (start < 0) return '';
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start, next < 0 ? undefined : next).join('');
}

// The storyboard without its leading front matter (--- title: … logline: … ---), which the studio reads for the
// version's title and logline and which Markdown would otherwise render as a rule and a stray heading.
export function withoutFrontMatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}
