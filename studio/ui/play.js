// play.js: the Play tab. A gallery with the latest render of each version, and a watch page: the video beside a
// walkthrough that follows playback, plus how the version was made.
import { api, get, h, on, fmtTime } from './app.js';
import { md } from './md.js';

export async function renderPlay(view, rid) {
  const off = on(type => { if (type === 'library') dispatchEvent(new HashChangeEvent('hashchange')); });
  if (rid) await drawWatch(view, +rid); else await drawGallery(view);
  return off;
}

async function drawGallery(view) {
  const renders = await get('/api/library'), latest = new Map();
  for (const r of renders) if (!latest.has(r.version_id)) latest.set(r.version_id, r);
  if (!latest.size) return view.append(h('p.hint', {}, 'Nothing rendered yet. Finish a version in Create and press "Final render".'));
  view.append(h('div.gallery', {}, [...latest.values()].map(r => h('a.card', { href: `#/play/${r.id}` },
    h('img', { src: `/library/${r.poster}`, alt: '' }), h('b', {}, r.title || r.version_id), h('small', {}, r.logline),
    h('small', {}, `Rendered ${new Date(r.created_at).toLocaleDateString()}`)))));
}

async function drawWatch(view, rid) {
  const renders = await get('/api/library'), r = renders.find(x => x.id === rid);
  if (!r) return view.append(h('p.hint', {}, 'This render no longer exists. ', h('a', { href: '#/play' }, 'Back to Play')));
  const vid = r.version_id;
  const [m, jobs, hist] = await Promise.all([get(`/api/versions/${vid}`), get(`/api/jobs?version=${vid}`), get(`/api/versions/${vid}/history`)]);
  const storyboard = m.files.includes('STORYBOARD.md') ? await (await fetch(`/v/${vid}/STORYBOARD.md`)).text() : '';

  const video = h('video', { src: `/library/${r.file}`, poster: `/library/${r.poster}`, controls: true, preload: 'metadata' });
  const items = m.walkthrough.map(c => h('li', { onclick: () => { video.currentTime = c.start + .01; video.play(); } },
    h('span.time', {}, fmtTime(c.start)), h('b', {}, c.name), h('p', {}, c.text)));
  const sync = () => {
    const t = video.currentTime;
    m.walkthrough.forEach((c, i) => {
      const now = t >= c.start && t < c.end;
      if (now && !items[i].classList.contains('current')) items[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      items[i].classList.toggle('current', now);
    });
  };
  video.addEventListener('timeupdate', sync); video.addEventListener('seeked', sync); sync();

  const notes = hist.filter(x => x.note && ['claude', 'manual'].includes(x.source) && !/ job$/.test(x.note));
  const cost = jobs.reduce((s, j) => s + (j.cost_usd || 0), 0), others = renders.filter(x => x.version_id === vid && x.id !== rid);
  view.append(
    h('div.watch', {},
      h('div#player', {}, video, h('h2', {}, m.title || vid), h('p.hint', {}, m.logline)),
      h('ol.walkthrough', {}, items)),
    h('section.made', {},
      h('h3', {}, 'How it was made'),
      h('p', {}, h('b', {}, 'Concept: '), m.concept),
      h('p.hint', {}, `${hist.length} revisions · ${notes.length} rounds of feedback` + (cost ? ` · Claude cost $${cost.toFixed(2)}` : '') +
        ` · rendered ${new Date(r.created_at).toLocaleString()} in ${Math.max(1, Math.round(r.render_s / 60))} min`),
      notes.length ? h('ul', {}, notes.map(x => h('li', {}, h('small.hint', {}, `${x.path}: `), x.note))) : null,
      storyboard ? h('details', {}, h('summary', {}, 'Storyboard'), h('div.storyboard', { html: md(storyboard) })) : null,
      others.length ? h('p', {}, 'Earlier renders: ', others.map(o => h('a', { href: `#/play/${o.id}` }, new Date(o.created_at).toLocaleString() + '  '))) : null,
      h('p', {}, h('button', { onclick: async () => {
        if (!confirm('Delete this render? The video file is removed; the version itself stays in Create.')) return;
        await api('DELETE', `/api/library/${rid}`); location.hash = '#/play';
      } }, 'Delete this render'))));
}
