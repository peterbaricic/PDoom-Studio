// build-web.js: builds studio/web (Vite) into studio/web/dist whenever it's stale. It's stale when dist/index.html is
// missing, when any file under studio/web (besides dist/ itself) is newer than it, or when dist/.build-stamp doesn't
// say the build was a production one. Used by studio/server.js at startup (`bun run studio`/`bun run dev`), and by
// test/app.test.js, which serves the built app directly without going through server.js. Idempotent and cheap once
// built: a fresh vite build here takes well under a second.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// What dist/.build-stamp holds after a build this module made. The mode is always production: `bun test` runs with
// NODE_ENV=test, and a vite build that inherits it bundles React's development build, which nothing but mtimes would
// ever replace. A dist without this stamp (a `bun run build`, or one from before the stamp existed) is rebuilt once.
const STAMP = 'production\n';

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

// Why studio/web/dist needs building, or null when it's fresh.
export function staleReason(webDir) {
  const distIndex = join(webDir, 'dist/index.html'), stamp = join(webDir, 'dist/.build-stamp');
  if (!existsSync(distIndex)) return 'there is no build yet';
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== STAMP) return 'the last build was not a production build';
  if (newestMtime(webDir, ['dist', 'node_modules']) > statSync(distIndex).mtimeMs) return 'source changed since the last build';
  return null;
}

function viteBuild(root, webDir) {
  const vite = join(root, 'node_modules/.bin/vite');
  const res = Bun.spawnSync([vite, 'build', '--config', join(webDir, 'vite.config.ts')], {
    cwd: root, stdout: 'inherit', stderr: 'inherit',
    env: { ...process.env, NODE_ENV: 'production', VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
  });
  if (!res.success) throw new Error(`building studio/web failed (vite exited with code ${res.exitCode})`);
}

// root: the repo root. Returns true if it rebuilt, false if the build was already fresh. Throws if the build fails.
// build: what does the building (tests stub it); it has to leave dist/index.html behind.
export function buildWebIfStale(root, { log = () => {}, build = viteBuild } = {}) {
  const webDir = join(root, 'studio/web');
  const reason = staleReason(webDir);
  if (!reason) return false;
  log(`Building studio/web (${reason})…`);
  build(root, webDir);
  writeFileSync(join(webDir, 'dist/.build-stamp'), STAMP);
  return true;
}
