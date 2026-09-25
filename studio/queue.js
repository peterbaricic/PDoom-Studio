// queue.js: runs studio jobs from the database. Claude jobs and render jobs are separate lanes with their own limits
// (renders share the one GPU, so one at a time). A job can wait for another (chapters wait for the shared setup).
export const LANES = { storyboard: 'claude', shared: 'claude', chapter: 'claude', render: 'render', thumbs: 'render' };

// progressEveryMs: the least time between two progress-only `job` events for one job. A final render reports progress
// once per painted frame, and every `job` event makes each open page refetch its job lists, so progress is published
// at most this often (the latest value always goes out, at the end of the wait). Status changes are never held back.
export function createQueue({ db, events, runners, limits = { claude: 3, render: 1 }, progressEveryMs = 250 }) {
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
  // its shared.js. Failing both of those, it chases the newest shared job of the version regardless of status (even
  // a failed or cancelled one), so that retrying *that* job later repoints this one forward (repointDependents) —
  // and so on, until a shared job actually succeeds. Without this, a chapter retried while every shared job so far
  // has failed would stay pointed at whichever one it originally waited for, and never catch up.
  function retry(id) {
    const job = db.getJob(id);
    if (!job || !['failed', 'cancelled', 'interrupted'].includes(job.status)) throw new Error('only failed, cancelled or interrupted jobs can be retried');
    let params = job.params;
    if (params.after != null && !['queued', 'running', 'done'].includes(db.getJob(params.after)?.status)) {
      const [shared] = db.findJobs({ versionId: job.version_id, kinds: ['shared'], statuses: ['queued', 'running', 'done'] });
      if (shared) params = { ...params, after: shared.id };
      else if (db.getFile(job.version_id, 'shared.js')) { const { after, ...rest } = params; params = rest; }
      else {
        const [newest] = db.findJobs({ versionId: job.version_id, kinds: ['shared'], statuses: ['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted'] });
        if (newest) params = { ...params, after: newest.id };
      }
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
    // offset: where in the job's log this text starts (its length before the append, in UTF-16 code units, as the
    // page's JSON-decoded copy counts it), so a page that fetched the log meanwhile can tell whether it already has it.
    let logLength = (job.log ?? '').length;
    let progressAt = -Infinity, progressTimer = null;
    const publishProgress = () => { clearTimeout(progressTimer); progressTimer = null; progressAt = Date.now(); publish(job.id); };
    const ctx = {
      signal: ctrl.signal,
      log: text => {
        const offset = logLength;
        logLength += text.length;
        db.appendLog(job.id, text);
        events.publish('log', { id: job.id, offset, text });
      },
      progress: p => {
        const progress = Math.max(0, Math.min(1, p));
        db.updateJob(job.id, { progress });
        const wait = progressAt + progressEveryMs - Date.now();
        if (wait <= 0 || progress === 1) publishProgress();
        else progressTimer ??= setTimeout(publishProgress, wait);
      },
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
    clearTimeout(progressTimer);   // the final publish below carries the latest progress anyway
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
