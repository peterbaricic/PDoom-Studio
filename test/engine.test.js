import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../studio/db.js';
import { importOriginal } from '../studio/versions.js';
import { serve } from '../studio/serve.js';
import { createEvents } from '../studio/events.js';
import { launchBrowser } from '../studio/browser.js';

const root = process.cwd(), T = { timeout: 120000 };
let db, srv, browser;
beforeAll(async () => {
  db = openDb(':memory:'); importOriginal(db, root);
  srv = serve({ db, root, token: 't', events: createEvents(), port: 0 });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); srv?.stop(); });

async function open(query) {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${srv.url}/studio.html?render&${query}`);
  await page.waitForFunction('window.ready === true', { timeout: 60000 });
  return { page, errors };
}

test('loads the original by default and renders a frame', async () => {
  const { page, errors } = await open('');
  expect(await page.evaluate(() => [CH.length, VERSION.id, ENGINE.wipes])).toEqual([9, 'original', true]);
  expect(await page.evaluate(() => window.renderAt(40, 'image/jpeg', .5).then(u => u.length))).toBeGreaterThan(10000);
  expect(errors).toEqual([]);
  await page.close();
}, T);

test('loads a database version with its engine options', async () => {
  db.createVersion({ id: 'mini', options: { wipes: false, cornerMeter: false } });
  db.writeFiles('mini', [
    { path: 'shared.js', content: 'const MINI = { col: PAL.rose };' },
    { path: 'ch/c01.js', content: "chapter('one', 0, 23, [[0, t => paint(rectPts(0, 0, W, H), { wash: MINI.col, ink: null })]]);" },
  ], { source: 'manual' });
  const { page, errors } = await open('v=mini');
  expect(await page.evaluate(() => [CH.length, CH[0].name, ENGINE.wipes, ENGINE.cornerMeter])).toEqual([1, 'one', false, false]);
  await page.evaluate(() => window.renderAt(5));
  expect(errors).toEqual([]);
  await page.close();
}, T);

test('loads a work folder, and reports broken code', async () => {
  db.createVersion({ id: 'broken' });
  const jid = db.addJob({ kind: 'chapter', versionId: 'broken', params: { chapter: 1 } });
  const dir = join(root, '.studio/work', String(jid));
  mkdirSync(join(dir, 'ch'), { recursive: true });
  writeFileSync(join(dir, 'ch/c01.js'), "throw new Error('boom');");
  try {
    const { page, errors } = await open(`work=${jid}`);
    expect(errors.join()).toContain('boom');
    await page.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, T);

test('an unknown version sets loadError', async () => {
  const { page } = await open('v=nope');
  expect(await page.evaluate(() => window.loadError)).toContain('no such version');
  await page.close();
}, T);
