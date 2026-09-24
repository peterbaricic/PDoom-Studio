// md.js: just enough Markdown for storyboards (front matter skipped, headings, tables, lists, paragraphs, emphasis).
// Everything is escaped before any markup is added.
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>').replace(/`(.+?)`/g, '<code>$1</code>');
const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

export function md(text) {
  const lines = text.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(l))) out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`);
    else if (l.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      i--;
      const body = rows.filter(r => !/^\|[\s:|-]+\|?$/.test(r.trim()));
      out.push('<table>' + body.map((r, k) => '<tr>' + cells(r).map(c => k ? `<td>${inline(c)}</td>` : `<th>${inline(c)}</th>`).join('') + '</tr>').join('') + '</table>');
    } else if (/^[-*] /.test(l)) {
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) items.push(lines[i++].slice(2));
      i--;
      out.push('<ul>' + items.map(x => `<li>${inline(x)}</li>`).join('') + '</ul>');
    } else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return out.join('\n');
}
