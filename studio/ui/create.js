// create.js: the Create tab. The version list, and one workspace per version with the four steps:
// concept → storyboard (review, edit, ask for changes, approve) → chapters (tiles, preview, feedback, history) → render.
import { api, get, h, on, fmtTime } from './app.js';
import { md } from './md.js';

const MODELS = [['', 'CLI default model'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const WINDOWS = [[0, 23], [23, 38.5], [38.5, 59], [59, 73], [73, 95.4], [95.4, 109.4], [109.4, 123.5], [123.5, 140.5], [140.5, 156.6]];
const STATUS = { concept: 'concept', storyboard: 'storyboard to review', approved: 'building chapters', chapters: 'chapters', ready: 'ready to render' };
const modelSelect = () => h('select.model', {}, MODELS.map(([v, l]) => h('option', { value: v }, l)));
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'version';
const fail = e => alert(e.message);

export async function renderCreate(view, id) {
  const side = h('aside.versions'), main = h('section.workspace');
  view.append(h('div.create', {}, side, main));
  const drawSide = async () => {
    const vs = await get('/api/versions');
    side.replaceChildren(h('h3', {}, 'Versions'),
      ...vs.map(v => h('a.version' + (v.id === id ? '.active' : ''), { href: `#/create/${v.id}` }, h('b', {}, v.title || v.id),
        h('small', {}, v.status === 'chapters' ? `chapters ${v.chapters}/9` : STATUS[v.status] || v.status))),
      h('a.button#new-version', { href: '#/create/new' }, '+ New version'));
  };
  await drawSide();
  let refresh = null;
  if (id === 'new') drawNew(main);
  else if (id) refresh = await drawVersion(main, id);
  else main.append(h('p.hint', {}, 'Pick a version on the left, or create a new one.'));

  let timer = null;
  return on((type, data) => {
    if (!['version', 'job'].includes(type)) return;
    clearTimeout(timer);
    timer = setTimeout(() => { drawSide(); if (refresh && (data.id === id || data.version_id === id)) refresh(); }, 250);
  });
}

function drawNew(main) {
  const title = h('input#concept-title', { placeholder: 'Title, e.g. The P(doom) Bake-Off' });
  const text = h('textarea#concept-text', { rows: 6, placeholder: 'Describe the idea: the setting, the story, the kind of jokes. The characters stay the same.' });
  const model = modelSelect();
  const go = h('button#draft-storyboard.needs-claude', { onclick: async () => {
    if (!title.value.trim() || !text.value.trim()) return alert('Give it a title and a concept.');
    go.disabled = true;
    try {
      const v = await api('POST', '/api/versions', { id: slug(title.value), title: title.value.trim(), concept: text.value.trim() });
      await api('POST', '/api/jobs', { kind: 'storyboard', versionId: v.id, model: model.value || null });
      location.hash = `#/create/${v.id}`;
    } catch (e) { go.disabled = false; fail(e); }
  } }, 'Draft storyboard');
  main.append(h('h2', {}, 'New version'), h('section.step', {}, h('h3', {}, '1 · Concept'), title, h('div', { style: 'height:8px' }), text, h('div.row', {}, model, go)));
}

async function drawVersion(main, id) {
  const heading = h('h2', {}, id), steps = h('ol.steps');
  // 1 · concept
  const conceptText = h('textarea#concept-text', { rows: 4 }), cModel = modelSelect();
  const redraft = h('button#draft-storyboard.needs-claude', { onclick: async () => {
    try {
      await api('PUT', `/api/versions/${id}`, { concept: conceptText.value });
      await api('POST', '/api/jobs', { kind: 'storyboard', versionId: id, model: cModel.value || null });
    } catch (e) { fail(e); }
  } }, 'Draft storyboard');
  // Engine options: the brush wipes between chapters and the corner P(doom) meter.
  const optToggle = (key, text) => {
    const box = h('input', { type: 'checkbox', style: 'width:auto', onchange: () => api('PUT', `/api/versions/${id}`, { options: { ...opts, [key]: box.checked } }).catch(fail) });
    return [box, h('label.option', {}, box, ' ' + text)];
  };
  let opts = {};
  const [wipesBox, wipesLabel] = optToggle('wipes', 'Brush wipes between chapters'), [meterBox, meterLabel] = optToggle('cornerMeter', 'Corner P(doom) meter');
  // 2 · storyboard
  const sbErrors = h('ul.errors'), sbView = h('div.storyboard'), sbEdit = h('textarea.sb-edit', { rows: 24, hidden: true });
  let editing = false;
  const editBtn = h('button', { onclick: async () => {
    if (!editing) { editing = true; sbEdit.hidden = false; sbView.hidden = true; editBtn.textContent = 'Save'; return; }
    try { await api('PUT', `/api/versions/${id}/files/STORYBOARD.md`, { content: sbEdit.value }); } catch (e) { return fail(e); }
    editing = false; sbEdit.hidden = true; sbView.hidden = false; editBtn.textContent = 'Edit text'; refresh();
  } }, 'Edit text');
  const sModel = modelSelect(), feedback = h('input#sb-feedback', { placeholder: 'Ask for changes, e.g. "set chapter 5 in a food truck"' });
  const approve = h('button#approve.needs-claude', { onclick: async () => {
    try { await api('POST', `/api/versions/${id}/approve`, { model: sModel.value || null }); } catch (e) { fail(e); }
  } }, 'Approve and build chapters');
  const ask = h('button.needs-claude', { onclick: async () => {
    if (!feedback.value.trim()) return;
    try { await api('POST', '/api/jobs', { kind: 'storyboard', versionId: id, params: { feedback: feedback.value.trim() }, model: sModel.value || null }); feedback.value = ''; }
    catch (e) { fail(e); }
  } }, 'Ask for changes');
  // 3 · chapters
  const tiles = h('div.tiles'), detail = h('div.detail');
  const thumbsBtn = h('button', { onclick: () => api('POST', '/api/jobs', { kind: 'thumbs', versionId: id }).catch(fail) }, 'Refresh thumbnails');
  // 4 · final render
  const renderBtn = h('button#final-render', { onclick: () => api('POST', '/api/jobs', { kind: 'render', versionId: id }).catch(fail) }, 'Final render (1080p MP4)');
  const renders = h('div.renders');

  main.append(heading, steps,
    h('section.step', {}, h('h3', {}, '1 · Concept'), conceptText, h('div.row', {}, cModel, redraft), h('div.row', {}, wipesLabel, meterLabel)),
    h('section.step', {}, h('h3', {}, '2 · Storyboard'), sbErrors, sbView, sbEdit, h('div.row', {}, approve, editBtn), h('div.row', {}, feedback, sModel, ask)),
    h('section.step', {}, h('h3', {}, '3 · Chapters'), tiles, h('div.row', {}, thumbsBtn), detail),
    h('section.step', {}, h('h3', {}, '4 · Final render'), h('div.row', {}, h('a.button', { href: `/watch.html?v=${id}`, target: '_blank' }, 'Full preview'), renderBtn), renders));

  // Chapter detail: built once per opened chapter so typed feedback survives refreshes; its history list refreshes.
  let open = null, history = null;
  function openChapter(n, m) {
    open = n;
    const [a] = WINDOWS[n - 1], fb = h('textarea', { rows: 3, placeholder: 'What should change in this chapter?' }), model = modelSelect();
    history = h('ul.history');
    detail.replaceChildren(
      h('h3', {}, `Chapter ${n}${m.walkthrough[n - 1] ? ' · ' + m.walkthrough[n - 1].name : ''}`),
      h('p.hint', {}, m.walkthrough[n - 1]?.text || ''),
      h('iframe', { src: `/watch.html?v=${id}&t=${a}&workers=1` }),
      fb, h('div.row', {}, model, h('button.needs-claude', { onclick: async () => {
        try { await api('POST', '/api/jobs', { kind: 'chapter', versionId: id, params: { chapter: n, feedback: fb.value.trim() || undefined }, model: model.value || null }); fb.value = ''; }
        catch (e) { fail(e); }
      } }, 'Revise chapter')),
      h('h4', {}, 'History'), history);
    drawHistory(m);
  }
  async function drawHistory(m) {
    const path = m.files.find(p => p.startsWith(`ch/c0${open}`));
    if (!path || !history) return history?.replaceChildren(h('li.hint', {}, 'Not written yet.'));
    const revs = await get(`/api/versions/${id}/revisions?path=${encodeURIComponent(path)}`);
    history.replaceChildren(...revs.map((r, i) => h('li', {}, `${new Date(r.created_at).toLocaleString()} · ${r.source}${r.note ? ' · ' + r.note : ''} `,
      i === 0 ? h('small.hint', {}, '(current)') : h('button', { onclick: () => api('POST', `/api/revisions/${r.id}/restore`).catch(fail) }, 'Restore'))));
  }

  async function refresh() {
    const [m, jobs] = await Promise.all([get(`/api/versions/${id}`), get(`/api/jobs?version=${id}`)]);
    heading.textContent = m.title || id;
    if (document.activeElement !== conceptText) conceptText.value = m.concept;
    opts = m.options; wipesBox.checked = !!m.options.wipes; meterBox.checked = !!m.options.cornerMeter;
    const stage = { concept: 0, storyboard: 1, approved: 2, chapters: 2, ready: 3 }[m.status] ?? 0;
    steps.replaceChildren(...['Concept', 'Storyboard', 'Chapters', 'Final render'].map((s, i) => h('li' + (i < stage ? '.done' : i === stage ? '.current' : ''), {}, s)));

    const sb = m.files.includes('STORYBOARD.md') ? await (await fetch(`/v/${id}/STORYBOARD.md`)).text() : '';
    if (!editing) {
      sbEdit.value = sb;
      sbView.innerHTML = sb ? md(sb) : '<p class="hint">No storyboard yet. Describe the concept and press "Draft storyboard".</p>';
    }
    const sbJob = jobs.find(j => j.kind === 'storyboard');
    sbErrors.replaceChildren(...(sbJob && ['queued', 'running'].includes(sbJob.status) ? [h('li.hint', {}, `Claude is ${sbJob.status === 'queued' ? 'about to write' : 'writing'} the storyboard…`)] : []),
      ...m.storyboardErrors.map(e => h('li', {}, e)));
    approve.disabled = !sb || m.storyboardErrors.length > 0 || m.files.some(p => p.startsWith('ch/'));

    tiles.replaceChildren(...WINDOWS.map(([a, b], i) => {
      const n = i + 1, path = m.files.find(p => p.startsWith(`ch/c0${n}`));
      const job = jobs.find(j => j.kind === 'chapter' && j.params.chapter === n);
      const state = job && ['queued', 'running'].includes(job.status) ? job.status : path ? 'done' : job?.status === 'failed' ? 'failed' : 'empty';
      return h(`div.tile.${state}`, { 'data-n': n, onclick: () => openChapter(n, m) },
        path ? h('img', { src: `/thumbs/${id}/c0${n}.jpg?r=${m.fileRevisions[path]}`, alt: '', onerror: e => e.target.remove() }) : null,
        h('b', {}, `${n} · ${m.walkthrough[i]?.name || 'Chapter ' + n}`),
        h('small', {}, `${fmtTime(a)}–${fmtTime(b)} · ${state === 'running' ? `writing… ${Math.round(job.progress * 100)}%` : state === 'empty' ? 'not written' : state}`));
    }));
    if (open) drawHistory(m);

    renders.replaceChildren(...jobs.filter(j => j.kind === 'render').slice(0, 3).map(j =>
      h('p', {}, `Render #${j.id}: ${j.status}${j.status === 'running' ? ` ${Math.round(j.progress * 100)}%` : ''}${j.status === 'done' ? ' · watch it in Play' : ''}`)));
  }
  await refresh();
  return refresh;
}
