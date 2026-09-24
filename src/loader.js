// loader.js: loads one version's own scripts (shared.js, then the chapters) from the studio server and applies its
// engine options. ?v=<id> loads a version from the database, ?work=<jobId> a job's work folder; default: the original.
window.ENGINE = { wipes: true, cornerMeter: true };
// p5's own global-mode init (on window 'load', just before it calls setup()) reassigns a `VERSION` global of its
// own, clobbering an early `window.VERSION` set here. The promise's resolved value lets core.js re-apply the
// manifest to window.VERSION from inside setup(), after p5 has already claimed the name.
window.versionLoaded = (async () => {
  const q = new URLSearchParams(location.search), work = q.get('work'), id = q.get('v') || 'original';
  const [manifestUrl, base] = work ? [`/api/work/${work}`, `/work/${work}/`] : [`/api/versions/${id}`, `/v/${id}/`];
  const m = await (await fetch(manifestUrl)).json();
  if (m.error) throw new Error(m.error);
  Object.assign(window.ENGINE, m.options);
  window.VERSION = m;
  for (const s of m.scripts) {
    await new Promise((ok, bad) => {
      const el = document.createElement('script');
      el.src = base + s; el.onload = ok; el.onerror = () => bad(new Error('could not load ' + s));
      document.head.append(el);
    });
  }
  return m;
})();
