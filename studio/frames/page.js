// page.js: opens studio.html in the sealed render browser (studio/browser.js) with the page-level guards every painting
// page gets, from render.mjs and the studio's painting pool (studio/frames/pool.js) alike.
//
// Underneath everything here, the browser itself can reach no host but the studio's port (see launchBrowser in
// studio/browser.js). The CSP blocks chapter code from fetching or XHR-ing out, but not from navigating the top-level
// page away or from opening a popup — so a painting page keeps its own net to catch those as well. Only requests to
// the page's own origin are allowed; the fonts studio.html uses are bundled, so no other origin ever needs to load.
//
// onConsole(message) and onPageError(error) get the page's console messages (minus one harmless warning, below) and
// uncaught errors; onRequest(request) sees every request the page makes (allowed or not). waitUntil is goto's
// (render.mjs waits for the network to go idle; the pool, which paints straight away, doesn't wait for the song to
// finish buffering). recordScriptErrors keeps { file, message } for each uncaught error in window.scriptErrors, so the
// pool can tell which chapter's script threw while the page loaded.
// Resolves once window.ready is true; the caller checks window.loadError. Every step is bounded by readyTimeout, and
// on any failure the page is closed before the error is passed on.
export async function openSealedPage(browser, url, { onConsole, onPageError, onRequest, waitUntil = 'networkidle0', readyTimeout = 60000, recordScriptErrors = false } = {}) {
  const allowedOrigin = new URL(url).origin;
  const bounded = (promise, what) => {
    let timer;
    return Promise.race([promise, new Promise((_, bad) => { timer = setTimeout(() => bad(new Error(`${what} took over ${readyTimeout / 1000} s`)), readyTimeout); })])
      .finally(() => clearTimeout(timer));
  };
  const opening = browser.newPage();
  let page;
  try { page = await bounded(opening, 'opening a page'); }
  catch (e) { opening.then(p => p.close()).catch(() => {}); throw e; }
  try {
    // window.open never even gets chapter code a target to send data with — closing one after the fact (below) is too
    // late: Chrome dispatches a popup's first request as soon as the target exists, before we can hear about it.
    await bounded(page.evaluateOnNewDocument(record => {
      window.open = () => null;
      // A same-tab navigation away (location.href = …, a link, a form) starts with beforeunload; cancelling it here
      // keeps the current document live, instead of racing to abort the network request after the browser already
      // committed to unloading (which reliably wedges the renderer — the page never becomes ready). src/loader.js
      // cancels such navigations even earlier, through the Navigation API; this stays as the next line. It needs
      // studio.html's sandbox to allow modals: without allow-modals, Chrome skips the prompt and lets the page go.
      addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = ''; });
      if (record) addEventListener('error', e => { (window.scriptErrors ||= []).push({ file: e.filename || '', message: e.message }); });
    }, recordScriptErrors), 'preparing the page');
    // A beforeunload prompt is silently skipped for a frame that's never had real input, so it needs one gesture below
    // to make the cancellation above actually take effect.
    page.on('dialog', d => d.dismiss().catch(() => {}));
    // Belt and suspenders for any popup that slips past the override above (document.open(url, name, features) and a
    // target=_blank link do, though studio.html's sandbox now refuses popups altogether): closed immediately, and
    // network-dead regardless.
    page.on('popup', async popup => {
      await popup.setRequestInterception(true).catch(() => {});
      popup.on('request', request => request.abort('aborted').catch(() => {}));
      await popup.close().catch(() => {});
    });
    await bounded(page.setRequestInterception(true), 'preparing the page');
    page.on('request', request => {
      onRequest?.(request);
      let origin; try { origin = new URL(request.url()).origin; } catch { origin = null; }
      // 'aborted' (net::ERR_ABORTED), not the default 'failed': a live top-level navigation should never reach here
      // (beforeunload cancels it first), but if it ever did, ERR_FAILED would commit an error page in its place.
      // Both calls can reject (e.g. the request already finished by the time we act on it, a race Chrome allows) —
      // caught so that doesn't surface as an unhandled rejection.
      if (origin === allowedOrigin) request.continue().catch(() => {}); else request.abort('aborted').catch(() => {});
    });
    page.on('console', m => {
      // Chrome says this of studio.html's CSP sandbox (see studio/app.js) as if it were an iframe's sandbox attribute,
      // the kind a same-origin parent's script could remove. A header's can't be; it isn't worth printing on every render.
      if (/both allow-scripts and allow-same-origin for its sandbox attribute/.test(m.text())) return;
      onConsole?.(m);
    });
    page.on('pageerror', e => onPageError?.(e));
    // The chapter scripts that follow load asynchronously (waited for below via window.ready) and could try to
    // navigate away as soon as they run, so the gesture that arms beforeunload has to land as soon as there's a
    // document for it to land on — at domcontentloaded, well before that — not after goto's own networkidle0 wait,
    // which only settles once everything, including a malicious attempt, has already happened. A key press, not a
    // mouse click: p5 tracks mouseX/mouseY/mouseIsPressed and would fire mousePressed() off a synthetic click, which
    // no sketch reads today but would still be this code nudging a chapter's own state. Tab counts as "real" input to
    // Chrome's activation tracking the same way a click does (a bare modifier like Shift does not — verified: with
    // only Shift pressed, beforeunload is silently skipped exactly as with no input at all), and nothing in the
    // engine listens for it, so it's otherwise inert.
    // RENDER_TEST_NO_GESTURE exists only so a test can render with and without this gesture and diff the pixels —
    // it's never set outside that one test.
    if (!process.env.RENDER_TEST_NO_GESTURE) page.once('domcontentloaded', () => { page.keyboard.press('Tab').catch(() => {}); });
    await page.goto(url, { waitUntil, timeout: readyTimeout });
    // Polled on a timer, not the default requestAnimationFrame: a page that isn't the browser's front tab (the pool
    // opens several at once) gets no animation frames, and would never be seen to become ready.
    // A page that loads but never becomes ready (a script still running) is marked so: error.notReady.
    await page.waitForFunction('window.ready === true', { timeout: readyTimeout, polling: 100 }).catch(e => { e.notReady = true; throw e; });
  } catch (e) {
    await page.close().catch(() => {});
    throw e;
  }
  return page;
}
