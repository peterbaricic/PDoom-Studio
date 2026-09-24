// lock.js: one server per database. A lock file "<dbPath>.lock" next to the database records the pid and port of
// the server that holds it, so a second server started on the same database (by accident, or a leftover process)
// refuses to start instead of racing the first one to pick up the same jobs.
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const holder = lockPath => { try { const h = JSON.parse(readFileSync(lockPath, 'utf8')); return Number.isInteger(h?.pid) ? h : null; } catch { return null; } };

export function acquireLock(dbPath, port) {
  const lockPath = `${dbPath}.lock`, pid = process.pid;
  // Created with 'wx' (fails if the file exists), so of two servers starting at once only one gets it. A lock whose
  // holder is gone, or that is empty or unreadable (a crash while writing it), is stale and taken over.
  for (let tries = 0; ; tries++) {
    try { writeFileSync(lockPath, JSON.stringify({ pid, port }), { flag: 'wx' }); break; }
    catch (e) { if (e.code !== 'EEXIST' || tries >= 3) throw e; }
    const held = holder(lockPath);
    if (held && alive(held.pid)) throw new Error(`another studio is already running on this database (pid ${held.pid}, http://localhost:${held.port}/)`);
    try { unlinkSync(lockPath); } catch {}
  }
  return () => {
    if (!existsSync(lockPath)) return;
    try { if (JSON.parse(readFileSync(lockPath, 'utf8')).pid === pid) unlinkSync(lockPath); } catch {}
  };
}
