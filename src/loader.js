// loader.js: loads one version's own scripts (shared.js, then the chapters) from the studio server and applies its
// engine options. ?v=<id> loads a version from the database, ?work=<jobId> a job's work folder, ?snapshot=<id> a
// content-addressed snapshot (its scripts are already full /api/blob/<sha> URLs); default: the original.
// CAST: guest characters shared between chapters (e.g. for the curtain call). With ?record-cast (the studio's painting
// pool, studio/frames/pool.js), it remembers which script defined each entry, and window.castRecorder collects the
// entries a painted frame reads (paintAt in core.js returns them), so the frame cache knows which other chapters a
// frame depends on: { key, path } for each, path being the defining script's, or null for an entry no script defined.
const CAST = new URLSearchParams(location.search).has('record-cast') ? (() => {
  const definedBy = new Map();
  let loading = null, reads = null;
  window.castRecorder = {
    loading(path) { loading = path; },
    begin() { reads = new Map(); },
    end() { const r = [...(reads || [])].map(([key, path]) => ({ key, path })); reads = null; return r; },
  };
  const read = (o, k) => { if (reads && typeof k === 'string') reads.set(k, Object.hasOwn(o, k) ? definedBy.get(k) ?? null : null); };
  const define = k => { if (typeof k === 'string') definedBy.set(k, loading); };
  return new Proxy({}, {
    get(o, k) { read(o, k); return Reflect.get(o, k); },
    has(o, k) { read(o, k); return Reflect.has(o, k); },
    getOwnPropertyDescriptor(o, k) { read(o, k); return Reflect.getOwnPropertyDescriptor(o, k); },
    // Listing the entries depends on which exist at all, like reading one nobody defined.
    ownKeys(o) { if (reads) reads.set('(all entries)', null); return Reflect.ownKeys(o); },
    set(o, k, v) { define(k); return Reflect.set(o, k, v); },
    defineProperty(o, k, d) { define(k); return Reflect.defineProperty(o, k, d); },
  });
})() : {};
window.ENGINE = { wipes: true, cornerMeter: true };

// Before any version code runs, take away the ways out that studio.html's policy can't block. This matters most in the
// user's own browser, where the player's workers run chapter code with none of the render browser's network isolation
// (studio/browser.js); there, it's what stands between chapter code and:
// - navigating its own frame to another host (location, links, <meta http-equiv=refresh>, even from a fresh
//   about:blank realm): every navigation the page itself starts is cancelled. The Navigation API fires its navigate
//   event before any request goes out, for those as well; a reload or address-bar navigation by the user can't be
//   cancelled from here and isn't. preventDefault is bound now, so chapter code replacing Event.prototype's later
//   can't disarm it, and the listener can't be removed without a reference to it.
// - WebRTC, whose STUN and TURN traffic no CSP covers. Only this window's constructors go: chapter code can still take
//   RTCPeerConnection from a fresh about:blank iframe (frame-src 'none' doesn't stop those), so this is a speed bump.
// (In a block, so none of this becomes a global name that could clash with a version's own.)
{
  const cancel = Function.prototype.call.bind(Event.prototype.preventDefault);
  window.navigation?.addEventListener('navigate', e => cancel(e));
  delete window.RTCPeerConnection;
  delete window.webkitRTCPeerConnection;
}

// p5's own global-mode init (on window 'load', just before it calls setup()) reassigns a `VERSION` global of its
// own, clobbering an early `window.VERSION` set here. The promise's resolved value lets core.js re-apply the
// manifest to window.VERSION from inside setup(), after p5 has already claimed the name.
window.versionLoaded = (async () => {
  const rec = window.castRecorder, q = new URLSearchParams(location.search), snapshot = q.get('snapshot'), work = q.get('work'), id = q.get('v') || 'original';
  const [manifestUrl, base] = snapshot ? [`/api/snapshot/${snapshot}`, '']
    : work ? [`/api/work/${work}`, `/work/${work}/`] : [`/api/versions/${id}`, `/v/${id}/`];
  const m = await (await fetch(manifestUrl)).json();
  if (m.error) throw new Error(m.error);
  Object.assign(window.ENGINE, m.options);
  window.VERSION = m;
  for (const [i, s] of m.scripts.entries()) {
    // A snapshot's scripts are blob URLs; its paths name them.
    rec?.loading(m.paths?.[i] ?? s);
    await new Promise((ok, bad) => {
      const el = document.createElement('script');
      el.src = base + s; el.onload = ok; el.onerror = () => bad(new Error('could not load ' + s));
      document.head.append(el);
    });
  }
  rec?.loading(null);
  return m;
})();
