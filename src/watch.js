// watch.js: the player behind watch.html. Frames are rendered in the background by studio.html?worker iframes,
// kept in memory as JPEGs, and played in sync with the song once nothing can make playback stutter.
//
// Renderers are loaded from their own origins (w0.localhost, w1.localhost, …), so the browser runs each in a separate
// process and this page stays responsive while they paint. They all share the browser's GPU process, though, which
// caps total speed at roughly 3–4 frames/s however many there are, and starves this page's drawing if they keep going
// during playback. So rendering pauses while the song plays, and playing is safe once every frame from the playhead
// to the end is rendered. Nothing is left to chance: the frames exist before Play starts.
//
// The countdown to that point is an estimate. Rendering starts with one frame per second of the song, which gives a
// cost profile (choruses cost several times more than verses); every other frame's cost is interpolated from its
// measured neighbours, and the remaining queue is scheduled across the renderers.
const FPS = 24, DUR = 156.6, N = Math.ceil(DUR * FPS);
const OUT_W = 1280, OUT_H = 720, JPEG_Q = .85;
const q = new URLSearchParams(location.search);
// Beyond ~3 renderers the shared GPU process is the limit, so more add memory, not speed.
const WORKERS = +q.get('workers') || Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 4) / 2)));

const $ = id => document.getElementById(id);
const view = $('view'), vx = view.getContext('2d'), seekC = $('seek'), sx = seekC.getContext('2d');
const song = $('song'), btn = $('play'), nowBtn = $('playnow'), stateEl = $('state'), statsEl = $('stats'), timeEl = $('time');

const blobs = new Array(N), cost = new Float64Array(N);   // finished frames, and how long each took (ms)
const PROBES = Math.ceil(N / FPS);
let done = 0, probesLeft = PROBES;
let ph = Math.min(N - 1, +(q.get('t') || 0) * FPS | 0);   // playhead, as a frame index
let mode = 'paused';                                        // paused | waiting (to start once safe) | playing
const finishedAt = [];                                      // completion timestamps, for the throughput readout
let calib = 1;                                              // actual / estimated cost of interpolated frames, averaged
let stoppedAt = null;                                       // where "Play now" ran out of rendered frames
let lastSafe = Infinity;                                    // latest countdown, for the button label

const fmt = s => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// ---------- renderers ----------
const workers = [];
function startWorkers(sameOrigin) {
  $('workers').replaceChildren(); workers.length = 0;
  for (let k = 0; k < (sameOrigin ? 1 : WORKERS); k++) {
    const origin = sameOrigin ? location.origin : `${location.protocol}//w${k}.localhost:${location.port}`;
    const el = document.createElement('iframe');
    el.src = `${origin}/studio.html?worker&v=${encodeURIComponent(q.get('v') || 'original')}&parent=${encodeURIComponent(location.origin)}`;
    $('workers').append(el);
    workers.push({ el, origin, ready: false, job: null });
  }
}
// A browser that doesn't resolve *.localhost gets one renderer on this origin instead (it shares this page's thread).
setTimeout(() => { if (!workers.some(w => w.ready)) startWorkers(true); }, 30000);

addEventListener('message', e => {
  const w = workers.find(w => e.source === w.el.contentWindow && e.origin === w.origin);
  if (!w) return;
  if (e.data.type === 'ready') w.ready = true;
  else if (e.data.type === 'frame' && w.job && e.data.i === w.job.i) {
    const { i, blob } = e.data;
    if (!blobs[i]) { blobs[i] = blob; done++; if (i % FPS === 0) probesLeft--; }
    cost[i] = performance.now() - w.job.t0; finishedAt.push(performance.now());
    if (w.job.est) calib += (Math.min(3, cost[i] / w.job.est) - calib) * .05;
    w.job = null;
    if (mode !== 'playing' && i === nearestDone(ph)) show(i);
  }
  pump();
});

// Render order: the one-per-second probes first, then every frame from the playhead to the end, then the start.
function queue() {
  const busy = new Set(workers.filter(w => w.job).map(w => w.job.i)), seen = new Uint8Array(N), out = [];
  const add = i => { if (!blobs[i] && !busy.has(i) && !seen[i]) { seen[i] = 1; out.push(i); } };
  for (let i = Math.ceil(ph / FPS) * FPS; i < N; i += FPS) add(i);
  for (let i = 0; i < ph; i += FPS) add(i);
  for (let i = ph; i < N; i++) add(i);
  for (let i = 0; i < ph; i++) add(i);
  return out;
}
function pump() {
  if (mode === 'playing') return;
  const idle = workers.filter(w => w.ready && !w.job); if (!idle.length) return;
  const next = queue(), est = probesLeft ? null : estimates();
  for (const w of idle) {
    const i = next.shift(); if (i == null) return;
    w.job = { i, t0: performance.now(), est: est && est[i] / calib };   // the uncalibrated guess, to keep calibrating
    w.el.contentWindow.postMessage({ i, t: i / FPS, w: OUT_W, h: OUT_H, q: JPEG_Q }, w.origin);
  }
}

