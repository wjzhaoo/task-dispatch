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
function taskFields({ workerId, requiredCapability = null, maxAttempts = DEFAULT_LIMIT } = {}) {
  const selected = require('./bindings.cjs').workerId(workerId);
  return { contractRevision:1, maxAttempts: limit(maxAttempts), plannedWorkerId: selected, currentWorkerId: selected,
    plannedRequiredCapability: requiredCapability, requiredCapability };
}
module.exports = { DEFAULT_LIMIT, counts, limit, exhausted, projectExhausted, taskFields };
