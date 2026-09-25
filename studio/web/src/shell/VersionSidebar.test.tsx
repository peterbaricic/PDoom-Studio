import { afterEach, describe, expect, test, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { VersionSidebar, stageLabel } from './VersionSidebar';
import { mockApi, renderInRouter, version } from '../test-utils';

afterEach(() => vi.unstubAllGlobals());

describe('stageLabel', () => {
  test('names each stage the way the spec does', () => {
    expect(stageLabel(version({ id: 'a', status: 'concept' }), false)).toBe('concept');
    expect(stageLabel(version({ id: 'a', status: 'storyboard' }), false)).toBe('storyboard to review');
    expect(stageLabel(version({ id: 'a', status: 'approved', chapters: 0 }), false)).toBe('building 0/9');
    expect(stageLabel(version({ id: 'a', status: 'chapters', chapters: 6 }), false)).toBe('building 6/9');
    expect(stageLabel(version({ id: 'a', status: 'ready', chapters: 9 }), false)).toBe('ready');
    expect(stageLabel(version({ id: 'a', status: 'ready', chapters: 9 }), true)).toBe('rendered');
  });
});

describe('VersionSidebar', () => {
  const versions = [
    version({ id: 'original', title: 'P(doom)', example: true, status: 'ready', chapters: 9 }),
    version({ id: 'older', title: 'Older one', status: 'chapters', chapters: 6, updated_at: 10 }),
    version({ id: 'newer', title: 'Newer one', status: 'storyboard', updated_at: 20 }),
    version({ id: 'done', title: 'Done one', status: 'ready', chapters: 9, updated_at: 5 }),
  ];

  test('lists examples (with the ★ badge) above my versions, each with its stage label', async () => {
    mockApi({ 'GET /api/versions': versions, 'GET /api/library': [{ id: 1, version_id: 'done' }] });
    renderInRouter(<VersionSidebar />, { path: '/versions/older' });

    const examples = await screen.findByRole('region', { name: 'Examples' });
    const mine = screen.getByRole('region', { name: 'My versions' });
    // Examples come first in the document.
    expect(examples.compareDocumentPosition(mine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const exampleLink = await within(examples).findByRole('link', { name: /P\(doom\)/ });
    expect(exampleLink).toHaveTextContent('★');
    expect(exampleLink).toHaveTextContent('ready');

    // My versions: most recently updated first, none starred.
    const links = within(mine).getAllByRole('link');
    expect(links.map(l => l.getAttribute('href'))).toEqual(['/versions/newer', '/versions/older', '/versions/done']);
    for (const l of links) expect(l).not.toHaveTextContent('★');
    expect(links[0]).toHaveTextContent('storyboard to review');
    expect(links[1]).toHaveTextContent('building 6/9');
    expect(links[2]).toHaveTextContent('rendered');
  });

  test('a render kept from a deleted version with the same id doesn\'t make a version "rendered"', async () => {
    mockApi({ 'GET /api/versions': versions, 'GET /api/library': [{ id: 1, version_id: 'done', detached: true }] });
    renderInRouter(<VersionSidebar />, { path: '/versions/older' });
    const done = await screen.findByRole('link', { name: /Done one/ });
    expect(done).toHaveTextContent('ready');
    expect(done).not.toHaveTextContent('rendered');
  });

  test('marks the version in the URL as the current one', async () => {
    mockApi({ 'GET /api/versions': versions, 'GET /api/library': [] });
    renderInRouter(<VersionSidebar />, { path: '/versions/older/watch' });
    const current = await screen.findByRole('link', { current: 'page' });
    expect(current).toHaveAttribute('href', '/versions/older');
  });

  test('says so when there are no versions of my own yet', async () => {
    mockApi({ 'GET /api/versions': versions.slice(0, 1), 'GET /api/library': [] });
    renderInRouter(<VersionSidebar />, { path: '/versions/original' });
    expect(await screen.findByText(/no versions of your own yet/i)).toBeInTheDocument();
  });
});
