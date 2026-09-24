import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../studio/db.js';
import { launchBrowser } from '../studio/browser.js';
import { CHAPTER_WINDOWS } from '../studio/storyboard.js';
import { goodStoryboard } from './helpers.js';

const root = process.cwd(), dbPath = join(mkdtempSync(join(tmpdir(), 'ui-')), 'studio.db');
const files = { 'STORYBOARD.md': goodStoryboard(), 'shared.js': 'const SET = {};' };
CHAPTER_WINDOWS.forEach(([a, b], i) => {
  files[`ch/c0${i + 1}.js`] = `chapter('c${i + 1}', ${a}, ${b}, [[${a}, t => paint(rectPts(0, 0, W, H), { wash: PAL.sky, ink: null })]]);`;
});
let server, url, browser, page;

beforeAll(async () => {
  server = Bun.spawn(['bun', 'studio/server.js', '--port=0'], { stdout: 'pipe', env: { ...process.env, STUDIO_DB: dbPath,
    CLAUDE_BIN: `bun ${join(root, 'test/fake-claude.js')}`, FAKE_CLAUDE_PLAN: JSON.stringify({ runs: [{ files, cost: .05 }] }) } });
  const reader = server.stdout.getReader(), dec = new TextDecoder();
  let out = '';
  while (!/Studio: (http:\/\/localhost:\d+)\//.test(out)) out += dec.decode((await reader.read()).value);
  url = /Studio: (http:\/\/localhost:\d+)\//.exec(out)[1];
  browser = await launchBrowser();
  page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
});
afterAll(async () => {
  await browser?.close(); server?.kill();
  rmSync(join(root, 'library', 'zz-e2e.mp4'), { force: true }); rmSync(join(root, 'library', 'zz-e2e.jpg'), { force: true });
  rmSync(join(root, '.studio/thumbs/e2e-test-show'), { recursive: true, force: true });
});

test('create a version from a concept to nine chapters', async () => {
  await page.goto(`${url}/#/create/new`);
  await page.waitForSelector('#concept-title');
  await page.type('#concept-title', 'E2E Test Show');
  await page.type('#concept-text', 'A test concept.');
  await page.click('#draft-storyboard');
  await page.waitForFunction(() => location.hash === '#/create/e2e-test-show');
  await page.waitForFunction(() => document.querySelector('.storyboard')?.textContent.includes('Walkthrough: What happens in chapter 9.'), { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#approve').disabled);
  await page.click('#approve');
  await page.waitForFunction(() => document.querySelectorAll('.tile.done').length === 9, { timeout: 360000, polling: 1000 });
  expect(await page.$eval('.versions .version.active small', e => e.textContent)).toBe('ready to render');
}, { timeout: 420000 });

test('play a finished render with a synced walkthrough', async () => {
  mkdirSync(join(root, 'library'), { recursive: true });
  const ff = Bun.spawn(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=40', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', '40', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(root, 'library/zz-e2e.mp4')]);
  await ff.exited;
  Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', '-i', join(root, 'library/zz-e2e.mp4'), '-frames:v', '1', join(root, 'library/zz-e2e.jpg')]);
  const db = openDb(dbPath);
  const rid = db.addRender({ versionId: 'e2e-test-show', file: 'zz-e2e.mp4', revisionIds: [], durationS: 40, renderS: 60, sizeBytes: 1, poster: 'zz-e2e.jpg' });
  db.close();

  await page.goto(`${url}/#/play`);
  await page.waitForSelector('.gallery .card');
  expect(await page.$eval('.gallery .card', e => e.textContent)).toContain('The P(doom) Bake-Off');
  await page.click('.gallery .card');
  await page.waitForFunction(r => location.hash === `#/play/${r}`, {}, rid);
  await page.waitForSelector('#player video');
  expect(await page.$$eval('.walkthrough li', l => l.length)).toBe(9);
  await page.$eval('#player video', v => new Promise(r => { v.addEventListener('seeked', r, { once: true }); v.currentTime = 30; }));
  await page.waitForFunction(() => document.querySelector('.walkthrough li.current')?.textContent.includes('Chapter 2'));
  expect(await page.$eval('.made', e => e.textContent)).toContain('A test concept.');
}, { timeout: 60000 });