// ---------- the countdown ----------
// Estimated cost (ms) of every frame: measured if rendered, else interpolated between the nearest measured frames and
// scaled by how far such interpolations have been off so far.
function estimates() {
  const est = new Float64Array(N), known = [];
  for (let i = 0; i < N; i++) if (cost[i]) known.push(i);
  const mean = known.length ? known.reduce((s, i) => s + cost[i], 0) / known.length : 400;
  for (let i = 0, k = 0; i < N; i++) {
    if (cost[i]) { est[i] = cost[i]; continue; }
    while (k < known.length && known[k] < i) k++;
    const a = known[k - 1], b = known[k];
    est[i] = calib * (a == null && b == null ? mean : a == null ? cost[b] : b == null ? cost[a] : cost[a] + (cost[b] - cost[a]) * (i - a) / (b - a));
  }
  return est;
}
// Seconds until every frame from the playhead to the end is rendered (safe), and until everything is.
function forecast() {
  const est = estimates(), now = performance.now(), live = workers.filter(w => w.ready);
  if (!live.length) return { safe: Infinity, all: Infinity };
  const left = w => w.job ? Math.max(0, (est[w.job.i] - (now - w.job.t0)) / 1000) : 0;
  const free = live.map(left); let safe = 0;
  for (const w of live) if (w.job && w.job.i >= ph) safe = Math.max(safe, left(w));
  for (const i of queue()) {
    let m = 0; for (let k = 1; k < free.length; k++) if (free[k] < free[m]) m = k;
    free[m] += est[i] / 1000;
    if (i >= ph) safe = Math.max(safe, free[m]);
  }
  return { safe, all: Math.max(...free) };
}
const safeNow = () => { for (let i = ph; i < N; i++) if (!blobs[i]) return false; return true; };
// How far playback could get from frame i before reaching a missing frame, in seconds.
const aheadOf = i => { let k = i; while (k < N && blobs[k]) k++; return (k - i) / FPS; };

// ---------- playback ----------
const bitmaps = new Map();   // frame index → Promise<ImageBitmap>, a few frames around the playhead while playing
const bitmap = i => {
  if (!bitmaps.has(i) && blobs[i]) bitmaps.set(i, createImageBitmap(blobs[i]).catch(() => { bitmaps.delete(i); return null; }));
  return bitmaps.get(i);
};
let shown = -1;
async function show(i) {
  if (i < 0 || !blobs[i]) return;
  // Paused previews use a throwaway bitmap; during playback frameLoop keeps the cache warm and trims it.
  const cached = bitmaps.get(i), b = await (cached || createImageBitmap(blobs[i]));
  if (!b) return;
  vx.drawImage(b, 0, 0, OUT_W, OUT_H); shown = i;
  if (!cached) b.close();
}
function nearestDone(i) { for (let d = 0; d < N; d++) { if (blobs[i - d]) return i - d; if (blobs[i + d]) return i + d; } return -1; }

function play() {
  if (mode === 'playing') { if (audioLive) song.pause(); else setMode('paused'); return; }
  if (mode === 'waiting') { setMode('paused'); return; }
  if (ph >= N - 1) ph = 0;
  if (safeNow()) startPlayback(); else { setMode('waiting'); tick(); }
}
// Renders already in flight when playback starts would compete for the GPU for up to a second, so the song starts
// once they finish (no new ones are sent while playing).
let audioLive = false;
async function startPlayback() {
  setMode('playing');
  while (workers.some(w => w.job)) { await new Promise(r => setTimeout(r, 20)); if (mode !== 'playing') return; }
  for (let k = 0; k < 8 && ph + k < N; k++) bitmap(ph + k);
  audioLive = true; song.muted = false; song.currentTime = ph / FPS; song.play();
  requestAnimationFrame(frameLoop);
}
// Browsers only let a page start sound after a user gesture. Playing (muted) once on the first click or key press
// unlocks the audio element, so starting later, after waiting, still makes sound.
const unlock = () => {
  removeEventListener('pointerdown', unlock); removeEventListener('keydown', unlock);
  if (audioLive) return;
  song.muted = true; song.play().then(() => { if (!audioLive) { song.pause(); song.muted = false; } }, () => { song.muted = false; });
};
addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);
// "Play now" plays whatever is rendered from the playhead on. If it reaches a missing frame, it pauses there and waits
// like Play does, until the rest can play to the end without stopping, so it stops at most once.
function playNow() { if (mode !== 'playing' && blobs[ph]) startPlayback(); }
function setMode(m) { mode = m; if (m !== 'playing') audioLive = false; if (m !== 'waiting') stoppedAt = null; buttons(); pump(); }
function buttons() {
  btn.textContent = mode === 'playing' ? 'Pause' : mode === 'waiting' ?
    (probesLeft || !isFinite(lastSafe) ? 'Cancel (measuring…)' : `Cancel (starts in ${fmt(lastSafe)})`) : 'Play';
  const ahead = aheadOf(ph);
  nowBtn.hidden = mode === 'playing' || ahead < 1 || safeNow();
  nowBtn.textContent = `Play now (${fmt(ahead)} ready)`;
}
song.addEventListener('pause', () => { if (mode === 'playing' && audioLive) setMode('paused'); });
song.addEventListener('ended', () => setMode('paused'));

