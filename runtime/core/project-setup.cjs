'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { plainDirectory, desktopProjectId, sha } = require('./storage.cjs');
const { staffing, bindingKey, supports } = require('./bindings.cjs');
const goals = require('./goals.cjs');
const defaultWorkers = () => [{ workerId: 'default', capability: 'general', responsibilities: '完成当前目标的实现与验证' }];

function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`${label}不能为空，且不能超过 ${max} 字符`);
  return value.trim();
}
function workers(value) {
  if (!Array.isArray(value) || !value.length) throw Error('至少配置一名执行员');
  const result = staffing({ rationale: '用户在 Web 管理端配置的成员与职责', workers: value }).workers;
  for (const w of result) text(w.responsibilities, '执行员职责', 1000);
  return result;
}
function validate(input) {
  if (!input || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.commandId || '')) throw Error('需要唯一 commandId');
  if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace)) throw Error('工作目录必须是已有目录的绝对路径');
  let workspace;
  try { workspace = plainDirectory(input.workspace); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw Error('项目工作目录不存在或不是文件夹，请填写已有目录的绝对路径');
    throw error;
  }
  const title = text(input.title, '目标名称', 120), objective = text(input.objective, '目标与验收要求', 12000);
  const startMode = input.startMode ?? 'auto';
  if (!['auto', 'manual'].includes(startMode)) throw Error('开始方式只支持 auto 或 manual');
  return { commandId: input.commandId, workspace, title, objective, ...(input.workers !== undefined ? { workers: workers(input.workers) } : {}), startMode };
}
const fingerprint = setup => sha(JSON.stringify(setup));
function fields(input) {
  const setup = validate(input), selected = setup.workers || defaultWorkers();
  const keys = ['brain', 'reviewer', ...selected.map(w => bindingKey({ role: 'worker', workerId: w.workerId }))];
  const value = { title: path.basename(setup.workspace), objective: setup.objective,
    staffing: staffing({ rationale: '用户在 Web 管理端配置的成员与职责', workers: selected }),
    webSetup: { commandId: setup.commandId, fingerprint: fingerprint(setup), createdAt: new Date().toISOString(), invitations: Object.fromEntries(keys.map(key => [key, randomUUID()])) },
    goals: {}, goalQueue: [], activeGoalId: null };
  goals.add(value, setup, fingerprint(setup));
  return value;
}
function legacyStaffing(p) {
  const existing = Object.entries(p.bindings || {}).filter(([key]) => key === 'worker' || key.startsWith('worker:')).map(([key, b]) => ({
    workerId: key === 'worker' ? 'default' : key.slice(7), capability: b.capabilities?.[0] || 'general', responsibilities: '沿用已接入执行员' }));
  return staffing({ rationale: '复用已有项目成员', workers: existing.length ? existing : defaultWorkers() });
}
function create(dispatcher, input) {
  const setup = validate(input), hash = fingerprint(setup);
  const prior = Object.values(dispatcher.store.state.projects).find(p => p.workspace === setup.workspace || Object.values(p.goals || {}).some(goal => goal.commandId === setup.commandId));
  if (prior) {
    const duplicate = Object.values(prior.goals || {}).find(goal => goal.commandId === setup.commandId);
    if (duplicate) {
      const { startMode, ...oldShape } = setup;
      if (duplicate.fingerprint !== hash && !(duplicate.legacyFingerprint && duplicate.fingerprint === fingerprint(oldShape))) throw Error('同一创建编号不能用于不同内容');
      return { ok: true, projectId: prior.id, goalId: duplicate.id, duplicate: true, teamReused: true };
    }
    if (prior.mode !== 'desktop' || prior.archivedAt) throw Error('请先恢复桌面协作项目，再新增目标');
    let goal;
    dispatcher.store.change(s => {
      const p = s.projects[prior.id]; goals.adopt(p);
      p.webSetup ||= { commandId: setup.commandId, createdAt: new Date().toISOString(), invitations: {} };
      p.staffing ||= legacyStaffing(p);
      p.title ||= path.basename(p.workspace);
      goal = goals.add(p, setup, hash);
      if (p.completedAt) { delete p.completedAt; p.startup = { state: 'waiting' }; }
      dispatcher.store.event(s, 'goal_created', { projectId: p.id, goalId: goal.id, status: goal.state });
    });
    dispatcher.tick();
    return { ok: true, projectId: prior.id, goalId: goal.id, teamReused: true };
  }
  const projectId = desktopProjectId(setup.workspace);
  dispatcher.addProject({ id: projectId, workspace: setup.workspace, mode: 'desktop', webSetup: setup });
  const goalId = Object.keys(dispatcher.store.state.projects[projectId].goals)[0];
  dispatcher.tick();
  return { ok: true, projectId, goalId, teamReused: false };
}
function members(p) {
  return [{ binding: 'brain', role: 'brain', responsibilities: '规划、派发与阶段终审' },
    { binding: 'reviewer', role: 'reviewer', responsibilities: '独立初审' },
    ...(p.staffing?.workers || []).map(w => ({ ...w, role: 'worker', binding: bindingKey({ role: 'worker', workerId: w.workerId }) }))];
}
function joinId(p, key) {
  if (!p?.webSetup || !members(p).some(member => member.binding === key)) return null;
  if (p.webSetup.invitations[key]) return p.webSetup.invitations[key];
  const hash = sha(p.webSetup.commandId + ':' + key);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function team(desktop, p) {
  if (!p || p.mode !== 'desktop') throw Error('项目不存在或不是桌面协作项目');
  const rows = members(p).map(member => {
    const b = p.bindings?.[member.binding];
    let state = 'ready', message = '已就绪';
    if (!b) { state = 'missing'; message = '等待加入'; }
    else if (p.handovers?.[member.binding]) { state = 'configuring'; message = '等待安全交接'; }
    else if (b.continuationError) { state = 'configuring'; message = '续接配置未完成，请回原会话检查回执'; }
    else if (!supports(b, member.capability)) { state = 'configuring'; message = '执行能力与配置不符'; }
    else if ((!b.wake && b.continuation?.mode !== 'wait') || (member.role !== 'worker' && !b.wake)) { state = 'configuring'; message = '已绑定，等待配置续接'; }
    else if ((p.startup?.state !== 'started' || (p.goals && !p.activeGoalId)) && b.wake && !b.armed) { state = 'configuring'; message = '已绑定，请在原会话继续待命'; }
    else if (member.role === 'reviewer' && !require('./pre-review.cjs').online(desktop.d, p)) { state = 'configuring'; message = '请在原初审会话恢复续接'; }
    return { ...member, state, message, connected: !!b, provider: b?.wake?.provider || b?.continuation?.provider || null };
  });
  const ready = rows.filter(row => row.state === 'ready').length;
  let canConfigure = !p.archivedAt && !p.completedAt;
  try { goals.assertTeamIdle(desktop.d, p); } catch { canConfigure = false; }
  return { projectId: p.id, title: p.title, managed: !!p.webSetup, startup: p.startup?.state || 'waiting', members: rows, ready, total: rows.length,
    canConfigure, canStart: !!p.webSetup && !p.paused && !p.completedAt && !p.archivedAt && !p.activeGoalId && ready === rows.length };
}
function configureTeam(desktop, projectId, input) {
  const p = desktop.store.state.projects[projectId];
  if (!p?.webSetup || p.archivedAt || p.completedAt) throw Error('项目不可用');
  goals.assertTeamIdle(desktop.d, p);
  const selected = workers(input);
  for (const w of selected) {
    const b = p.bindings?.[bindingKey({ role: 'worker', workerId: w.workerId })];
    if (b && !supports(b, w.capability)) throw Error('已有执行员能力不匹配，请先使用显式改绑更新该成员');
  }
  const value = staffing({ rationale: '用户在 Web 管理端调整团队', workers: selected });
  desktop.store.change(s => { s.projects[projectId].staffing = value; desktop.store.event(s, 'staffing_assessed', { projectId }); });
  return { ok: true, staffing: value };
}
function invitation(desktop, p, root, key) {
  const member = team(desktop, p).members.find(row => row.binding === key);
  if (!member) throw Error('成员不在当前配置中');
  if (!p.webSetup || p.archivedAt || p.completedAt) throw Error('请在活动的 Web 创建项目中邀请成员');
  if (member.connected) throw Error('成员已绑定；请在原会话续接，换人请使用后台控制中的改绑邀请');
  return require('./invitations.cjs').buildJoinInvitation({ ...member, invitationId: joinId(p, key), workspace: p.workspace, dataRoot: root,
    clientPath: path.resolve(__dirname, '../desktop-client.cjs'), referencePath: path.resolve(__dirname, '../../skills/task-dispatch/references/connection.md'), title: p.title });
}
module.exports = { validate, fields, create, team, invitation, joinId, configureTeam, defaultWorkers };
