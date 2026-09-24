// serve.js: start the studio app on loopback (IPv4 and, where available, IPv6). Background renderers load from
// w0.localhost, w1.localhost, …, which resolve to either address.
import { createApp } from './app.js';

export const NO_QUEUE = new Proxy({}, { get: () => () => { throw new Error('jobs are not available here'); } });

export function serve({ db, root, data = root, token, queue = NO_QUEUE, events, port = 8080 }) {
  const app = createApp({ db, root, data, token, queue, events, port });
  const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: app.fetch, idleTimeout: 0 });
  app.port = server.port;
  let server6 = null;
  try { server6 = Bun.serve({ hostname: '::1', port: server.port, fetch: app.fetch, idleTimeout: 0 }); } catch {}
  return { app, server, server6, port: server.port, url: `http://localhost:${server.port}`, stop() { server.stop(true); server6?.stop(true); } };
}
