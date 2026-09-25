// server.js: `bun run studio`. Migrates an old single-database studio.db if one is found, opens user.db (attaching
// studio/default.db read-only for the examples), marks jobs a previous run left unfinished as interrupted, wires the
// job runners to the queue and serves the studio on loopback.
// STUDIO_DATA picks another data folder (default: the project) for user.db, .studio/ and library/; USER_DB another
// user database (default: user.db in the data folder; STUDIO_DB is accepted as an alias); DEFAULT_DB another
// examples database (default: studio/default.db in the project, since it is code, not data).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { openDb } from './db.js';
import { migrateLegacyDb } from './migrate.js';
import { createEvents } from './events.js';
import { createQueue } from './queue.js';
import { createClaudeRunner } from './claude-job.js';
import { createRenderRunner } from './render-job.js';
import { serve } from './serve.js';
import { acquireLock } from './lock.js';
import { createCache } from './frames/cache.js';
import { createPool } from './frames/pool.js';
import { createFrameService } from './frames/service.js';
import { buildWebIfStale } from './build-web.js';

const root = resolve(import.meta.dir, '..');
let port = +(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] ?? process.env.PORT ?? 8080);
if (port === 0) { const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }); port = probe.port; probe.stop(true); }
// --dev: the studio server accepts requests from the Vite dev server's own origin (studio/web/vite.config.ts's dev
// server on 5173, proxying everything through to here) besides its own — never on by default, since it widens who
// may drive the studio. `bun run dev` passes this; `bun run studio` never does.
const dev = process.argv.includes('--dev');

const data = process.env.STUDIO_DATA ? resolve(process.env.STUDIO_DATA) : root;
const userPath = process.env.USER_DB || process.env.STUDIO_DB || join(data, 'user.db');
const defaultPath = process.env.DEFAULT_DB || join(root, 'studio/default.db');

// The frame cache's cap in GB (default 5) and the number of painting pages (default 3): refused if they aren't sane,
// rather than silently running with a cache of NaN bytes or no painter at all.
const cacheGb = Number(process.env.STUDIO_CACHE_GB ?? 5), painters = Number(process.env.STUDIO_PAINTERS ?? 3);
if (!(Number.isFinite(cacheGb) && cacheGb > 0)) { console.error(`STUDIO_CACHE_GB must be a positive number of gigabytes, not "${process.env.STUDIO_CACHE_GB}"`); process.exit(1); }
if (!(Number.isInteger(painters) && painters >= 1 && painters <= 8)) { console.error(`STUDIO_PAINTERS must be a whole number from 1 to 8, not "${process.env.STUDIO_PAINTERS}"`); process.exit(1); }

// Refuse to start rather than silently running with no examples: a missing default.db almost certainly means a
// misconfigured DEFAULT_DB, not an intentionally examples-free studio.
if (!existsSync(defaultPath)) {
  console.error(`no examples database at ${defaultPath} — restore the committed one (git checkout studio/default.db), or set `
    + 'DEFAULT_DB to another (bun studio/build-default.js --from studio/default.db <out.db> makes a copy)');
  process.exit(1);
}

// studio/web/dist is what studio/app.js serves the SPA from; build it now if it's missing or stale, so `bun run
// studio` (and `bun run dev`, which still serves the built app on the studio's own port even though the Vite dev
// server on 5173 is what the browser actually talks to) always has something current to serve.
buildWebIfStale(root, { log: console.log });

// The legacy studio.db, if any, is looked for beside userPath, not at the fixed project root: with USER_DB and
// STUDIO_DATA left at their defaults that's the same directory, but when either points elsewhere (as every test does,
// to stay off the real project's files), migration stays confined there too instead of reaching for the real studio.db.
try { migrateLegacyDb(dirname(userPath), { userPath }); }
catch (err) { console.error(err.message); process.exit(1); }

let release;
try { release = acquireLock(userPath, port); }
catch (err) { console.error(err.message); process.exit(1); }
process.on('exit', release);

const db = openDb(userPath, { defaultPath });
const interrupted = db.markInterrupted();
if (interrupted) console.log(`${interrupted} unfinished job${interrupted === 1 ? '' : 's'} marked as interrupted (retry them in the studio).`);

const events = createEvents(), token = randomBytes(24).toString('hex'), baseUrl = `http://localhost:${port}`;
// --dev: the Vite dev server (a separate process, studio/web/vite.config.ts) needs this same token to inject into
// the page it serves on 5173, and has no other way to learn it — so it's written here, to a file only this user can
// read, and read back by a Vite plugin on every request while the dev server runs.
if (dev) {
  const devTokenPath = join(data, '.studio/dev-token');
  mkdirSync(dirname(devTokenPath), { recursive: true });
  // Created 600 (never briefly readable by others between the write and the chmod); the chmod is for a file that
  // already existed with looser permissions, which writeFileSync's mode leaves alone.
  writeFileSync(devTokenPath, token, { mode: 0o600 });
  chmodSync(devTokenPath, 0o600);
  console.warn(`--dev: also accepting requests from http://localhost:5173 (the Vite dev server) — never run this against real data.`);
}
// Previews and final renders share one frame cache, painted by one sealed browser that talks only to this server.
const cache = createCache({ dir: join(data, '.studio/cache/frames'), capBytes: cacheGb * 1e9 });
const pool = createPool({ port, baseUrl, painters, onPainted: ({ key, frame, jpeg, deps }) => cache.put(key, frame, jpeg, deps) });
const frames = createFrameService({ db, cache, pool, events, root });
const claude = createClaudeRunner({ db, root, data, baseUrl, events });
const { render, thumbs } = createRenderRunner({ db, root, data, events, frames });
const queue = createQueue({ db, events, runners: { storyboard: claude, shared: claude, chapter: claude, render, thumbs } });
const srv = serve({ db, root, data, token, queue, events, port, frames, dev });
// Stopping, close the painting browser too (at most a few seconds' wait), so it doesn't outlive the studio.
const stop = async () => { await Promise.race([pool.close(), Bun.sleep(5000)]); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
queue.start();
console.log(`P(doom) Studio: ${srv.url}/`);
