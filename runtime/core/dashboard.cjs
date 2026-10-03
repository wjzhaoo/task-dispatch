// [AI-added] 2026-09-17: Read-only aggregation of projects persisted by sibling services.
'use strict';
const path = require('node:path');
const registry = require('./service-registry.cjs');
const { bindingKey, matches } = require('./bindings.cjs');
const attempts = require('./attempts.cjs');
const { pick, clean } = require('./monitor.cjs');

function sourceKind(root, workspaces, home) {
  if (registry.pathKey(root) === registry.pathKey(require('./data-root.cjs').legacyDataRoot(home))) return 'public';
  if ((workspaces || []).some(workspace => registry.pathKey(root) === registry.pathKey(require('./data-root.cjs').projectDataRoot(workspace)))) return 'project';
  return 'custom';
}
function persistedProject(p, service, state={projects:{[p.id]:p},events:[]}) {
  const connections = Object.entries(p.bindings || {}).map(([key, b]) => {
    const active = Object.values(p.tasks || {}).flatMap(t => (t.attempts || []).filter(a => !a.settled && bindingKey(a) === key).map(a => ({ taskId: t.id, attemptId: a.id, claimed: !!a.claimedBy, state: t.state })));
    if(key==='brain')for(const b of Object.values(p.reviewStages||{}))if(b.attempt&&!b.attempt.settled)active.push({taskId:'阶段 '+b.stageId+' / '+b.id,attemptId:b.attempt.id,claimed:!!b.attempt.claimedBy,state:b.state});
    // [AI-added] 2026-09-17 11:46
    const rebindInvitation=Object.values(p.rebindInvitations||{}).filter(invite=>invite.binding===key).sort((a,c)=>Date.parse(c.createdAt)-Date.parse(a.createdAt))[0];
    return { id: `${p.id}/${key}/${b.clientId}`, binding: key, clientId: b.clientId, sessionId: b.sessionId || b.wake?.threadId,
      provider: b.wake?.provider || b.provider || b.continuation?.provider || 'unknown', role: ['brain','reviewer'].includes(key) ? key : 'worker',
      workerId: key.startsWith('worker:') ? key.slice(7) : key === 'worker' ? 'default' : undefined, continuationError: clean(b.continuationError),
      wakeEnabled: !!b.wake, armed: !!b.armed, armedAt: b.armedAt || null, contact: null, observation: null, communication: 'unknown', observationStale: true,
      handoverPending: !!p.handovers?.[key], rebindInvitation:rebindInvitation?pick(rebindInvitation,['id','status','expiresAt','clientId','recover']):null, active };
  });
  const tasks = Object.values(p.tasks || {}).map(t => ({ ...pick(t, ['id','title','state','error','maxAttempts','workerId','requiredCapability','blockKind','contractRevision','stageId','roundId','stageHeld']), dependsOn: t.dependsOn || [],
    supersedes:t.supersedes||[],resolution:t.resolution||null,attention:t.attention?pick(t.attention,['id','message','kind','createdAt','acknowledged']):null,
    budgetExhausted: attempts.exhausted(t), waitingForWorker: t.state === 'ready' && !matches(p, t), attempts: (t.attempts || []).map(a => ({ ...pick(a, ['id','role','workerId','provider','model','startedAt','claimedAt','settled','claimedBy']), settledAt: a.settledAt,
      progress: pick(a.progress, ['at','stage','summary']), wakeNotice: pick(a.wakeNotice, ['status','at','error','marker']), usage: a.usage || a.observedUsage || null,
      usageStatus: require('./usage.cjs').observation(a) })) }));
  const alerts = [{ code: service.online ? 'external_service' : 'external_service_offline', message: service.online ? '项目由另一服务实例维护；当前看板汇总为只读。' : '项目服务当前未运行；显示磁盘中最后保存的状态。' }];
  if (p.paused) alerts.push({ code: 'paused', message: '项目暂停，后续调度停止' });
  if (p.startup?.state === 'waiting') alerts.push({ code: 'startup', message: '等待大脑完成启动门禁' });
  if (p.planning?.state === 'pending') alerts.push({ code: 'planning', message: '阶段收尾待处理' });
  for (const t of tasks) if (['blocked','uncertain'].includes(t.state)) alerts.push({ code: t.state, taskId: t.id, message: t.error || '任务需要核实' });
  return { id: p.id, workspace: p.workspace, mode: p.mode, archivedAt: p.archivedAt, paused: !!p.paused, completedAt: p.completedAt,
    usage:require('./usage.cjs').summary(state,p.id),reviewStages:require('./stage-review.cjs').summary(p),
    startup: p.startup?.state, planning: p.planning ? { state: p.planning.state, needsAttention: !!p.planning.needsAttention } : null,
    connections, tasks, alerts, readOnly: true, service: { key: service.key, dataRoot: service.root, online: service.online, kind: service.kind } };
}
function aggregateSnapshot(snapshot, currentRoot, options = {}) {
  const services = registry.discover(currentRoot, options).map(entry => ({ ...entry, kind: sourceKind(entry.root, entry.workspaces, options.home) }));
  const projects = snapshot.projects.map(project => ({ ...project, readOnly: false, service: { key: services.find(s => s.current)?.key || registry.keyOf(currentRoot), dataRoot: path.resolve(currentRoot), online: true, kind: services.find(s => s.current)?.kind || 'custom' } }));
  const seen = new Set(projects.map(p => p.id));
  for (const service of services) {
    if (service.current) continue;
    try {
      const state = registry.stateAt(service.root);
      for (const project of Object.values(state?.projects || {})) if (!seen.has(project.id)) { projects.push(persistedProject(project, service,state)); seen.add(project.id); }
    } catch { /* Service remains listed; unreadable projects are omitted. */ }
  }
  // [AI-added] 2026-09-17 13:54
  const seenWorkspaces = new Set(projects.map(project => registry.pathKey(project.workspace)));
  for (const entry of registry.catalog(options)) if (!seenWorkspaces.has(registry.pathKey(entry.workspace))) {
    const id = entry.projectId || `catalog-${entry.key}`;
    projects.push({ id, workspace: entry.workspace, mode: 'desktop', paused: false, connections: [], tasks: [], readOnly: true,
      alerts: [{ code: 'catalog_unavailable', message: entry.workspaceExists ? '项目服务目录不可用；请核对或迁移项目缓存。' : '项目工作目录已不存在；请核对项目位置。' }],
      service: { key: registry.keyOf(entry.dataRoot), dataRoot: entry.dataRoot, online: entry.online, kind: 'project', unavailable: !entry.dataExists } });
    seen.add(id); seenWorkspaces.add(registry.pathKey(entry.workspace));
  }
  return { ...snapshot, projects, services: services.map(service => ({ key: service.key, dataRoot: service.root, online: service.online, current: service.current, kind: service.kind,
    projectCount: projects.filter(project => project.service?.key === service.key).length })) };
}
module.exports = { sourceKind, persistedProject, aggregateSnapshot };
