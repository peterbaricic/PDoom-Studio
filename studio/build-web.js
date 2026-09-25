// build-web.js: builds studio/web (Vite) into studio/web/dist whenever it's stale — dist/index.html is missing, or
// any file under studio/web (besides dist/ itself) is newer than it. Used by studio/server.js at startup (`bun run
// studio`/`bun run dev`), and by test/app.test.js, which serves the built app directly without going through
// server.js. Idempotent and cheap once built: a fresh vite build here takes well under a second.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The newest mtime (ms) of any file under dir, skipping `skip` directory names (dist, node_modules): recursing into
// dist would compare its own output against itself, and node_modules never holds source this app cares about.
function newestMtime(dir, skip) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p, skip) : statSync(p).mtimeMs);
  }
  return newest;
}

// root: the repo root. Returns true if it rebuilt, false if the build was already fresh. Throws if the build fails.
export function buildWebIfStale(root, { log = () => {} } = {}) {
  const webDir = join(root, 'studio/web');
  const distIndex = join(webDir, 'dist/index.html');
  const stale = !existsSync(distIndex) || newestMtime(webDir, ['dist', 'node_modules']) > statSync(distIndex).mtimeMs;
  if (!stale) return false;
  log('Building studio/web (source changed since the last build)…');
  const vite = join(root, 'node_modules/.bin/vite');
  const res = Bun.spawnSync([vite, 'build', '--config', join(webDir, 'vite.config.ts')],
    { cwd: root, stdout: 'inherit', stderr: 'inherit', env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' } });
  if (!res.success) throw new Error(`building studio/web failed (vite exited with code ${res.exitCode})`);
  return true;
}
