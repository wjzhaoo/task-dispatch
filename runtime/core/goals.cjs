'use strict';
const { id } = require('./storage.cjs');
const { terminal } = require('./task-state.cjs');
const at = () => new Date().toISOString();
const ended = goal => ['completed', 'cancelled'].includes(goal.state);
const current = project => project.goals?.[project.activeGoalId] || null;

function add(project, input, fingerprint) {
  project.goals ||= {};
  project.goalQueue ||= [];
  const createdAt = at(), goalId = 'goal-' + id();
  const goal = { id: goalId, title: input.title, objective: input.objective, createdAt,
    state: 'draft', commandId: input.commandId, fingerprint,
    startAuthorizedAt: null };
  project.goals[goalId] = goal;
  if (goal.state === 'queued') project.goalQueue.push(goalId);
  return goal;
}

function taskGoal(project, suppliedGoalId) {
  if (!project.goals) return undefined;
  const goal = current(project);
  if (!goal || ended(goal)) throw Error('没有活动目标，请先创建并开始目标');
  if (suppliedGoalId !== undefined && suppliedGoalId !== goal.id) throw Error('执行任务不能属于其他目标');
  return goal.id;
}

function blocker(project, goal) {
  const task = Object.values(project.tasks).find(t => t.goalId === goal.id && ['blocked', 'uncertain'].includes(t.state));
  if (task) return `执行任务 ${task.id} ${task.state === 'uncertain' ? '需要核实' : '阻塞'}：${task.error || '请由大脑处置'}`;
  const stages = require('./stage-review.cjs');
  const round = stages.active(project) || stages.unresolved(project);
  if (round?.goalId === goal.id && (round.state === 'blocked' || (round.state === 'completed' && round.verdict !== 'pass'))) return round.error || '阶段终审尚未通过，等待大脑追加修复';
  if (project.planning?.goalId === goal.id && project.planning.state === 'blocked') return project.planning.resolution?.reason || '目标规划受阻';
  return null;
}

function reconcile(dispatcher, projectId) {
  const project = dispatcher.store.state.projects[projectId];
  if (!project?.goals || project.archivedAt || project.completedAt) return;
  const goal = current(project);
  if (goal) {
    const reason = blocker(project, goal), state = reason ? 'blocked' : 'active';
    if (goal.state !== state || (goal.blockedReason || null) !== reason) dispatcher.store.change(s => {
      const value = s.projects[projectId].goals[goal.id]; value.state = state;
      if (reason) value.blockedReason = reason; else delete value.blockedReason;
      dispatcher.store.event(s, 'goal_state', { projectId, goalId: goal.id, status: state });
    });
    return;
  }
  if (project.paused || dispatcher.stopping || dispatcher.storageBlocked || dispatcher.pendingSettlements.size || dispatcher.active.has(projectId)) return;
  if (project.planning || require('./stage-review.cjs').active(project) || require('./stage-review.cjs').unresolved(project) || Object.values(project.tasks).some(t => !terminal(t))) return;
  const nextId = project.goalQueue?.find(key => project.goals[key]?.state === 'queued');
  if (!nextId || !dispatcher.desktop) return;
  const team = require('./project-setup.cjs').team(dispatcher.desktop, project);
  if (!team.total || team.ready !== team.total || !team.members.some(member => member.role === 'worker')) return;
  const now = at(), planningId = id();
  dispatcher.store.change(s => {
    const p = s.projects[projectId], next = p.goals[nextId];
    if (p.activeGoalId || next.state !== 'queued') throw Error('目标队列已变化');
    p.activeGoalId = nextId; p.goalQueue = p.goalQueue.filter(key => key !== nextId);
    next.state = 'active'; next.startedAt = now;
    p.startup = { state: 'started', startedAt: now, startedBy: 'web-goal', goalId: nextId };
    p.planning = { id: planningId, kind: 'initial', goalId: nextId, state: 'pending', acceptedTaskIds: [], createdAt: now };
    dispatcher.store.event(s, 'goal_started', { projectId, goalId: nextId });
    dispatcher.store.event(s, 'planning_required', { projectId, goalId: nextId, planningId });
  });
}

function authorize(dispatcher, projectId, goalId, confirmed) {
  const p = dispatcher.store.state.projects[projectId], goal = p?.goals?.[goalId];
  if (!goal || p.archivedAt || p.completedAt) throw Error('目标不可用，请先恢复项目');
  if (confirmed !== true) throw Error('开始目标需要用户明确授权');
  if (goal.state === 'cancelled') throw Error('已取消目标不能重新开始，请新建目标');
  if (goal.startAuthorizedAt) return { ok: true, duplicate: true, goalId };
  if (p.paused) throw Error('项目已暂停，请先点击继续，再开始目标');
  const team = dispatcher.desktop && require('./project-setup.cjs').team(dispatcher.desktop, p);
  if (!team?.total || team.ready !== team.total) throw Error('所有成员就绪后才能开始目标');
  dispatcher.store.change(s => {
    const q = s.projects[projectId], value = q.goals[goalId];
    value.startAuthorizedAt = at(); value.state = 'queued'; q.goalQueue.push(goalId);
    dispatcher.store.event(s, 'goal_queued', { projectId, goalId });
  });
  return { ok: true, goalId, queued: true };
}

