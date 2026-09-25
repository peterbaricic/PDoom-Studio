import { describe, expect, test } from 'vitest';
import { storyboardSection, withoutFrontMatter } from './storyboardSections';

// The Original's STORYBOARD.md (legacy format): a chapter 0, colour notes after the window, a table and lists.
const LEGACY = `# I'm Upping My P(doom): storyboard

## The idea

The video is a stage show.

## 0 · Curtain up (0–1.5)

The curtain.

## 1 · The Lab (1.5–23) · night indigo, lamp ochre, monitor teal

| Beat | What happens |
|---|---|
| 1.5 | Clawd doodles |

### Notes

- the lamp flickers

## 2 · Chorus 1: The P(doom) Show (23–38.5) · rose and ochre sunburst

The stage.

## 9 · Curtain call (140.5–156.6) · crimson and gold

Everyone bows.
`;

// The studio format (studio/prompts.js): front matter, then "## n · Name (start–end)" with a Walkthrough line.
const STUDIO = `---
title: The Bake-Off
logline: Clawd bakes.
---

## 1 · The Kitchen (0–23)

Walkthrough: Clawd preheats the oven.

Shots.

## 10 · Not a chapter (0–1)

Nope.

## 2 · The Tent (23–38.5)

Walkthrough: A tent.
`;

describe('storyboardSection', () => {
  test("takes a legacy chapter from its heading up to the next ## heading, keeping its ### subsections", () => {
    const s = storyboardSection(LEGACY, 1);
    expect(s.startsWith('## 1 · The Lab (1.5–23) · night indigo, lamp ochre, monitor teal')).toBe(true);
    expect(s).toContain('| 1.5 | Clawd doodles |');
    expect(s).toContain('### Notes');
    expect(s).toContain('- the lamp flickers');
    expect(s).not.toContain('Chorus 1');
    expect(s).not.toContain('Curtain up');
  });

  test('the last chapter runs to the end of the file', () => {
    expect(storyboardSection(LEGACY, 9).trim()).toBe('## 9 · Curtain call (140.5–156.6) · crimson and gold\n\nEveryone bows.');
  });

  test('handles the studio format, and never mistakes chapter 10 for chapter 1', () => {
    expect(storyboardSection(STUDIO, 1).trim()).toBe('## 1 · The Kitchen (0–23)\n\nWalkthrough: Clawd preheats the oven.\n\nShots.');
    expect(storyboardSection(STUDIO, 2)).toContain('Walkthrough: A tent.');
  });

  test('accepts the separators the server does (· : -), and CRLF line ends', () => {
    expect(storyboardSection('## 3: Takeoff (38.5–59)\r\nUp.\r\n## 4 - Next (59–73)\r\n', 3).trim()).toBe('## 3: Takeoff (38.5–59)\r\nUp.');
    expect(storyboardSection('## 4 - Next (59–73)\nOn.\n', 4).trim()).toBe('## 4 - Next (59–73)\nOn.');
  });

  test("is empty for a chapter the storyboard doesn't have", () => {
    expect(storyboardSection(LEGACY, 5)).toBe('');
    expect(storyboardSection('', 1)).toBe('');
  });
});

describe('withoutFrontMatter', () => {
  test('drops the leading --- block the studio reads title and logline from', () => {
    expect(withoutFrontMatter(STUDIO).startsWith('\n## 1 · The Kitchen')).toBe(true);
  });

  test('leaves a storyboard without one alone', () => {
    expect(withoutFrontMatter(LEGACY)).toBe(LEGACY);
  });
});
