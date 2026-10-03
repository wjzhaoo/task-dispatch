'use strict';
const DEFAULT_LIMIT = 30;
function counts(task) {
  const unique = new Map((task.attempts || []).map(a => [a.id, a]));
  // [AI-added] 2026-09-22 10:20: Participation consumes member budget without duplicating shared runs.
  for(const key of task.stageReviewRefs||[])if(!unique.has(key))unique.set(key,{id:key,role:'brain'});
  const execution = [...unique.values()].filter(a => a.role === 'worker').length;
  const review = [...unique.values()].filter(a => ['brain','reviewer'].includes(a.role)).length;
  return { execution, review, total: execution + review };
}
function limit(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw Error('maxAttempts must be a positive safe integer');
  return value;
}
function exhausted(task) { return counts(task).total >= task.maxAttempts; }
function projectExhausted(project) { return project.projectBudgetEnabled === true && project.turns >= project.maxTurns; }
// Additive migration: never rewrite attempts, receipts, sessions or current ownership.
// Old project limits have no provenance; retain the value but require explicit opt-in.
function migrate(state) {
  for (const p of Object.values(state.projects)) {
    if (p.attemptPolicyVersion !== 1) {
      p.projectBudgetEnabled = false;
      p.attemptPolicyVersion = 1;
    }
    // Qoder direct wake added workspace verification after legacy bindings were already persisted.
    // The binding belongs to this project, so migrate it additively without requiring every idle
    // reviewer to run resume again after upgrading.
    for (const b of Object.values(p.bindings || {})) if (b.wake?.provider === 'qoder' && !b.wake.workspace) b.wake.workspace = p.workspace;
    for (const t of Object.values(p.tasks)) {
      t.maxAttempts ??= DEFAULT_LIMIT;
      t.plannedWorkerId ??= t.workerId || 'default';
      if (!Object.hasOwn(t, 'plannedRequiredCapability')) t.plannedRequiredCapability = t.requiredCapability ?? null;
      t.currentWorkerId ??= t.workerId || 'default';
      t.workerId = t.currentWorkerId; // compatibility alias used by wake/handover/recovery
    }
  }
}
module.exports = { DEFAULT_LIMIT, counts, limit, exhausted, projectExhausted, migrate };