function cancel(dispatcher, projectId, goalId) {
  const p = dispatcher.store.state.projects[projectId], goal = p?.goals?.[goalId];
  if (!goal) throw Error('目标不存在');
  if (goal.state === 'cancelled') return { ok: true, duplicate: true, goalId };
  if (!['draft', 'queued'].includes(goal.state)) throw Error('只能取消尚未开始的目标');
  dispatcher.store.change(s => {
    const q = s.projects[projectId]; q.goals[goalId].state = 'cancelled'; q.goals[goalId].cancelledAt = at();
    q.goalQueue = q.goalQueue.filter(key => key !== goalId);
    dispatcher.store.event(s, 'goal_cancelled', { projectId, goalId });
  });
  return { ok: true, goalId };
}

function finish(desktop, identity, input) {
  desktop.assertBinding(identity);
  if (identity.role !== 'brain') throw Error('Only brain can finish a goal');
  const d = desktop.d, p = d.store.state.projects[identity.projectId], goalId = input.goalId || p.activeGoalId, goal = p.goals?.[goalId];
  if (!goal) throw Error('目标不存在');
  if (goal.state === 'completed') return { ok: true, duplicate: true, goalId, ...desktop.nextStep(identity) };
  if (p.activeGoalId !== goalId) throw Error('只能完成当前活动目标');
  if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 2000) throw Error('请提供目标完成与验收摘要（最多 2000 字符）');
  const tasks = Object.values(p.tasks).filter(task => task.goalId === goalId), stages = require('./stage-review.cjs');
  const rounds = Object.values(p.reviewStages || {}).filter(round => round.goalId === goalId);
  if (d.active.has(p.id) || [...d.pendingSettlements.values()].some(value => value.projectId === p.id) || !tasks.length || tasks.some(task => !terminal(task) || task.attempts.some(a => !a.settled)) || stages.active(p) || stages.unresolved(p) || p.planning?.state === 'blocked') throw Error('目标仍有未完成、未结算或未通过终审的工作');
  if (tasks.some(task => !rounds.some(round => round.state === 'completed' && round.verdict === 'pass' && (round.reviewTaskIds).includes(task.id)) && task.state !== 'resolved')) throw Error('目标的执行任务必须通过完整阶段终审');
  const planningId = p.planning?.id;
  d.store.change(s => {
    const q = s.projects[p.id], value = q.goals[goalId], now = at();
    value.state = 'completed'; value.completedAt = now; value.summary = input.summary.trim(); delete value.blockedReason;
    q.activeGoalId = null;
    if (q.planning) {
      q.planningHistory ||= [];
      q.planningHistory.push({ ...q.planning, state: 'completed', resolvedAt: now, resolution: { outcome: 'completed', summary: value.summary, goalId } });
      delete q.planning;
    }
    d.store.event(s, 'goal_completed', { projectId: p.id, goalId, summary: value.summary });
  });
  if (planningId) require('./brain-activities.cjs').autoEnd(desktop, identity, 'planning:' + planningId);
  d.tick();
  return { ok: true, goalId, ...desktop.nextStep(identity) };
}

function assertTeamIdle(dispatcher, p) {
  const stages = require('./stage-review.cjs');
  if (p.activeGoalId || dispatcher.active.has(p.id) || [...dispatcher.pendingSettlements.values()].some(value => value.projectId === p.id) || p.planning || stages.active(p) || stages.unresolved(p) || Object.values(p.tasks).some(t => !terminal(t) || t.attempts.some(a => !a.settled))) throw Error('活动目标结束后才能调整团队');
}

function summary(p) {
  const tasks = Object.values(p.tasks || {});
  return { activeGoalId: p.activeGoalId || null, queue: [...(p.goalQueue || [])], goals: Object.values(p.goals || {}).map(goal => {
    const owned = tasks.filter(task => task.goalId === goal.id);
    return { id: goal.id, title: goal.title, objective: goal.objective, state: goal.state, createdAt: goal.createdAt,
      startAuthorizedAt: goal.startAuthorizedAt || null, startedAt: goal.startedAt || null, completedAt: goal.completedAt || null,
      cancelledAt: goal.cancelledAt || null, summary: goal.summary || null, blockedReason: goal.blockedReason ? require('./monitor.cjs').clean(goal.blockedReason) : null,
      taskCount: owned.length, completedTaskCount: owned.filter(terminal).length };
  }) };
}

function brief(p) {
  const goal = current(p) || p.goals?.[p.goalQueue?.[0]] || Object.values(p.goals || {}).find(value => value.state === 'draft');
  return goal ? { goalId: goal.id, title: goal.title, objective: goal.objective } : { title: p.title, objective: p.goals ? '' : p.objective };
}
module.exports = { add, current, taskGoal, reconcile, authorize, cancel, finish, assertTeamIdle, summary, brief, ended };