function frameLoop() {
  if (mode !== 'playing') return;
  const i = Math.min(N - 1, Math.floor(song.currentTime * FPS));
  ph = i;
  if (!blobs[i]) { setMode('waiting'); song.pause(); stoppedAt = i; tick(); return; }   // "Play now" ran out, or a seek
  if (i !== shown) show(i);
  for (let k = 1; k <= 8 && i + k < N; k++) bitmap(i + k);
  for (const [j, p] of bitmaps) if (j < i - 2 || j > i + 12) { bitmaps.delete(j); p.then(b => b?.close()); }
  drawSeek();
  requestAnimationFrame(frameLoop);
}

// ---------- seek bar: rendered frames shaded, playhead on top ----------
function drawSeek() {
  const w = seekC.width = seekC.clientWidth * devicePixelRatio, h = seekC.height = 18 * devicePixelRatio;
  sx.fillStyle = '#3a3542'; sx.fillRect(0, 0, w, h);
  const cols = Math.min(w, N);
  for (let c = 0; c < cols; c++) {
    const a = Math.floor(c * N / cols), b = Math.floor((c + 1) * N / cols); let d = 0;
    for (let i = a; i < b; i++) if (blobs[i]) d++;
    if (d) { sx.fillStyle = d === b - a ? '#8fd18a' : '#5d7d5a'; sx.fillRect(c * w / cols, 0, Math.ceil(w / cols), h); }
  }
  sx.fillStyle = '#fff'; sx.fillRect(ph / N * w - devicePixelRatio, 0, 2 * devicePixelRatio, h);
  timeEl.textContent = `${fmt(ph / FPS)} / ${fmt(DUR)}`;
}
function seekTo(e) {
  const r = seekC.getBoundingClientRect(); ph = Math.max(0, Math.min(N - 1, Math.round((e.clientX - r.left) / r.width * N)));
  stoppedAt = null;
  if (audioLive) song.currentTime = ph / FPS; else if (mode !== 'playing') show(nearestDone(ph));
  drawSeek(); pump();
}
seekC.addEventListener('pointerdown', e => { seekC.setPointerCapture(e.pointerId); seekTo(e); });
seekC.addEventListener('pointermove', e => { if (e.buttons) seekTo(e); });
btn.addEventListener('click', play);
nowBtn.addEventListener('click', playNow);
addEventListener('keydown', e => { if (e.code === 'Space' && e.target.tagName !== 'BUTTON') { e.preventDefault(); play(); } });

// ---------- status ----------
const t0 = performance.now();
function tick() {
  const ready = workers.filter(w => w.ready).length, now = performance.now(), rest = N - done;
  while (finishedAt.length && finishedAt[0] < now - 10000) finishedAt.shift();
  const rate = finishedAt.length / Math.max(1, Math.min(10, (now - t0) / 1000));
  const { safe, all } = forecast(), profiled = probesLeft === 0, from = fmt(ph / FPS);
  lastSafe = safe;
  let s, cls = 'wait';
  if (mode === 'playing') { s = !audioLive ? 'Starting…' : rest ? 'Playing (rendering continues when paused)' : 'Playing'; cls = 'ok'; }
  else if (safeNow()) {
    s = rest ? `Ready: plays from ${from} to the end without stopping` : 'Fully rendered';
    cls = 'ok';
    if (mode === 'waiting') startPlayback();
  }
  else if (!ready) s = 'Starting renderers…';
  else if (!profiled) s = `Measuring how heavy each scene is… ${Math.round((1 - probesLeft / PROBES) * 100)}%`;
  else if (stoppedAt != null) s = `Stopped at ${fmt(stoppedAt / FPS)}, where rendering has got to. Continues by itself in about ${fmt(safe)}, ` +
    'once the rest can play to the end without stopping';
  else s = `${mode === 'waiting' ? 'Starts automatically' : `Safe to play from ${from}`} in about ${fmt(safe)}` +
    (aheadOf(ph) >= 1 ? `  (${fmt(aheadOf(ph))} already rendered from here: "Play now" plays it)` : '');
  stateEl.textContent = s; stateEl.className = cls;
  statsEl.textContent = `Rendered ${done} / ${N} frames (${Math.floor(done / N * 100)}%)  ·  ${ready} renderer${ready === 1 ? '' : 's'}` +
    `  ·  ${rate.toFixed(1)} frames/s` + (rest && profiled && mode !== 'playing' && isFinite(all) ? `  ·  all done in about ${fmt(all)}` : '');
  if (mode !== 'playing') drawSeek();
  buttons();
}
if (location.protocol === 'file:') stateEl.textContent = 'Run `bun run studio` and open it from there instead of opening this file directly.';
else { startWorkers(false); setInterval(tick, 250); addEventListener('resize', drawSeek); drawSeek(); }
