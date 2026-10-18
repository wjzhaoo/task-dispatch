'use strict';
const fs = require('node:fs'), path = require('node:path');
const { sha, alive } = require('./storage.cjs');
// [AI-added] 2026-09-21 09:38: Accepted and replacement-resolved tasks share cache-retention behavior.
const {terminal,resolutionTime}=require('./task-state.cjs');
const buckets = ['artifacts', 'reviews', 'validations'];
function policy(v = {}) {
  const p = { automatic: v.automatic ?? true, retainDays: v.retainDays ?? 7, keepLatestAccepted: v.keepLatestAccepted ?? 2, maxBytes: v.maxBytes ?? 10 * 1024 ** 3 };
  if (typeof p.automatic !== 'boolean' || !Number.isFinite(p.retainDays) || p.retainDays < 0 || !Number.isInteger(p.keepLatestAccepted) || p.keepLatestAccepted < 1 || !Number.isSafeInteger(p.maxBytes) || p.maxBytes < 1) throw Error('Invalid storage policy');
  return p;
}
function size(file) {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink()) throw Error('Cleanup refuses symlink/junction: ' + file);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(file).reduce((n, f) => n + size(path.join(file, f)), 0);
}
function safeTarget(root, relative) {
  // [AI-added] 2026-09-24 10:55: Batch validation trees live one level below the attempt.
  if (!/^(?:artifacts|reviews)\/[a-zA-Z0-9_-]+$|^validations\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)?\/tree$/.test(relative)) throw Error('Invalid cleanup target');
  const base = fs.realpathSync(root), target = path.resolve(base, ...relative.split('/'));
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('Cleanup path escapes service root');
  let cursor = base;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw Error('Cleanup refuses symlink/junction');
  }
  return target;
}
function plan(dispatcher, now = Date.now()) {
  const { store } = dispatcher, cfg = policy(store.state.storagePolicy), protectedPaths = new Set(), eligible = new Set();
  const age = now - cfg.retainDays * 86400000;
  const refs = (t) => {
    const a = new Set(); if (t.artifactId) a.add('artifacts/' + t.artifactId);
    if (t.reviewBaselineId) a.add('artifacts/' + t.reviewBaselineId);
    // Include task-level recovery references as well as historical attempts.
    for (const recovery of [t.scopeRecovery, ...t.attempts.map(r => r.scopeRecovery)]) {
      for (const id of [recovery?.originalBaselineId, recovery?.rejectedArtifactId]) if (id) {
        a.add('artifacts/' + id);
      }
    }
    for (const r of t.attempts) {
      for (const id of [r.baselineId, r.artifactId,r.reviewBaselineId,r.scopeRejectedArtifactId,r.scopeRecovery?.originalBaselineId,r.scopeRecovery?.rejectedArtifactId]) if (id) a.add('artifacts/' + id);
      const receipt = dispatcher.receiptPath(r.id);
      if (fs.existsSync(receipt)) {
        const artifactId = JSON.parse(fs.readFileSync(receipt,'utf8')).artifactId;
        if (artifactId) a.add('artifacts/' + artifactId);
      }
      a.add('reviews/' + r.id); a.add('validations/' + r.id + '/tree');
    }
    return a;
  };
  for (const p of Object.values(store.state.projects)) {
    const tasks = Object.values(p.tasks);
    // An in-process preparation can still acquire references before recording them.
    // Desktop attempts in another task do not prevent reclaiming settled caches.
    const projectBusy = dispatcher.active.has(p.id);
    const accepted = tasks.filter(terminal).sort((a,b) => Date.parse(resolutionTime(b) || b.attempts.at(-1)?.startedAt || 0) - Date.parse(resolutionTime(a) || a.attempts.at(-1)?.startedAt || 0));
    const keep = new Set(accepted.slice(0, cfg.keepLatestAccepted).map(t => t.id));
    for (const t of tasks) {
      const active = projectBusy || !terminal(t) || !!t.scopeRecovery || (t.scopeAlert && !t.scopeAlert.acknowledged) || t.attempts.some(r => !r.settled || (r.validationPid && alive(r.validationPid)));
      const old = Date.parse(resolutionTime(t) || t.attempts.at(-1)?.startedAt || '') <= age;
      for (const ref of refs(t)) {
        // Finished validation trees are disposable; reports outside tree are retained.
        if (!active && ref.startsWith('validations/')) eligible.add(ref);
        else if (!active && old && !keep.has(t.id)) eligible.add(ref);
        else protectedPaths.add(ref);
      }
    }
  }
  const entries = [];
  for (const relative of [...eligible].sort()) {
    if (protectedPaths.has(relative)) continue;
    const file = safeTarget(store.root, relative);
    if (fs.existsSync(file)) entries.push({ relative, bytes: size(file) });
  }
  const sizes = Object.fromEntries(buckets.map(k => [k, fs.existsSync(path.join(store.root,k)) ? size(path.join(store.root,k)) : 0]));
  const totalBytes = Object.values(sizes).reduce((a,b) => a+b,0), reclaimableBytes = entries.reduce((a,b) => a+b.bytes,0);
  const result = { revision: store.state.revision, policy: cfg, entries, sizes, totalBytes, reclaimableBytes, overBudget: totalBytes > cfg.maxBytes };
  return { ...result, previewId: sha(JSON.stringify(result)) };
}
// [AI-added] 2026-09-24 10:54: Retain only snapshots that can still participate in active
// review, retry, recovery, or batch work. Historical settled attempts remain auditable in state.
function planV2(dispatcher, now = Date.now()) {
  const { store } = dispatcher, cfg = policy(store.state.storagePolicy);
  const protectedPaths = new Set(), eligible = new Set();
  const age = now - cfg.retainDays * 86400000;
  const artifact = (set, value) => { if (value) set.add('artifacts/' + value); };
  const receiptArtifact = run => {
    const file = dispatcher.receiptPath(run.id);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).artifactId : null;
  };
  const allRefs = task => {
    const refs = new Set();
    artifact(refs, task.artifactId);
    artifact(refs, task.reviewBaselineId);
    for (const recovery of [task.scopeRecovery, ...task.attempts.map(run => run.scopeRecovery)]) {
      artifact(refs, recovery?.originalBaselineId);
      artifact(refs, recovery?.rejectedArtifactId);
    }
    for (const run of task.attempts) {
      for (const key of ['baselineId', 'artifactId', 'reviewBaselineId', 'scopeRejectedArtifactId']) artifact(refs, run[key]);
      artifact(refs, receiptArtifact(run));
      refs.add('reviews/' + run.id);
      refs.add('validations/' + run.id + '/tree');
    }
    return refs;
  };
  for (const project of Object.values(store.state.projects)) {
    const tasks = Object.values(project.tasks);
    const accepted = tasks.filter(terminal).sort((a, b) => Date.parse(resolutionTime(b) || b.attempts.at(-1)?.startedAt || 0) - Date.parse(resolutionTime(a) || a.attempts.at(-1)?.startedAt || 0));
    const keep = new Set(accepted.slice(0, cfg.keepLatestAccepted).map(task => task.id));
    const batches = Object.values(project.reviewStages || {});
    const activeMembers = new Set(batches.filter(batch => !require('./stage-review.cjs').ended(batch) || !batches.some(r=>r.stageId===batch.stageId&&r.verdict==='pass')).flatMap(batch => batch.members.map(member => member.taskId)));
    for (const task of tasks) {
      const refs = allRefs(task), finished = terminal(task);
      const unsafe = dispatcher.active.has(project.id) || activeMembers.has(task.id) || !!task.scopeRecovery ||
        !!(task.scopeAlert && !task.scopeAlert.acknowledged) ||
        task.attempts.some(run => !run.settled || (run.validationPid && alive(run.validationPid))) ||
        [...dispatcher.pendingSettlements.values()].some(entry => entry.projectId === project.id && entry.taskId === task.id);
      if (unsafe) { for (const ref of refs) protectedPaths.add(ref); continue; }
      const live = new Set();
      const recent = Date.parse(resolutionTime(task) || task.attempts.at(-1)?.startedAt || '') > age;
      if (!finished || keep.has(task.id) || recent) artifact(live, task.artifactId);
      if (!finished) {
        artifact(live, task.reviewBaselineId);
        const worker = task.attempts.findLast(run => run.role === 'worker');
        artifact(live, worker?.reviewBaselineId || worker?.baselineId);
      }
      for (const ref of refs) (live.has(ref) ? protectedPaths : eligible).add(ref);
    }
    for (const batch of batches) {
      const refs = new Set();
      artifact(refs, batch.baselineId);
      artifact(refs, batch.compositeArtifactId);
      artifact(refs, batch.attempt?.artifactId);
      for (const member of batch.frozenMembers || []) artifact(refs, member.artifactId);
      for(const attempt of [...(batch.attemptHistory||[]),...(batch.attempt?[batch.attempt]:[])]) {
        artifact(refs,attempt.artifactId);refs.add('reviews/'+attempt.id);refs.add('validations/'+attempt.id+'/tree');
        for(const taskId of batch.reviewTaskIds)refs.add('validations/'+attempt.id+'/'+taskId+'/tree');
      }
      const active = !require('./stage-review.cjs').ended(batch) || !batches.some(r=>r.stageId===batch.stageId&&r.verdict==='pass') || dispatcher.active.has(project.id) ||
        !!(batch.attempt && !batch.attempt.settled);
      for (const ref of refs) (active ? protectedPaths : eligible).add(ref);
    }
  }
  const entries = [];
  for (const relative of [...eligible].sort()) {
    if (protectedPaths.has(relative)) continue;
    const file = safeTarget(store.root, relative);
    if (fs.existsSync(file)) entries.push({ relative, bytes: size(file) });
  }
  const sizes = Object.fromEntries(buckets.map(name => [name, fs.existsSync(path.join(store.root, name)) ? size(path.join(store.root, name)) : 0]));
  const totalBytes = Object.values(sizes).reduce((a, b) => a + b, 0);
  const reclaimableBytes = entries.reduce((a, b) => a + b.bytes, 0);
  const result = { revision: store.state.revision, policy: cfg, entries, sizes, totalBytes, reclaimableBytes, overBudget: totalBytes > cfg.maxBytes };
  return { ...result, previewId: sha(JSON.stringify(result)) };
}
function apply(dispatcher, previewId, now = Date.now()) {
  // [AI-added] 2026-09-24 10:54: Apply the same reference-aware plan shown in the preview.
  const p = planV2(dispatcher, now);
  if (previewId !== p.previewId) throw Error('Cleanup preview changed; preview again before applying');
  const removed = [];
  for (const entry of p.entries) {
    const target = safeTarget(dispatcher.store.root, entry.relative);
    size(target); // Refuse nested links immediately before recursive deletion.
    fs.rmSync(target, { recursive: true }); removed.push(entry.relative);
  }
  if (removed.length) dispatcher.store.change(s => {
    const removedSet = new Set(removed);
    for (const project of Object.values(s.projects)) for (const t of Object.values(project.tasks)) {
      // [AI-added] 2026-09-24 10:54: Settled review copies are disposable even during a later retry.
      for (const r of t.attempts) if (r.settled && removedSet.has('reviews/' + r.id)) delete r.delivery;
    }
    dispatcher.store.event(s, 'storage_cleaned', { removed, bytes: p.reclaimableBytes });
  });
  dispatcher.storageBlocked = p.totalBytes - p.reclaimableBytes > p.policy.maxBytes;
  dispatcher.storageStatus = { totalBytes:p.totalBytes-p.reclaimableBytes,maxBytes:p.policy.maxBytes,blocked:dispatcher.storageBlocked,checkedAt:new Date().toISOString() };
  return { removed, reclaimedBytes: p.reclaimableBytes, storage:dispatcher.storageStatus };
}
function dispatchStatus(dispatcher) {
  const storage=dispatcher.storageStatus;
  const reason=dispatcher.storageBlocked ? (storage?.error ? '存储检查失败：'+storage.error : `缓存空间超限：${((storage?.totalBytes||0)/1024**3).toFixed(2)} GiB / ${((storage?.maxBytes||0)/1024**3).toFixed(2)} GiB；任务已入队但暂停派发，请运行清理缓存.bat。`) : dispatcher.fatal?.message || (dispatcher.stopping?'调度服务正在停止':null);
  return {blocked:!!reason,reason,storage};
}
// [AI-added] 2026-09-24 10:54: Expose the rolling-retention plan to CLI and server callers.
module.exports = { policy, plan: planV2, apply, size, safeTarget, dispatchStatus };
