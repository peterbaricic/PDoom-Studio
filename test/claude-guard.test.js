import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { openDb } from '../studio/db.js';
import { createApp } from '../studio/app.js';
import { createEvents } from '../studio/events.js';
import { isolatedEnv, tempDir } from './helpers.js';

// Resolved from this file, not the working directory: run from anywhere else, the comparison must still hold.
const fake = `bun ${join(import.meta.dir, 'fake-claude.js')}`;

// test/preload.js (bunfig.toml) pins it: without it, anything that asks the Claude CLI (the health check's
// `claude auth status` included) would run the real one.
test('every test process has CLAUDE_BIN pointing at the fake Claude, and so do the servers tests spawn', () => {
  expect(process.env.CLAUDE_BIN).toBe(fake);
  expect(isolatedEnv(tempDir()).CLAUDE_BIN).toBe(fake);
});

test('an app made without a claudeBin asks the fake whether Claude is signed in', async () => {
  // checked first: without the preload, the health check below would run the real CLI's `claude auth status`
  expect(process.env.CLAUDE_BIN).toBe(fake);
  const app = createApp({ db: openDb(':memory:'), root: join(import.meta.dir, '..'), data: tempDir(), token: 'tok', queue: {}, events: createEvents(), port: 18999 });
  const res = await app.fetch(new Request('http://localhost:18999/api/health', { headers: { host: 'localhost:18999' } }));
  // bun is on PATH (it's running this); the fake always answers signed in
  expect(await res.json()).toMatchObject({ claude: true, claudeSignedIn: true });
});
