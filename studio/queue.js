// queue.js: runs studio jobs from the database. Claude jobs and render jobs are separate lanes with their own limits
// (renders share the one GPU, so one at a time). A job can wait for another (chapters wait for the shared setup).
export const LANES = { storyboard: 'claude', shared: 'claude', chapter: 'claude', render: 'render', thumbs: 'render' };

export function createQueue({ db, events, runners, limits = { claude: 3, render: 1 } }) {
  const running = new Map();                      // job id → { lane, ctrl }
  let started = false, waiters = [];
  const publish = id => events.publish('job', db.getJob(id));

  function enqueue({ kind, versionId, params = {}, model = null }) {
    if (!LANES[kind]) throw new Error(`unknown job kind: ${kind}`);
    const id = db.addJob({ kind, versionId, params, model });
    publish(id); schedule();
    return id;
  }

  function approve(versionId, model) {
    const shared = enqueue({ kind: 'shared', versionId, model });
    const chapters = Array.from({ length: 9 }, (_, i) => enqueue({ kind: 'chapter', versionId, params: { chapter: i + 1, after: shared }, model }));
    db.updateVersion(versionId, { status: 'approved' });
    events.publish('version', { id: versionId });
    return [shared, ...chapters];
  }

  function cancel(id) {
    const job = db.getJob(id);
    if (!job) return false;
    if (job.status === 'queued') { db.updateJob(id, { status: 'cancelled', finished_at: Date.now() }); publish(id); schedule(); return true; }
    if (job.status === 'running' && running.has(id)) { running.get(id).ctrl.abort(); return true; }
    return false;
  }

  // A retried job waits for the same job as before, unless that one can no longer finish (it failed or was cancelled
  // meanwhile): then for the newest shared job of the version that can, or for nothing if the version already has
  // its shared.js. Otherwise it keeps waiting, and retrying the shared job moves it along (repointDependents).
  function retry(id) {
    const job = db.getJob(id);
    if (!job || !['failed', 'cancelled', 'interrupted'].includes(job.status)) throw new Error('only failed, cancelled or interrupted jobs can be retried');
    let params = job.params;
    if (params.after != null && !['queued', 'running', 'done'].includes(db.getJob(params.after)?.status)) {
      const [shared] = db.findJobs({ versionId: job.version_id, kinds: ['shared'], statuses: ['queued', 'running', 'done'] });
      if (shared) params = { ...params, after: shared.id };
      else if (db.getFile(job.version_id, 'shared.js')) { const { after, ...rest } = params; params = rest; }
    }
    const next = enqueue({ kind: job.kind, versionId: job.version_id, params, model: job.model });
    db.repointDependents(id, next);
    schedule();
    return next;
  }

  const laneCount = lane => [...running.values()].filter(r => r.lane === lane).length;
  const ready = job => job.params.after == null || db.getJob(job.params.after)?.status === 'done';

  function schedule() {
    if (!started) return;
    for (const job of db.queuedJobs()) {
      const lane = LANES[job.kind];
      if (laneCount(lane) >= (limits[lane] ?? 1) || !ready(job)) continue;
      run(job, lane);
    }
    if (!running.size && !db.queuedJobs().some(ready)) { waiters.forEach(w => w()); waiters = []; }
  }

  async function run(job, lane) {
    const ctrl = new AbortController();
    running.set(job.id, { lane, ctrl });
    db.updateJob(job.id, { status: 'running', started_at: Date.now(), progress: 0, error: null });
    publish(job.id);
    const ctx = {
      signal: ctrl.signal,
      log: text => { db.appendLog(job.id, text); events.publish('log', { id: job.id, text }); },
      progress: p => { db.updateJob(job.id, { progress: Math.max(0, Math.min(1, p)) }); publish(job.id); },
      cost: usd => { db.updateJob(job.id, { cost_usd: usd }); publish(job.id); },
    };
    try {
      await runners[job.kind](db.getJob(job.id), ctx);
      db.updateJob(job.id, { status: 'done', progress: 1, finished_at: Date.now() });
    } catch (e) {
      db.updateJob(job.id, ctrl.signal.aborted
        ? { status: 'cancelled', finished_at: Date.now() }
        : { status: 'failed', error: String(e?.message || e), finished_at: Date.now() });
    }
    running.delete(job.id);
    publish(job.id);
    schedule();
  }

  return {
    enqueue, approve, cancel, retry,
    start() { started = true; schedule(); },
    idle: () => new Promise(r => { waiters.push(r); schedule(); }),
  };
}
