import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeJoin, serveFile, makeGuard } from '../studio/http.js';
import { createEvents } from '../studio/events.js';

const root = mkdtempSync(join(tmpdir(), 'root-'));
writeFileSync(join(root, 'a.txt'), '0123456789');
const outside = mkdtempSync(join(tmpdir(), 'out-'));
writeFileSync(join(outside, 'secret.txt'), 'secret');
symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));

test('safeJoin keeps paths inside the root', () => {
  expect(safeJoin(root, 'a.txt')).toEndWith('a.txt');
  expect(safeJoin(root, '../' + outside.split('/').pop() + '/secret.txt')).toBeNull();
  expect(safeJoin(root, 'link.txt')).toBeNull();
  expect(safeJoin(root, 'missing.txt')).toBeNull();
  expect(safeJoin(root, '')).toBeNull();
});

test('serveFile supports ranges', async () => {
  const file = join(root, 'a.txt');
  const full = await serveFile(new Request('http://x/a.txt'), file);
  expect(full.status).toBe(200);
  expect(await full.text()).toBe('0123456789');
  const part = await serveFile(new Request('http://x/a.txt', { headers: { range: 'bytes=2-4' } }), file);
  expect(part.status).toBe(206);
  expect(part.headers.get('content-range')).toBe('bytes 2-4/10');
  expect(await part.text()).toBe('234');
  const tail = await serveFile(new Request('http://x/a.txt', { headers: { range: 'bytes=-3' } }), file);
  expect(await tail.text()).toBe('789');
});

const guard = makeGuard({ port: () => 8080, token: 'tok' });
const req = (method, headers) => new Request('http://localhost:8080/api/x', { method, headers: { host: 'localhost:8080', ...headers } });

test('guard allows GETs from allowed hosts and blocks foreign hosts', () => {
  expect(guard(req('GET'))).toBeNull();
  expect(guard(req('GET', { host: 'w2.localhost:8080' }))).toBeNull();
  expect(guard(req('GET', { host: 'evil.com:8080' })).status).toBe(403);
  expect(guard(req('GET', { host: 'localhost:9999' })).status).toBe(403);
});

test('guard needs token and same origin for changes', () => {
  expect(guard(req('POST', { origin: 'http://localhost:8080', 'x-studio-token': 'tok' }))).toBeNull();
  expect(guard(req('POST', { origin: 'http://localhost:8080' })).status).toBe(403);
  expect(guard(req('POST', { origin: 'http://evil.com', 'x-studio-token': 'tok' })).status).toBe(403);
  expect(guard(req('DELETE', { origin: 'http://w0.localhost:8080', 'x-studio-token': 'tok' })).status).toBe(403);
  expect(guard(req('OPTIONS', { origin: 'http://evil.com' })).status).toBe(403);
});

test('extraOrigins (--dev) accepts the Vite dev server\'s origin too, only when given', () => {
  const devGuard = makeGuard({ port: () => 8080, token: 'tok', extraOrigins: ['http://localhost:5173'] });
  expect(devGuard(req('POST', { origin: 'http://localhost:5173', 'x-studio-token': 'tok' }))).toBeNull();
  expect(devGuard(req('POST', { origin: 'http://evil.com', 'x-studio-token': 'tok' })).status).toBe(403);
  // without it (the default, plain `guard` above), that same origin is refused like any other outside origin
  expect(guard(req('POST', { origin: 'http://localhost:5173', 'x-studio-token': 'tok' })).status).toBe(403);
});

// Another site's page can make the user's browser send a GET here (an <img>, a link, a no-cors fetch): the browser
// says so in Sec-Fetch-Site, and some GETs have effects (a frame request queues a paint) or tell what exists.
test('guard refuses any /api request another site made, whatever its method', () => {
  const at = (method, path, headers, host = 'localhost:8080') => new Request(`http://${host}${path}`, { method, headers: { host, ...headers } });
  for (const site of ['cross-site', 'same-site']) {
    for (const [method, path] of [['GET', '/api/versions'], ['GET', '/api/frames/a/1.jpg'], ['GET', '/api/health'], ['POST', '/api/jobs']]) {
      const res = guard(at(method, path, { 'sec-fetch-site': site, origin: 'http://localhost:8080', 'x-studio-token': 'tok' }));
      expect([site, method, path, res?.status]).toEqual([site, method, path, 403]);
    }
  }
  // the studio's own page (same-origin), an address typed in (none), or a client that sends no such header
  expect(guard(at('GET', '/api/versions', { 'sec-fetch-site': 'same-origin' }))).toBeNull();
  expect(guard(at('GET', '/api/versions', { 'sec-fetch-site': 'none' }))).toBeNull();
  expect(guard(at('GET', '/api/versions'))).toBeNull();
  // what isn't an API (a finished video, the song) stays loadable from anywhere
  expect(guard(at('GET', '/library/a.mp4', { 'sec-fetch-site': 'cross-site' }))).toBeNull();
});

test('guard needs the token for the frame and coverage GETs on UI hosts', () => {
  const at = (path, headers, host = 'localhost:8080') => new Request(`http://${host}${path}`, { headers: { host, ...headers } });
  for (const path of ['/api/frames/a/1.jpg', '/api/frames/a/1.jpg?prio=prefetch', '/api/coverage/a']) {
    expect([path, guard(at(path))?.status]).toEqual([path, 403]);
    expect([path, guard(at(path, { 'x-studio-token': 'wrong' }))?.status]).toEqual([path, 403]);
    expect([path, guard(at(path, { 'x-studio-token': 'tok', 'sec-fetch-site': 'same-origin' }))]).toEqual([path, null]);
    // (renderer hosts don't serve them at all: that's the app's 404, not the guard's)
    expect([path, guard(at(path, {}, 'w0.localhost:8080'))]).toEqual([path, null]);
  }
  // other GETs stay token-free
  expect(guard(at('/api/versions'))).toBeNull();
});

// A stream opens with a hello naming this server run, so a page whose stream came back from a restart can tell.
test('every SSE stream opens with a hello naming the server run: the same for every stream of one run, another for the next', async () => {
  const hello = async ev => {
    const ctrl = new AbortController();
    const reader = ev.stream(new Request('http://x/api/events', { signal: ctrl.signal })).body.getReader();
    let text = '';
    while (!text.includes('event: hello\n')) text += new TextDecoder().decode((await reader.read()).value);
    while (!text.endsWith('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    return JSON.parse(/event: hello\ndata: (.*)\n\n/.exec(text)[1]).boot;
  };
  const run = createEvents(), next = createEvents();
  const first = await hello(run);
  expect(first).toMatch(/^[\w-]{8,}$/);
  expect(await hello(run)).toBe(first);
  expect(await hello(next)).not.toBe(first);
});

test('events reach subscribers and the SSE stream', async () => {
  const ev = createEvents(), seen = [];
  const off = ev.subscribe(e => seen.push(e));
  ev.publish('job', { id: 1 });
  off(); ev.publish('job', { id: 2 });
  expect(seen).toEqual([{ type: 'job', data: { id: 1 } }]);

  const ctrl = new AbortController();
  const res = ev.stream(new Request('http://x/api/events', { signal: ctrl.signal }));
  expect(res.headers.get('content-type')).toBe('text/event-stream');
  const reader = res.body.getReader();
  ev.publish('job', { id: 3 });
  let text = '';
  while (!text.includes('"id":3')) text += new TextDecoder().decode((await reader.read()).value);
  expect(text).toContain('event: job\ndata: {"id":3}\n\n');
  ctrl.abort();
});
