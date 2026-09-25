import { mkdtempSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CHAPTER_WINDOWS } from '../studio/storyboard.js';

export const goodStoryboard = () => [
  '---', 'title: The P(doom) Bake-Off', 'logline: Clawd and the Researcher bake a superintelligence.', '---', '',
  '# Storyboard', '',
  ...CHAPTER_WINDOWS.flatMap(([a, b], i) => [`## ${i + 1} · Chapter ${i + 1} (${a}–${b})`, `Walkthrough: What happens in chapter ${i + 1}.`, '', '| shot | ... |', '']),
].join('\n');

export const tempDir = (prefix = 'studio-data-') => mkdtempSync(join(tmpdir(), prefix));

// A private copy of the repo's studio/default.db. Tests that need the examples database (for the Original, or as a
// target for promoteVersion) make one of these once per file and reuse it, instead of touching the repo's own copy.
export const tempDefaultDb = () => {
  const p = join(tempDir('default-db-'), 'default.db');
  cpSync(join(process.cwd(), 'studio/default.db'), p);
  return p;
};

// Tests never touch the repo's user.db, studio.db, studio/default.db, .studio/ or library/ (a studio may be running
// on them): spawned servers and render.mjs runs get a throwaway data root, a user database inside it, and a copy of
// the examples database, all pinned here so that a USER_DB, STUDIO_DB or DEFAULT_DB set in the shell can never
// point a test at real files. (USER_DB wins over STUDIO_DB, its alias, so pinning it is enough.) The examples copy
// is shared by every isolatedEnv in the process: read-only by convention — a test that promotes passes its own.
let sharedDefaultDb = null;
export const isolatedEnv = (data = tempDir(), extra = {}) =>
  ({ ...process.env, STUDIO_DATA: data, USER_DB: join(data, 'user.db'), DEFAULT_DB: sharedDefaultDb ??= tempDefaultDb(), ...extra });

// Stand-ins for outside hosts, one per name: a raw TCP listener each (plus one UDP socket, `udp`) on 127.0.0.1 that
// records every connection or datagram, whether or not a request ever follows — a bare preconnect or a TURN allocation
// is a leak too. One listener per name, so a hit says which attempt got through. Loopback, but on ports other than the
// studio's, which the render browser treats like any outside host (see studio/browser.js). (Not 127.0.0.2: macOS
// doesn't alias the whole of 127.0.0.0/8 the way Linux does.)
export async function captureHosts(names) {
  const hits = {}, listeners = {};
  const record = (name, what) => ((hits[name] ??= []).push(what), hits[name].length - 1);
  for (const name of names) {
    listeners[name] = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: {
      // Counted as soon as it connects; the first line it sends, if any, replaces the placeholder.
      open(s) { s.data = { i: record(name, '(connection, no data)'), first: true }; },
      data(s, d) {
        if (s.data.first) { s.data.first = false; hits[name][s.data.i] = Buffer.from(d).toString('latin1').split('\r\n')[0].slice(0, 80); }
        s.end();
      },
      close() {}, error() {},
    } });
  }
  const udp = await Bun.udpSocket({ hostname: '127.0.0.1', port: 0, socket: { data(s, buf) { record('udp', `(datagram, ${buf.length} bytes)`); } } });
  return {
    hits,
    port: name => name === 'udp' ? udp.port : listeners[name].port,
    url: name => `http://127.0.0.1:${listeners[name].port}`,
    stop() { for (const l of Object.values(listeners)) l.stop(true); udp.close(); },
  };
}
