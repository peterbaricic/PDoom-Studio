import { test, expect } from 'bun:test';
import { md } from '../studio/ui/md.js';

test('renders headings, tables, lists and emphasis, and skips front matter', () => {
  const html = md('---\ntitle: X\n---\n# Title\n## 1 · Kitchen (0–23)\nWalkthrough: **Big** *oven*.\n\n| Time | Shot |\n|---|---|\n| 0–2 | `boom` |\n\n- one\n- two');
  expect(html).not.toContain('title: X');
  expect(html).toContain('<h2>Title</h2>');
  expect(html).toContain('<h3>1 · Kitchen (0–23)</h3>');
  expect(html).toContain('<p>Walkthrough: <b>Big</b> <i>oven</i>.</p>');
  expect(html).toContain('<table><tr><th>Time</th><th>Shot</th></tr><tr><td>0–2</td><td><code>boom</code></td></tr></table>');
  expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
});

test('escapes HTML', () => {
  expect(md('<script>alert(1)</script> & "q"')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;</p>');
});
