// [AI-added] 2026-09-16: Explicit operator lifecycle changes; never remove workspace files.
'use strict';
const path = require('node:path');
const { atomic, id } = require('./storage.cjs');
const { DEFAULT_LIMIT, taskFields } = require('./attempts.cjs');
function descendants(p, taskId) {
  const found = new Set([taskId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const t of Object.values(p.tasks)) if (!found.has(t.id) && (t.dependsOn || []).some(k => found.has(k))) { found.add(t.id); changed = true; }
    for (const round of Object.values(p.reviewStages || {})) {
      const members = round.reviewTaskIds;
      if (members.some(k => found.has(k))) for (const key of members) if (!found.has(key)) { found.add(key); changed = true; }
    }
  }
  return [...found];
}
function riskyTasks(p, ids) {
  return Object.values(p.reviewStages || {}).some(batch => batch.reviewTaskIds.some(key => ids.includes(key)))
    || ids.some(key => ['running', 'reviewing', 'uncertain'].includes(p.tasks[key].state) || p.tasks[key].attempts.some(attempt => !attempt.settled));
}
function preview(p, input) {
  const operation = input.operation || input.action;
  if (!['archive-project','restore-project','delete-project','reset-task'].includes(operation)) throw Error('无效生命周期操作');
  if (operation === 'reset-task' && !p.tasks[input.taskId]) throw Error('任务不存在');
  const ids = operation === 'reset-task' ? descendants(p, input.taskId) : Object.keys(p.tasks);
  return { operation, projectId: p.id, taskId: input.taskId,
    affectedTasks: ids.map(k => ({ id: k, title: p.tasks[k].title, state: p.tasks[k].state, attempts: p.tasks[k].attempts.length })),
    connections: Object.keys(p.bindings || {}), archived: !!p.archivedAt,
    requiresStopped: ['delete-project', 'reset-task'].includes(operation) && riskyTasks(p, ids),
    message: operation === 'delete-project' ? '永久移除项目调度记录并撤销全部连接；保留审计、源工程及磁盘产物，不提供一键恢复。' : operation === 'reset-task' ? '重置选中任务；级联重置时同时处理全部下游及同阶段任务。清空执行/审核/唤醒/产物关联，尝试额度回到 30；保留任务定义、审计和工程文件，项目将暂停。' : operation === 'archive-project' ? '归档后默认隐藏，停止调度和端接入，历史保留。' : '恢复到项目列表，保持暂停；核对后手动继续并让各端重新 park。' };
}
function apply(admin, input) {
  const d = admin.d, store = d.store, p = store.state.projects[input.projectId];
  const view = preview(p, input);
  if (typeof input.reason !== 'string' || !input.reason.trim()) throw Error('请填写操作原因');
  if (input.confirmed !== true) throw Error('请确认操作影响');
  if (input.action === 'delete-project' && input.confirmText !== p.id) throw Error('永久删除需要准确输入项目 ID');
  if (input.action === 'reset-task' && input.confirmText !== input.taskId) throw Error('完全重置需要准确输入任务 ID');
  if (d.active.has(p.id)) throw Error('服务仍在处理该项目，先暂停并等待当前处理结束');
  if (admin.monitor.wake.busy) throw Error('服务正在检查或投递唤醒，请稍后重试');
  if (Object.keys(p.handovers || {}).length) throw Error('项目有待完成的会话交接，请先处理交接');
  const affected = input.action === 'reset-task' ? (input.resetDependents ? view.affectedTasks.map(t => t.id) : [input.taskId]) : Object.keys(p.tasks);
  const goalIds = [...new Set(affected.map(key => p.tasks[key].goalId).filter(Boolean))];
  if (input.action === 'reset-task' && p.goals && (goalIds.length !== 1 || (p.activeGoalId && p.activeGoalId !== goalIds[0]))) throw Error('只能重置同一目标的任务；另一个目标活动期间不能重置历史目标');
  // [AI-added] 2026-09-22 10:20: Reset every frozen member together, preserving stage audit.
  const batches=Object.values(p.reviewStages||{}).filter(b=>(b.reviewTaskIds).some(k=>affected.includes(k)));
  if(input.action==='reset-task'&&batches.some(b=>(b.reviewTaskIds).some(k=>!affected.includes(k))))throw Error('Stage reset must include every original and repair task in the functional stage');
  if (input.action === 'reset-task' && !input.resetDependents && view.affectedTasks.some(t => t.id !== input.taskId && (t.attempts || t.state !== 'ready'))) throw Error('下游任务已有执行或状态变化，请同时重置全部下游任务');
  const risky = riskyTasks(p, affected);
  if (risky && input.action === 'archive-project') throw Error('项目有在途或待核实任务，需先完成任务或确认停止后重置');
  if (risky && ['reset-task','delete-project'].includes(input.action) && input.confirmedStopped !== true) throw Error('存在在途或待核实任务，请先核实所有相关宿主执行已停止并确认');
  const at = new Date().toISOString(), resetId = id();
  if (input.action === 'reset-task') {
    // Save the old records before clearing them. These are audit evidence, never replayed.
    atomic(path.join(store.root, 'task-resets', resetId + '.json'), { resetId, at, projectId: p.id, reason: input.reason, tasks: affected.map(k => p.tasks[k]),reviewStages:batches, ...(p.goals ? { goal: p.goals[goalIds[0]] } : {}) });
  }
  store.change(s => {
    const q = s.projects[p.id];
    if (input.action === 'delete-project') {
      delete s.projects[p.id];
      s.deletedProjects ||= {};
      s.deletedProjects[p.id] = { at, reason: input.reason, workspace: p.workspace };
    } else if (input.action === 'archive-project') {
      q.archivedAt = at; q.paused = true;
      for (const b of Object.values(q.bindings || {})) { b.armed = false; delete b.armedAt; }
    } else if (input.action === 'restore-project') {
      if (!q.archivedAt) throw Error('项目未归档');
      delete q.archivedAt; q.paused = true;
    } else {
      for(const b of batches){const v=q.reviewStages[b.id];v.state='reset';if(v.attempt){v.attempt.settled=true;v.attempt.settledAt=at;v.attempt.outcome='reset';}}
      const keep = ['id','goalId','title','instructions','acceptance','allowedPaths','dependsOn','validationProfile','contractRevision'];
      for (const key of affected) {
        const old = q.tasks[key];
        const definition = Object.fromEntries(keep.filter(k => old[k] !== undefined).map(k => [k, old[k]]));
        q.tasks[key] = { ...definition, ...taskFields({workerId:old.plannedWorkerId,requiredCapability:old.plannedRequiredCapability}), contractRevision:old.contractRevision,
          state: 'ready', attempts: [], repairs: 0, sessions: {}, findings: [], resetCount: (old.resetCount || 0) + 1, lastResetId: resetId, resetAt: at };
      }
      const targets = new Set(affected);
      if (q.planning && (q.planning.acceptedTaskIds || []).some(k => targets.has(k))) delete q.planning;
      q.planningHistory = (q.planningHistory || []).map(h => ({ ...h, acceptedTaskIds: (h.acceptedTaskIds || []).filter(k => !targets.has(k)) })).filter(h => h.acceptedTaskIds.length);
      delete q.completedAt; q.paused = true;
      if (q.goals) {
        const goal = q.goals[goalIds[0]];
        goal.state = 'active'; delete goal.completedAt; delete goal.summary; delete goal.blockedReason;
        q.activeGoalId = goal.id; q.goalQueue = q.goalQueue.filter(key => key !== goal.id);
        q.startup = { ...q.startup, state: 'started', goalId: goal.id };
      }
      for (const b of Object.values(q.bindings || {})) { b.armed = false; delete b.armedAt; }
    }
    store.event(s, input.action.replaceAll('-', '_'), { projectId: p.id, taskId: input.taskId, reason: input.reason, summary: `${input.reason}；影响任务：${affected.join(', ') || '无'}`, affectedTasks: affected, ...(input.action === 'reset-task' ? { resetId } : {}) });
  });
  if (input.action === 'delete-project') d.reviewerPresence?.delete(p.id);
  if(['reset-task','delete-project'].includes(input.action))for(const [key,entry] of d.pendingSettlements)if(entry.kind==='batch'&&entry.projectId===p.id&&batches.some(b=>b.id===entry.roundId))d.pendingSettlements.delete(key);
  return { message: view.message, affectedTasks: affected, ...(input.action === 'reset-task' ? { resetId, paused: true, maxAttempts: DEFAULT_LIMIT } : {}) };
}
module.exports = { preview, apply, descendants };
