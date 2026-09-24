// serve.mjs: static file server for watching the video live in any browser.
//   node serve.mjs [--port=8080]   then open http://localhost:8080/ for the player (watch.html) or /studio.html for the scrubber
// Listens on loopback only. The player's background renderers load from w0.localhost, w1.localhost, … so each gets its
// own browser process; *.localhost resolves to 127.0.0.1 or ::1, hence both.
import { createServer } from 'node:http';
import { createReadStream, statSync, realpathSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const port = +(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || 8080);
const root = realpathSync(resolve('.'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  // Only serve regular files inside the project (symlinks resolved), never anything above it.
  let file, st; try { file = realpathSync(join(root, normalize('/' + decodeURIComponent(path === '/' ? '/watch.html' : path)))); st = statSync(file); } catch {}
  if (!file?.startsWith(root + sep) || !st?.isFile()) { res.writeHead(404).end('not found'); return; }
  const type = TYPES[extname(file)] || 'application/octet-stream';
  // Range support, so the audio element can seek.
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const a = m[1] ? +m[1] : st.size - +m[2], b = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': b - a + 1, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Accept-Ranges': 'bytes' });
    createReadStream(file, { start: a, end: b }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    createReadStream(file).pipe(res);
  }
});
server.listen(port, '127.0.0.1', () => console.log(`player: http://localhost:${port}/   scrubber: http://localhost:${port}/studio.html`));
// A second listener on IPv6 loopback, skipped quietly where IPv6 is unavailable.
const server6 = createServer((req, res) => server.emit('request', req, res));
server6.on('error', () => {}).listen(port, '::1');
