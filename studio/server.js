// server.js: `bun run studio`. Opens studio.db, imports the original version on first start, marks jobs a previous run
// left unfinished as interrupted, wires the job runners to the queue and serves the studio on loopback.
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { openDb } from './db.js';
import { importOriginal } from './versions.js';
import { createEvents } from './events.js';
import { createQueue } from './queue.js';
import { createClaudeRunner } from './claude-job.js';
import { createRenderRunner } from './render-job.js';
import { serve } from './serve.js';
import { acquireLock } from './lock.js';

const root = resolve(import.meta.dir, '..');
let port = +(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] ?? process.env.PORT ?? 8080);
if (port === 0) { const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }); port = probe.port; probe.stop(true); }

const dbPath = process.env.STUDIO_DB || join(root, 'studio.db');
let release;
try { release = acquireLock(dbPath, port); }
catch (err) { console.error(err.message); process.exit(1); }
process.on('exit', release);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

const db = openDb(dbPath);
if (importOriginal(db, root)) console.log('Imported the original version.');
const interrupted = db.markInterrupted();
if (interrupted) console.log(`${interrupted} unfinished job${interrupted === 1 ? '' : 's'} marked as interrupted (retry them in the studio).`);

const events = createEvents(), token = randomBytes(24).toString('hex'), baseUrl = `http://localhost:${port}`;
const claude = createClaudeRunner({ db, root, baseUrl, events });
const { render, thumbs } = createRenderRunner({ db, root, baseUrl, events });
const queue = createQueue({ db, events, runners: { storyboard: claude, shared: claude, chapter: claude, render, thumbs } });
const srv = serve({ db, root, token, queue, events, port });
queue.start();
console.log(`P(doom) Studio: ${srv.url}/`);
