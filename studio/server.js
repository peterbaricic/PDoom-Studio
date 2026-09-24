// server.js: `bun run studio`. Migrates an old single-database studio.db if one is found, opens user.db (attaching
// studio/default.db read-only for the examples), marks jobs a previous run left unfinished as interrupted, wires the
// job runners to the queue and serves the studio on loopback.
// STUDIO_DATA picks another data folder (default: the project) for user.db, .studio/ and library/; USER_DB another
// user database (default: user.db in the data folder; STUDIO_DB is accepted as an alias); DEFAULT_DB another
// examples database (default: studio/default.db in the project, since it is code, not data).
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { openDb } from './db.js';
import { migrateLegacyDb } from './migrate.js';
import { createEvents } from './events.js';
import { createQueue } from './queue.js';
import { createClaudeRunner } from './claude-job.js';
import { createRenderRunner } from './render-job.js';
import { serve } from './serve.js';
import { acquireLock } from './lock.js';

const root = resolve(import.meta.dir, '..');
let port = +(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] ?? process.env.PORT ?? 8080);
if (port === 0) { const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }); port = probe.port; probe.stop(true); }

const data = process.env.STUDIO_DATA ? resolve(process.env.STUDIO_DATA) : root;
const userPath = process.env.USER_DB || process.env.STUDIO_DB || join(data, 'user.db');
const defaultPath = process.env.DEFAULT_DB || join(root, 'studio/default.db');

// Refuse to start rather than silently running with no examples: a missing default.db almost certainly means a
// misconfigured DEFAULT_DB, not an intentionally examples-free studio.
if (!existsSync(defaultPath)) {
  console.error(`no examples database at ${defaultPath} — restore the committed one (git checkout studio/default.db), or set `
    + 'DEFAULT_DB to another (bun studio/build-default.js --from studio/default.db <out.db> makes a copy)');
  process.exit(1);
}

// The legacy studio.db, if any, is looked for beside userPath, not at the fixed project root: with USER_DB and
// STUDIO_DATA left at their defaults that's the same directory, but when either points elsewhere (as every test does,
// to stay off the real project's files), migration stays confined there too instead of reaching for the real studio.db.
try { migrateLegacyDb(dirname(userPath), { userPath }); }
catch (err) { console.error(err.message); process.exit(1); }

let release;
try { release = acquireLock(userPath, port); }
catch (err) { console.error(err.message); process.exit(1); }
process.on('exit', release);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

const db = openDb(userPath, { defaultPath });
const interrupted = db.markInterrupted();
if (interrupted) console.log(`${interrupted} unfinished job${interrupted === 1 ? '' : 's'} marked as interrupted (retry them in the studio).`);

const events = createEvents(), token = randomBytes(24).toString('hex'), baseUrl = `http://localhost:${port}`;
const claude = createClaudeRunner({ db, root, data, baseUrl, events });
const { render, thumbs } = createRenderRunner({ db, root, data, baseUrl, events });
const queue = createQueue({ db, events, runners: { storyboard: claude, shared: claude, chapter: claude, render, thumbs } });
const srv = serve({ db, root, data, token, queue, events, port });
queue.start();
console.log(`P(doom) Studio: ${srv.url}/`);
