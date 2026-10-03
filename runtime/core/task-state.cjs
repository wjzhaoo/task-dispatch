'use strict';
// [AI-added] 2026-09-21 09:38: Keep terminal-state and replacement resolution semantics consistent across the runtime.
const TERMINAL = new Set(['accepted', 'resolved']);

function terminal(value) {
  return TERMINAL.has(typeof value === 'string' ? value : value?.state);
}

function resolutionTime(task) {
  return task.completedAt || task.resolution?.resolvedAt || null;
}

function resolve(project, taskId, replacementTaskId, reason, actor = 'brain') {
  const task = project?.tasks?.[taskId], replacement = project?.tasks?.[replacementTaskId];
  if (!task || !replacement) throw Error('Resolution requires existing task and replacement');
  if(task.roundId)throw Error('Cancel or settle the active batch before resolving a member');
  if (taskId === replacementTaskId) throw Error('Task cannot replace itself');
  if (replacement.state !== 'accepted') throw Error('Replacement task must be accepted');
  if (typeof reason !== 'string' || !reason.trim()) throw Error('Resolution reason required');
  const normalizedReason = reason.trim();
  if (task.state === 'resolved') {
    if (task.resolution?.replacementTaskId !== replacementTaskId || task.resolution?.reason !== normalizedReason) throw Error('Conflicting task resolution');
    return { duplicate: true, task };
  }
  if (task.state !== 'blocked') throw Error('Only a blocked task can be resolved by a replacement');
  if ((task.attempts || []).some(attempt => !attempt.settled)) throw Error('Blocked task still has an unsettled attempt');
  const resolvedAt = new Date().toISOString();
  task.resolution = {
    kind: 'replacement', replacementTaskId, reason: normalizedReason, resolvedAt, actor,
    previousError: task.error || null, previousBlockKind: task.blockKind || null
  };
  task.state = 'resolved';
  task.error = null;
  task.blockKind = null;
  task.resumePhase = null;
  delete task.scopeRecovery;
  delete task.scopeRecoveryRequested;
  if (task.attention) task.attention.acknowledged = true;
  if (task.scopeAlert) task.scopeAlert.acknowledged = true;
  return { duplicate: false, task };
}

module.exports = { TERMINAL, terminal, resolutionTime, resolve };
