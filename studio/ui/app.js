// app.js: the studio shell: tabs from the URL hash, the API helper (with the per-start token), live server events,
// and the job strip along the bottom.
import { renderCreate } from './create.js';
import { renderPlay } from './play.js';

const token = document.querySelector('meta[name="studio-token"]').content;

export async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-studio-token': token },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  // Every server start makes a new token, so a page left open across a restart has a stale one.
  if (res.status === 403 && data.error === 'missing or wrong token') throw new Error('The studio server restarted — reload this page.');
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}
export const get = path => api('GET', path);

// h('div.card', { onclick, href }, ...children). Only the md() output is ever passed as `html`, and md() escapes.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag.match(/^[\w-]*/)[0] || 'div');
  for (const [, sym, val] of tag.matchAll(/([.#])([\w-]+)/g)) sym === '#' ? (el.id = val) : el.classList.add(val);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

export const fmtTime = s => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

const listeners = new Set();
export const on = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const es = new EventSource('/api/events');
for (const type of ['job', 'log', 'version', 'library']) es.addEventListener(type, e => {
  const data = JSON.parse(e.data);
  for (const fn of listeners) fn(type, data);
});

export const health = get('/api/health').then(hl => {
  const say = text => { document.getElementById('health').textContent = text; };
  if (!hl.claude) { document.body.dataset.noclaude = ''; say('Claude Code CLI not found: creating is disabled'); }
  else if (hl.claudeSignedIn === false) say('Claude CLI is signed out — run `claude auth login` in a terminal');
  else if (!hl.ffmpeg) say('ffmpeg not found: final renders will fail');
  return hl;
});

let cleanup = null;
async function route() {
  cleanup?.(); cleanup = null;
  const [tab = 'create', arg] = location.hash.replace(/^#\/?/, '').split('/');
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  const view = document.getElementById('view');
  view.replaceChildren();
  cleanup = (tab === 'play' ? await renderPlay(view, arg) : await renderCreate(view, arg)) || null;
}
addEventListener('hashchange', route);

// ---------- job strip ----------
const strip = document.getElementById('jobs'), logDialog = document.getElementById('log');
let logJob = null;
export const jobKind = j => `${j.kind}${j.params.chapter ? ' ' + j.params.chapter : ''}`;
const label = j => `${jobKind(j)} · ${j.version_id} · ${j.status}` +
  (j.status === 'running' ? ` ${Math.round(j.progress * 100)}%` : '') + (j.cost_usd ? ` · $${j.cost_usd.toFixed(2)}` : '');

const jobsSummary = h('span.jobs-summary');
let jobsExpanded = false;
try { jobsExpanded = localStorage.getItem('studio-jobs-expanded') === '1'; } catch {}
const jobsToggle = h('button#jobs-toggle', { onclick: () => setJobsExpanded(!jobsExpanded) }, jobsExpanded ? 'Collapse' : 'Expand');
const jobsHeader = h('div.jobs-header', {}, jobsSummary, jobsToggle);
function setJobsExpanded(v) {
  jobsExpanded = v;
  strip.classList.toggle('expanded', jobsExpanded);
  jobsToggle.textContent = jobsExpanded ? 'Collapse' : 'Expand';
  try { localStorage.setItem('studio-jobs-expanded', jobsExpanded ? '1' : '0'); } catch {}
}
strip.append(jobsHeader);
strip.classList.toggle('expanded', jobsExpanded);
new ResizeObserver(() => { document.getElementById('view').style.paddingBottom = `${strip.offsetHeight + 16}px`; }).observe(strip);

async function drawJobs() {
  const recent = j => ['queued', 'running'].includes(j.status) || (['failed', 'interrupted'].includes(j.status) && Date.now() - (j.finished_at || 0) < 3600e3);
  const jobs = (await get('/api/jobs')).filter(recent);
  const running = jobs.filter(j => j.status === 'running').length, queued = jobs.filter(j => j.status === 'queued').length;
  jobsSummary.textContent = running || queued ? `Jobs: ${running} running · ${queued} queued` : 'No jobs running';
  strip.replaceChildren(jobsHeader, ...jobs.map(j => h(`div.job.${j.status}`, {}, label(j), j.error ? h('span', {}, '· ' + j.error.slice(0, 160)) : null,
    ['queued', 'running'].includes(j.status)
      ? h('button', { onclick: () => api('POST', `/api/jobs/${j.id}/cancel`) }, 'Cancel')
      : h('button', { onclick: () => api('POST', `/api/jobs/${j.id}/retry`) }, 'Retry'),
    h('button', { onclick: () => showLog(j.id) }, 'Log'))));
}
export async function showLog(id) {
  logJob = id;
  const job = await get(`/api/jobs/${id}`).catch(() => null);
  logDialog.querySelector('.log-title').textContent = job ? `${jobKind(job)} · ${job.version_id} · ${job.status}` : '';
  const pre = logDialog.querySelector('pre');
  pre.textContent = job?.log || '';
  logDialog.showModal();
  pre.scrollTop = pre.scrollHeight;
}
let pending = false;
on((type, data) => {
  if (type === 'log' && data.id === logJob && logDialog.open) {
    const pre = logDialog.querySelector('pre');
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 4;
    pre.append(data.text);
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }
  if (type === 'job' && !pending) { pending = true; setTimeout(() => { pending = false; drawJobs(); }, 300); }
});

if (!location.hash) location.hash = '#/create';
route(); drawJobs();
