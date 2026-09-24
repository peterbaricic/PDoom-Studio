// lock.js: one server per database. A lock file "<dbPath>.lock" next to the database records the pid and port of
// the server that holds it, so a second server started on the same database (by accident, or a leftover process)
// refuses to start instead of racing the first one to pick up the same jobs.
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function acquireLock(dbPath, port) {
  const lockPath = `${dbPath}.lock`;
  if (existsSync(lockPath)) {
    const held = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (alive(held.pid)) throw new Error(`another studio is already running on this database (pid ${held.pid}, http://localhost:${held.port}/)`);
  }
  const pid = process.pid;
  writeFileSync(lockPath, JSON.stringify({ pid, port }));
  return () => {
    if (!existsSync(lockPath)) return;
    try { if (JSON.parse(readFileSync(lockPath, 'utf8')).pid === pid) unlinkSync(lockPath); } catch {}
  };
}
