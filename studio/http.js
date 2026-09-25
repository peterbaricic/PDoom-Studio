// http.js: small HTTP building blocks: contained static files with Range support, JSON replies, and the guard that
// keeps other websites from driving the studio.
import { realpathSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

export function safeJoin(root, rel) {
  if (!rel) return null;
  try {
    const base = realpathSync(root), file = realpathSync(join(base, normalize('/' + rel)));
    return file.startsWith(base + sep) && statSync(file).isFile() ? file : null;
  } catch { return null; }
}

export async function serveFile(req, file, headers = {}) {
  const f = Bun.file(file), size = f.size, type = f.type || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (m && (m[1] || m[2])) {
    const a = m[1] ? +m[1] : Math.max(0, size - +m[2]), b = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (a > b || a >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    return new Response(f.slice(a, b + 1), { status: 206, headers: { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', ...headers } });
  }
  return new Response(f, { headers: { 'content-type': type, 'accept-ranges': 'bytes', ...headers } });
}

export const json = (data, status = 200) => Response.json(data, { status });
export const error = (status, message) => Response.json({ error: message }, { status });

// Every request must name one of our hosts (blocks DNS rebinding). Changes must also come from the studio's own
// origin and carry the per-start token, which only the studio page knows. extraOrigins: additional Origins to accept
// besides the studio's own — used only in --dev mode (studio/server.js), to accept the Vite dev server's own origin
// (http://localhost:5173) while it proxies its requests through to this server (see studio/web/vite.config.ts).
export function makeGuard({ port, token, extraOrigins = [] }) {
  const hostOk = h => { const p = port(); return [`localhost:${p}`, `127.0.0.1:${p}`, `[::1]:${p}`].includes(h) || new RegExp(`^w\\d+\\.localhost:${p}$`).test(h); };
  const originOk = o => { const p = port(); return [`http://localhost:${p}`, `http://127.0.0.1:${p}`, `http://[::1]:${p}`, ...extraOrigins].includes(o); };
  return req => {
    if (!hostOk(req.headers.get('host') || '')) return error(403, 'unknown host');
    if (req.method === 'OPTIONS') return error(403, 'cross-origin requests are not allowed');
    if (req.method === 'GET' || req.method === 'HEAD') return null;
    if (!originOk(req.headers.get('origin') || '')) return error(403, 'wrong origin');
    if (req.headers.get('x-studio-token') !== token) return error(403, 'missing or wrong token');
    return null;
  };
}
