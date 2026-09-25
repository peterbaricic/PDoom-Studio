// ui.test.js: the React studio end to end, as a user drives it. A real server (--port=0, a throwaway data root, a
// private copy of the examples database for Promote to write to, the fake Claude from test/preload.js), the built app,
// and a headless Chrome: a new version from a concept through its storyboard to nine chapters; the preview player
// painting; a short final render in the library and the watch view; Remix, Promote and Delete; and a server restart
// under the open page. Throughout, the browser only ever loads the app's own Vite chunks as scripts: chapter code
// never runs in the user's browser.
import { expect, beforeAll, afterAll } from 'bun:test';
import { rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { dirname, join } from 'node:path';
import { launchBrowser } from '../studio/browser.js';
import { CHAPTER_WINDOWS } from '../studio/storyboard.js';
import { goodStoryboard, tempDir, tempDefaultDb, isolatedEnv, FAST_TESTS, slowTest, closeBrowser } from './helpers.js';

const root = process.cwd(), data = tempDir(), defaultDb = tempDefaultDb();
const repoDefaultDb = join(root, 'studio/default.db');
const md5 = p => createHash('md5').update(readFileSync(p)).digest('hex');
const repoDefaultBefore = md5(repoDefaultDb), defaultCopyBefore = md5(defaultDb);

// Every Claude job (the storyboard, shared.js, each chapter) gets this one run: it writes the whole version, and the
// job imports just its own target file from it.
const files = { 'STORYBOARD.md': goodStoryboard(), 'shared.js': 'const SET = {};' };
CHAPTER_WINDOWS.forEach(([a, b], i) => {
  files[`ch/c0${i + 1}.js`] = `chapter('c${i + 1}', ${a}, ${b}, [[${a}, t => paint(rectPts(0, 0, W, H), { wash: PAL.sky, ink: null })]]);`;
});
// CLAUDE_BIN comes from test/preload.js (the fake), through process.env. STUDIO_TEST_SKIP_CHECK: the Claude jobs import
// what the fake wrote without render.mjs's check, a Chrome of its own for each of the eleven jobs (and most of this
// file's time when it ran); test/claude-job.test.js runs that check for real, on passing and failing chapters.
const env = isolatedEnv(data, { DEFAULT_DB: defaultDb, FAKE_CLAUDE_PLAN: JSON.stringify({ runs: [{ files, cost: .05 }] }), STUDIO_PAINTERS: '2',
  STUDIO_TEST_SKIP_CHECK: '1' });

let server, url, port, browser, page, serverLog = '';
const requests = [], scripts = [], targets = [], frameResponses = [], pageErrors = [];

// Starts the studio (on `at`, or a free port) and resolves once it's listening. Its output is kept (and printed if a
// step fails) and drained, so a full pipe can never stall it.
async function startServer(at = 0) {
  const p = Bun.spawn(['bun', 'studio/server.js', `--port=${at}`], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const drain = async (stream, onText) => {
    const dec = new TextDecoder();
    for await (const chunk of stream) { const t = dec.decode(chunk); serverLog += t; onText?.(t); }
  };
  void drain(p.stderr);
  const listening = new Promise((resolve, reject) => {
    let out = '';
    void drain(p.stdout, t => { out += t; const m = /Studio: (http:\/\/localhost:(\d+))\//.exec(out); if (m) resolve(m); })
      .then(() => reject(new Error(`the studio exited before it was listening:\n${serverLog}`)));
  });
  const [, u, pt] = await listening;
  return { proc: p, url: u, port: +pt };
}

// Runs a step; on failure, shows what the server said.
const step = fn => async () => {
  try { await fn(); } catch (e) { console.error(`--- studio output (last 6000 chars) ---\n${serverLog.slice(-6000)}`); throw e; }
};

// With the page's token: the coverage route answers only with it (studio/http.js).
const api = async path => fetch(`${url}${path}`, { headers: { 'x-studio-token': await page.$eval('meta[name="studio-token"]', m => m.content) } }).then(r => r.json());
const clickButton = (scope, label) => page.evaluate((s, l) => {
  const b = [...document.querySelectorAll(`${s} button`)].find(x => x.textContent.trim() === l && !x.disabled);
  if (!b) throw new Error(`no enabled button "${l}" in ${s}`);
  b.click();
}, scope, label);
const enabledButton = (scope, label, timeout = 10000) => page.waitForFunction((s, l) =>
  [...document.querySelectorAll(`${s} button`)].some(x => x.textContent.trim() === l && !x.disabled), { timeout }, scope, label);
// Focuses the dialog's field with this label, its text selected, so typing replaces it.
const typeField = async (label, text) => {
  await page.evaluate(l => {
    const lab = [...document.querySelectorAll('[role="dialog"] label')].find(x => x.textContent.trim() === l);
    const el = document.getElementById(lab.htmlFor);
    el.focus(); el.select();
  }, label);
  await page.keyboard.type(text);
};
const versionMenu = async item => {
  await page.click('button[aria-label="Version actions"]');
  await page.waitForSelector('[role="menuitem"]', { timeout: 10000 });
  await page.evaluate(i => [...document.querySelectorAll('[role="menuitem"]')].find(m => m.textContent.trim() === i).click(), item);
  await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
};
const noDialog = () => page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 10000 });
// How many of frames first..last the timeline's coverage shading covers (in the page, for waitForFunction too).
const shadedIn = (first, last) => [...document.querySelectorAll('[aria-label="Playhead"] [data-range]')]
  .reduce((n, e) => { const [a, b] = e.dataset.range.split('-').map(Number); return n + Math.max(0, Math.min(b, last) - Math.max(a, first) + 1); }, 0);

beforeAll(async () => {
  if (FAST_TESTS) return;   // every test here drives Chrome
  ({ proc: server, url, port } = await startServer());
  browser = await launchBrowser({ port });
  browser.on('targetcreated', t => targets.push(`${t.type()} ${t.url()}`));
  page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on('request', r => {
    requests.push(r.url());
    if (r.resourceType() === 'script') scripts.push(r.url());
  });
  page.on('response', r => { if (/\/api\/frames\/[^/]+\/\d+\.jpg/.test(r.url())) frameResponses.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  page.on('pageerror', e => pageErrors.push(e.message));
}, 60000);

afterAll(async () => {
  await closeBrowser(browser);
  server?.kill();
  await server?.exited;
  rmSync(data, { recursive: true, force: true });
  rmSync(dirname(defaultDb), { recursive: true, force: true });
}, 40000);

slowTest('a new version: its storyboard, approved, becomes nine ready chapter blocks', step(async () => {
  await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => location.pathname === '/versions/original', { timeout: 15000 });   // no version of the user's yet
  await clickButton('nav[aria-label="Versions"]', 'New version');
  await page.waitForSelector('[role="dialog"] textarea', { timeout: 10000 });
  await typeField('Title', 'E2E Test Show');
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] input')].some(i => i.value === 'e2e-test-show'), { timeout: 10000 });
  await typeField('Concept', 'A test concept.');
  await enabledButton('[role="dialog"]', 'Draft storyboard');
  await clickButton('[role="dialog"]', 'Draft storyboard');
  await page.waitForFunction(() => location.pathname === '/versions/e2e-test-show', { timeout: 10000 });

  // Claude (the fake) drafts the storyboard; the inspector shows it, and Approve comes on.
  const inspector = '[aria-label="Inspector"]';
  await page.waitForFunction(s => document.querySelector(`${s} [data-testid="storyboard-markdown"]`)?.textContent.includes('What happens in chapter 9.'),
    { timeout: 120000, polling: 500 }, inspector);
  await enabledButton(inspector, 'Approve and build chapters', 30000);
  await clickButton(inspector, 'Approve and build chapters');

  // Nine chapter jobs (imported unchecked here, see STUDIO_TEST_SKIP_CHECK above): every block ends up written, with
  // no status (not broken, queued or being worked on).
  await page.waitForFunction(() => {
    const blocks = [...document.querySelectorAll('button[aria-pressed][aria-label^="Chapter "]')];
    return blocks.length === 9 && blocks.every(b => /, \d+:\d\d–\d+:\d\d$/.test(b.getAttribute('aria-label')));
  }, { timeout: 420000, polling: 1000 });
  const jobs = await api('/api/jobs?version=e2e-test-show');
  expect(jobs.map(j => `${j.kind} ${j.status}`).sort()).toEqual([...Array(9).fill('chapter done'), 'shared done', 'storyboard done']);
  const coverage = await api('/api/coverage/e2e-test-show');
  expect(Object.values(coverage.segments).every(k => typeof k === 'string')).toBe(true);
  expect(coverage.broken).toEqual([]);
  await page.waitForFunction(() => document.querySelector('nav[aria-label="Versions"] a[href="/versions/e2e-test-show"]')?.textContent.includes('ready'),
    { timeout: 10000 });
}), 600000);

slowTest('the preview plays: server-painted frames arrive and the coverage shading grows where it plays', step(async () => {
  // From chapter 8's start, the far end of the song from where the player has been painting ahead so far (from 0).
  // The shading is measured over the ten seconds played from there: the preview's own frames and its look-ahead fill
  // it, while the thumbnails job (the only other painter here) paints just two frames of it: 2971 (0.3 s into the
  // chapter) and 3168 (its middle).
  const start = CHAPTER_WINDOWS[7][0], first = Math.ceil(start * 24 - 1e-6), last = first + 239;
  await page.click('button[aria-pressed][aria-label^="Chapter 8"]');
  await page.waitForFunction(t => Math.abs(document.querySelector('[aria-label="Playhead"]').getAttribute('aria-valuenow') - t) < .1, { timeout: 10000 }, start);
  await page.waitForSelector('[data-painting="false"] canvas', { timeout: 60000 });
  const before = await page.evaluate(shadedIn, first, last), framesBefore = frameResponses.filter(r => r.startsWith('200')).length;
  // Room for the growth below: a window already (nearly) painted before Play would prove nothing.
  expect(before).toBeLessThanOrEqual(240 - 48);
  await clickButton('[data-painting]', 'Play');
  await page.waitForFunction(`(${shadedIn})(${first}, ${last}) >= ${before + 48}`, { timeout: 120000, polling: 250 });
  await page.waitForFunction(t => +document.querySelector('[aria-label="Playhead"]').getAttribute('aria-valuenow') > t, { timeout: 120000, polling: 250 }, start);
  expect(frameResponses.slice(framesBefore).some(r => /^200 \/api\/frames\/e2e-test-show\/\d+\.jpg$/.test(r))).toBe(true);
  expect(await page.evaluate(shadedIn, first, last)).toBeGreaterThanOrEqual(before + 48);
  // Stop it (Pause while playing; Cancel while it waits for frames).
  await page.evaluate(() => [...document.querySelectorAll('[data-painting] button')].find(b => ['Pause', 'Cancel'].includes(b.textContent.trim()))?.click());
}), 300000);

slowTest('a final render of a short range shows in the workspace, the library and the watch view', step(async () => {
  const token = await page.$eval('meta[name="studio-token"]', m => m.content);
  // Six frames (0.25 s), through the API: the UI's button always renders the whole song.
  const res = await fetch(`${url}/api/jobs`, { method: 'POST', headers: { origin: url, 'x-studio-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'render', versionId: 'e2e-test-show', params: { frames: '0:0.25' } }) });
  expect(res.status).toBe(201);
  await page.waitForSelector('a[href^="/versions/e2e-test-show/watch"]', { timeout: 180000 });
  const [render] = await api('/api/library');
  expect([render.version_id, render.duration_s]).toEqual(['e2e-test-show', .25]);

  await page.click('header a[href="/library"]');
  await page.waitForFunction(() => [...document.querySelectorAll('article img')].some(i => i.complete && i.naturalWidth > 0), { timeout: 10000 });
  expect(await page.$$eval('article h3', hs => hs.map(h => h.textContent))).toEqual(['The P(doom) Bake-Off']);
  await page.click('article a[href^="/versions/e2e-test-show/watch"]');
  await page.waitForSelector('video[data-testid="watch-video"]', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('video[data-testid="watch-video"]').readyState >= 1, { timeout: 10000 });
  // Exactly the range's 0.25 s, not the whole song.
  expect(await page.$eval('video[data-testid="watch-video"]', v => Math.abs(v.duration - .25) < .05)).toBe(true);
  expect(await page.$$eval('ol[aria-label="Walkthrough"] li', l => l.length)).toBe(9);
}), 240000);

slowTest('remix the Original, promote the remix, delete a version (its video stays in the library)', step(async () => {
  // Remix, from the Original's version menu.
  await page.click('nav[aria-label="Versions"] a[href="/versions/original"]');
  await page.waitForFunction(() => location.pathname === '/versions/original', { timeout: 10000 });
  await versionMenu('Remix…');
  await page.waitForFunction(() => document.querySelector('[role="dialog"] input')?.value.endsWith('(remix)'), { timeout: 10000 });
  await typeField('Title', 'E2E remix');
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] input')].some(i => i.value === 'e2e-remix'), { timeout: 10000 });
  await clickButton('[role="dialog"]', 'Remix');
  await page.waitForFunction(() => location.pathname === '/versions/e2e-remix', { timeout: 10000 });
  await noDialog();

  // Promote the remix: the dialog is accepted, and it's an example from then on (read-only: Remix is all its menu has).
  await versionMenu('Promote to an example…');
  await enabledButton('[role="dialog"]', 'Promote');
  await clickButton('[role="dialog"]', 'Promote');
  await noDialog();
  await page.waitForFunction(() => document.querySelector('nav[aria-label="Versions"] a[href="/versions/e2e-remix"]')?.textContent.includes('★'), { timeout: 10000 });
  expect((await api('/api/versions')).find(v => v.id === 'e2e-remix').example).toBe(true);
  await page.click('button[aria-label="Version actions"]');
  await page.waitForSelector('[role="menuitem"]', { timeout: 10000 });
  expect(await page.$$eval('[role="menuitem"]', ms => ms.map(m => m.textContent.trim()))).toEqual(['Remix…']);
  await page.keyboard.press('Escape');

  // Delete the version made above, keeping its video.
  await page.click('nav[aria-label="Versions"] a[href="/versions/e2e-test-show"]');
  await page.waitForFunction(() => location.pathname === '/versions/e2e-test-show', { timeout: 10000 });
  await versionMenu('Delete…');
  expect(await page.$eval('[role="dialog"] button[role="checkbox"]', b => b.getAttribute('data-state'))).toBe('unchecked');
  await page.type('[role="dialog"] input[data-slot="input"]', 'The P(doom) Bake-Off');
  await enabledButton('[role="dialog"]', 'Delete version');
  await clickButton('[role="dialog"]', 'Delete version');
  await page.waitForFunction(() => location.pathname === '/versions/original', { timeout: 10000 });   // the newest of the user's is gone
  await noDialog();
  expect(await page.$('nav[aria-label="Versions"] a[href="/versions/e2e-test-show"]')).toBeNull();
  expect((await api('/api/versions')).map(v => v.id)).not.toContain('e2e-test-show');
  await page.click('header a[href="/library"]');
  await page.waitForFunction(() => [...document.querySelectorAll('article h3')].map(h => h.textContent).join() === 'The P(doom) Bake-Off', { timeout: 10000 });
  expect((await api('/api/library')).map(r => [r.detached, r.title])).toEqual([[true, 'The P(doom) Bake-Off']]);
}), 120000);

slowTest('after a server restart, the next change shows the reload banner; a reload brings frames back', step(async () => {
  await page.click('nav[aria-label="Versions"] a[href="/versions/original"]');
  await page.waitForSelector('[data-painting="false"] canvas', { timeout: 60000 });
  server.kill('SIGTERM');
  await server.exited;
  ({ proc: server } = await startServer(port));   // same port and data: the page's address still works, its token doesn't

  // A change (clearing the frame cache) is refused for the old token: the banner asks for a reload.
  await page.click('button[aria-label="Settings"]');
  await enabledButton('body', 'Clear cache');
  await clickButton('body', 'Clear cache');
  const banner = '[role="alert"]';
  await page.waitForFunction(s => [...document.querySelectorAll(s)].some(a => a.textContent.includes('The studio server restarted — reload this page.')),
    { timeout: 10000 }, banner);
  const framesBefore = frameResponses.length;
  await clickButton(banner, 'Reload');
  await page.waitForFunction(() => location.pathname === '/versions/original' && document.querySelector('[aria-label="Playhead"]'), { timeout: 15000 });
  expect(await page.$$eval(banner, as => as.some(a => a.textContent.includes('restarted')))).toBe(false);
  await page.waitForSelector('[data-painting="false"] canvas', { timeout: 60000 });
  // Answered by the restarted server: painted, or (already in the browser's cache from before) revalidated.
  expect(frameResponses.slice(framesBefore).some(r => /^(200|304) \/api\/frames\/original\/\d+\.jpg$/.test(r))).toBe(true);
}), 180000);

slowTest("chapter code never ran in the browser: it loaded only the app's own Vite chunks as scripts", () => {
  expect(scripts.length).toBeGreaterThan(0);
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const own = new RegExp(`^${escaped}/app-assets/[\\w.-]+\\.js$`);
  expect(scripts.filter(u => !own.test(u))).toEqual([]);
  // No version code, snapshot, blob, work folder or engine page was ever requested, as a script or otherwise.
  expect(requests.filter(u => /\/v\/[^/]+\/.*\.js(\?|$)|\/api\/blob\/|\/api\/snapshot\/|\/work\/|\/studio\.html|\/src\/[\w.-]+\.js/.test(new URL(u).pathname))).toEqual([]);
  // No other page, frame or worker either.
  expect(targets.filter(t => !t.startsWith('page '))).toEqual([]);
  expect(page.frames()).toHaveLength(1);
  expect(pageErrors).toEqual([]);
  // Promote wrote to the private copy, and only to it: the copy changed (it's a rollback-journal database, so the write
  // is in the file itself) and holds the promoted version.
  expect(md5(repoDefaultDb)).toBe(repoDefaultBefore);
  expect(md5(defaultDb)).not.toBe(defaultCopyBefore);
  const copy = new Database(defaultDb, { readonly: true });
  try { expect(copy.query("select id from versions where id = 'e2e-remix'").get()).toEqual({ id: 'e2e-remix' }); } finally { copy.close(); }
});
