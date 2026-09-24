import { CHAPTER_WINDOWS } from '../studio/storyboard.js';

export const goodStoryboard = () => [
  '---', 'title: The P(doom) Bake-Off', 'logline: Clawd and the Researcher bake a superintelligence.', '---', '',
  '# Storyboard', '',
  ...CHAPTER_WINDOWS.flatMap(([a, b], i) => [`## ${i + 1} · Chapter ${i + 1} (${a}–${b})`, `Walkthrough: What happens in chapter ${i + 1}.`, '', '| shot | ... |', '']),
].join('\n');
