import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../studio/db.js';
import { launchBrowser } from '../studio/browser.js';
import { CHAPTER_WINDOWS } from '../studio/storyboard.js';
import { goodStoryboard, tempDir, isolatedEnv } from './helpers.js';

const root = process.cwd(), data = tempDir(), dbPath = join(data, 'user.db');
const files = { 'STORYBOARD.md': goodStoryboard(), 'shared.js': 'const SET = {};' };
CHAPTER_WINDOWS.forEach(([a, b], i) => {
  files[`ch/c0${i + 1}.js`] = `chapter('c${i + 1}', ${a}, ${b}, [[${a}, t => paint(rectPts(0, 0, W, H), { wash: PAL.sky, ink: null })]]);`;
});
let server, url, browser, page;

beforeAll(async () => {
  server = Bun.spawn(['bun', 'studio/server.js', '--port=0'], { stdout: 'pipe', env: isolatedEnv(data, {
    CLAUDE_BIN: `bun ${join(root, 'test/fake-claude.js')}`, FAKE_CLAUDE_PLAN: JSON.stringify({ runs: [{ files, cost: .05 }] }) }) });
  const reader = server.stdout.getReader(), dec = new TextDecoder();
  let out = '';
  while (!/Studio: (http:\/\/localhost:\d+)\//.test(out)) out += dec.decode((await reader.read()).value);
  url = /Studio: (http:\/\/localhost:\d+)\//.exec(out)[1];
  browser = await launchBrowser({ port: new URL(url).port });
  page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
});
afterAll(async () => { await browser?.close(); server?.kill(); });

test('create a version from a concept to nine chapters', async () => {
  await page.goto(`${url}/ui/#/create/new`);
  await page.waitForSelector('#concept-title');
  await page.type('#concept-title', 'E2E Test Show');
  await page.type('#concept-text', 'A test concept.');
  await page.click('#draft-storyboard');
  await page.waitForFunction(() => location.hash === '#/create/e2e-test-show');
  await page.waitForFunction(() => document.querySelector('.storyboard')?.textContent.includes('Walkthrough: What happens in chapter 9.'), { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#approve').disabled);
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
  await page.$eval('#approve', b => { b.click(); b.click(); });   // a double click approves once
  await page.waitForFunction(() => document.querySelectorAll('.tile.done').length === 9, { timeout: 360000, polling: 1000 });
  expect(await page.$eval('.versions .version.active small', e => e.textContent)).toBe('ready to render');
  const jobs = await (await fetch(`${url}/api/jobs?version=e2e-test-show`)).json();
  expect(jobs.map(j => j.kind).filter(k => k !== 'chapter')).toEqual(['shared', 'storyboard']);
  expect(jobs.filter(j => j.kind === 'chapter')).toHaveLength(9);
  expect(dialogs).toEqual([]);
  expect(await page.$eval('#approve', b => b.disabled)).toBe(true);

  // Job history: storyboard + shared + nine chapter jobs, newest first.
  await page.waitForFunction(() => document.querySelectorAll('.job-history .job-row').length >= 11);
  await page.click('.job-history .job-row button');
  await page.waitForFunction(() => document.getElementById('log').open);
  expect(await page.$eval('#log pre', e => e.textContent.length)).toBeGreaterThan(0);
  await page.click('#log form button');

  // Expandable job strip: toggling changes the footer's computed max-height.
  const collapsedHeight = await page.$eval('footer#jobs', e => getComputedStyle(e).maxHeight);
  await page.click('#jobs-toggle');
  const expandedHeight = await page.$eval('footer#jobs', e => getComputedStyle(e).maxHeight);
  expect(expandedHeight).not.toBe(collapsedHeight);
}, { timeout: 420000 });

test('play a finished render with a synced walkthrough', async () => {
  mkdirSync(join(data, 'library'), { recursive: true });
  const ff = Bun.spawn(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=40', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', '40', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(data, 'library/zz-e2e.mp4')]);
  await ff.exited;
  Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', '-i', join(data, 'library/zz-e2e.mp4'), '-frames:v', '1', join(data, 'library/zz-e2e.jpg')]);
  const db = openDb(dbPath);
  const rid = db.addRender({ versionId: 'e2e-test-show', file: 'zz-e2e.mp4', revisionIds: [], durationS: 40, renderS: 60, sizeBytes: 1, poster: 'zz-e2e.jpg' });
  db.close();

  await page.goto(`${url}/ui/#/play`);
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

test('after a server restart, a page with a stale token asks for a reload', async () => {
  const stale = await browser.newPage();
  await stale.setRequestInterception(true);
  stale.on('request', async r => {
    if (new URL(r.url()).pathname !== '/ui/') return r.continue();
    const html = await (await fetch(r.url())).text();
    r.respond({ status: 200, contentType: 'text/html', body: html.replace(/name="studio-token" content="[0-9a-f]+"/, 'name="studio-token" content="stale"') });
  });
  await stale.goto(`${url}/ui/#/create`);
  const message = await stale.evaluate(() => import('/ui/app.js').then(m => m.api('POST', '/api/versions', { id: 'stale-token' })).then(() => 'created', e => e.message));
  expect(message).toBe('The studio server restarted — reload this page.');
  await stale.close();
}, { timeout: 60000 });
