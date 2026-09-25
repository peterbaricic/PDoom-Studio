import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LyricsTrack } from './LyricsTrack';

const LYRICS: Array<[number, number, string]> = [
  [1.5, 5.9, 'I see sparks of AGI in your eyes'],
  [23, 24.4, "I'm upping my P(doom)"],
  [137.4, 140.5, 'Was it all for show?'],
];

describe('LyricsTrack', () => {
  test('puts each lyric line under its time span', () => {
    render(<LyricsTrack lyrics={LYRICS} duration={156.6} time={0} />);
    const line = screen.getByText("I'm upping my P(doom)");
    expect(parseFloat(line.style.left)).toBeCloseTo((23 / 156.6) * 100, 6);
    expect(parseFloat(line.style.width)).toBeCloseTo((1.4 / 156.6) * 100, 6);
    expect(line).toHaveAttribute('title', "0:23 I'm upping my P(doom)");
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  test('marks the line being sung', () => {
    render(<LyricsTrack lyrics={LYRICS} duration={156.6} time={24} />);
    expect(screen.getByText("I'm upping my P(doom)")).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('Was it all for show?')).not.toHaveAttribute('aria-current');
  });
});
