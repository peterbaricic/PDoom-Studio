import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../studio/db.js';
import { importOriginal } from '../studio/versions.js';
import { serve } from '../studio/serve.js';
import { createEvents } from '../studio/events.js';
import { launchBrowser } from '../studio/browser.js';
import { tempDir } from './helpers.js';

const root = process.cwd(), data = tempDir(), T = { timeout: 120000 };
let db, srv, browser;
beforeAll(async () => {
  db = openDb(':memory:'); importOriginal(db, root);
  srv = serve({ db, root, data, token: 't', events: createEvents(), port: 0 });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); srv?.stop(); });

// Opened on the studio's own origin, as a user would; the server sends studio.html to w0.localhost.
async function open(query) {
  const page = await browser.newPage(), errors = [], messages = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => messages.push(m.text()));
  await page.goto(`${srv.url}/studio.html?render&${query}`);
  await page.waitForFunction('window.ready === true', { timeout: 60000 });
  return { page, errors, messages };
}

test('loads the original by default on w0.localhost and renders a frame, within its content security policy', async () => {
  const { page, errors, messages } = await open('');
  expect(page.url()).toStartWith(`http://w0.localhost:${srv.port}/studio.html?render`);
  expect(await page.evaluate(() => [CH.length, VERSION.id, ENGINE.wipes])).toEqual([9, 'original', true]);
  expect(await page.evaluate(() => window.renderAt(40, 'image/jpeg', .5).then(u => u.length))).toBeGreaterThan(10000);
  expect(errors).toEqual([]);
  expect(messages.filter(m => /Content.Security.Policy/i.test(m))).toEqual([]);
  // The policy holds: version code can't reach any other server.
  expect(await page.evaluate(() => fetch('https://example.com/').then(() => 'fetched', () => 'blocked'))).toBe('blocked');
  await page.close();
}, T);

test('the launched browser cannot resolve hosts outside the allow-list, and Google Fonts still can', async () => {
  const host = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.example`;
  const probe = await browser.newPage();
  await probe.goto('about:blank');
  const failures = [];
  probe.on('requestfailed', r => failures.push(r.failure()?.errorText));
  await probe.evaluate(h => fetch(`https://${h}/`, { mode: 'no-cors' }).catch(() => {}), host);
  // Not just "the fetch failed" (a fetch() TypeError never says why) — the underlying network error is specifically
  // a name-resolution failure, meaning --host-resolver-rules refused the lookup before any real DNS query went out.
  expect(failures).toContain('net::ERR_NAME_NOT_RESOLVED');
  expect(await probe.evaluate(() => fetch('https://fonts.googleapis.com/', { mode: 'no-cors' }).then(() => 'ok', e => e.message))).toBe('ok');
  expect(await probe.evaluate(() => fetch('https://fonts.gstatic.com/', { mode: 'no-cors' }).then(() => 'ok', e => e.message))).toBe('ok');
  await probe.close();
}, T);

test('a chapter cannot leak data through dns-prefetch/preconnect, and Google Fonts still loads through the same lockdown', async () => {
  const host = `leak-${Date.now()}-${Math.random().toString(36).slice(2)}.example`;
  db.createVersion({ id: 'dns-probe' });
  db.writeFiles('dns-probe', [{ path: 'ch/c01.js', content: [
    `const p = document.createElement('link'); p.rel = 'dns-prefetch'; p.href = '//${host}'; document.head.append(p);`,
    `const c = document.createElement('link'); c.rel = 'preconnect'; c.href = 'https://${host}'; document.head.append(c);`,
  ].join('\n') }], { source: 'manual' });
  const { page, errors } = await open('v=dns-probe');
  expect(errors).toEqual([]);
  // core.js's setup() awaits document.fonts.load() for both families before window.ready is ever set, so getting
  // here at all already proves Google Fonts loaded through the lockdown; this double-checks the faces are usable.
  expect(await page.evaluate(() => [document.fonts.check('100px "Permanent Marker"'), document.fonts.check('800 50px "Shantell Sans"')])).toEqual([true, true]);
  await page.close();

  // A separate, unrestricted page sharing the same browser (so the same --host-resolver-rules): if the
  // dns-prefetch/preconnect hint above had made a real DNS query, the host would now be "known" and a later fetch
  // would fail some other way (a connection or TLS error), not with a fresh name-resolution failure.
  const probe = await browser.newPage();
  await probe.goto('about:blank');
  const failures = [];
  probe.on('requestfailed', r => failures.push(r.failure()?.errorText));
  await probe.evaluate(h => fetch(`https://${h}/`, { mode: 'no-cors' }).catch(() => {}), host);
  expect(failures).toContain('net::ERR_NAME_NOT_RESOLVED');
  await probe.close();
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
  const dir = join(data, '.studio/work', String(jid));
  mkdirSync(join(dir, 'ch'), { recursive: true });
  writeFileSync(join(dir, 'ch/c01.js'), "throw new Error('boom');");
  const { page, errors } = await open(`work=${jid}`);
  expect(errors.join()).toContain('boom');
  await page.close();
}, T);

test('an unknown version sets loadError', async () => {
  const { page } = await open('v=nope');
  expect(await page.evaluate(() => window.loadError)).toContain('no such version');
  await page.close();
}, T);

test('the player renders the requested version in its workers', async () => {
  const page = await browser.newPage();
  await page.goto(`${srv.url}/watch.html?v=mini&workers=1`);
  await page.waitForFunction('workers.length === 1 && workers[0].ready', { timeout: 60000 });
  expect(await page.evaluate(() => workers[0].el.src)).toContain('v=mini');
  await page.close();
}, T);
