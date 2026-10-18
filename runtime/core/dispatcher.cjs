'use strict';
const {bindingKey,workerId:validateWorkerId,matches}=require('./bindings.cjs');
const attempts = require('./attempts.cjs');
// [AI-added] 2026-09-12 11:00

const fs = require('node:fs');
const path = require('node:path');
const { atomic, StorageWriteError, read, id, sha, overlaps, plainDirectory } = require('./storage.cjs');
const { snapshot, manifest, difference, allowed, validatePaths, loadSnapshot, reviewCopy } = require('./snapshot.cjs');
const snapshotApi = require('./snapshot.cjs');
const { name, nonempty, parseResult, prompt } = require('./contracts.cjs');
// [AI-added] 2026-09-21 09:38: Resolved replacement tasks are terminal without pretending the original task passed review.
const taskState = require('./task-state.cjs');

function taskReferences(project, startId, targetId, field = 'dependsOn', seen = new Set()) {
  if (seen.has(startId)) return false;
  seen.add(startId);
  return (project.tasks[startId]?.[field] || []).some(id => id === targetId || taskReferences(project, id, targetId, field, seen));
}

function replacementInput(input) {
  const supersedes = input.supersedes || [];
  if (!Array.isArray(supersedes) || new Set(supersedes).size !== supersedes.length) throw Error('supersedes must be a unique array');
  for (const taskId of supersedes) name(taskId);
  if (supersedes.length) nonempty(input.supersedeReason, 'supersedeReason');
  return supersedes;
}
class Dispatcher {
  constructor(store, config) {
    this.store = store; this.config = config;
    this.active = new Map(); this.stopping = false;
    this.storageReservations = new Map();
    // [AI-added] 2026-09-22 09:20: This gate works even when state.json cannot be written.
    this.pendingSettlements = new Map();
    this.artifacts = path.join(store.root, 'artifacts');
    fs.mkdirSync(this.artifacts, { recursive: true });
  }
  addProject(input) {
    const projectId = name(input.id), workspace = plainDirectory(input.workspace);
    // [AI-added] 2026-09-17 11:46
    const roots=require('./data-root.cjs'),projectLocal=path.resolve(this.store.root)===roots.projectDataRoot(workspace)&&roots.inside(workspace,this.store.root);
    if (overlaps(workspace, this.store.root) && !projectLocal) throw Error('Workspace and service data must be disjoint unless using protected .task-dispatch/runtime storage');
    if (input.mode !== 'desktop') throw Error('Version 1.0 requires desktop stage workflow; headless single-task dispatch is removed');
    const maxTurns = input.maxTurns ?? null;
    if (maxTurns !== null) attempts.limit(maxTurns);
    this.store.change(s => {
      if (s.projects[projectId]) throw Error('Project already exists');
      const deletedId = s.deletedProjects?.[projectId] ? projectId : Object.keys(s.deletedProjects || {}).find(k => s.deletedProjects[k].workspace === workspace);
      if (deletedId) {
        if (input.recreateDeleted !== true) throw Error('Project was deleted; explicit add-project with recreateDeleted:true is required');
        delete s.deletedProjects[deletedId];
      }
      for (const p of Object.values(s.projects)) if (overlaps(p.workspace, workspace)) throw Error('Overlapping project workspaces');
      s.projects[projectId] = { id: projectId, workspace, mode: 'desktop', maxTurns, projectBudgetEnabled:maxTurns!==null, turns: 0, paused: false, tasks: {}, ...(input.webSetup ? require('./project-setup.cjs').fields(input.webSetup) : {}) };
      s.projects[projectId].startup={state:'waiting'};
      this.store.event(s, 'project_registered', { projectId });
    });
  }
  addTask(projectId, input) {
    name(input.id); validatePaths(input.allowedPaths);
    const supersedes = replacementInput(input);
    const maxAttempts = attempts.limit(input.maxAttempts ?? attempts.DEFAULT_LIMIT);
    if(input.workerId!==undefined)validateWorkerId(input.workerId);
    if(input.requiredCapability!==undefined)validateWorkerId(input.requiredCapability);
    nonempty(input.title, 'title'); nonempty(input.instructions, 'instructions'); nonempty(input.acceptance, 'acceptance');
    const deps = input.dependsOn || [];
    if (!Array.isArray(deps)) throw Error('dependsOn must be an array');
    this.store.change(s => {
      const p = s.projects[projectId]; if (!p) throw Error('Unknown project');
      const goalId = require('./goals.cjs').taskGoal(p, input.goalId);
      // [AI-added] 2026-09-24 14:02: Check named deliverables against workspace ignore rules.
      const excluded = require('./snapshot.cjs').excludedTaskPaths(input.allowedPaths, p.snapshotPolicy, p.workspace);
      if (excluded.length) throw Error('Task allowedPaths overlap snapshot-excluded temporary paths: ' + excluded.join(', ') + '. Move deliverables outside tmp/ or configure a dedicated reviewed directory.');
      if (p.archivedAt) throw Error('Restore archived project before adding tasks');
      require('./startup.cjs').assertStarted(p);
      if (p.completedAt) throw Error('Project completed; reopen before adding tasks');
      if(require('./stage-review.cjs').active(p))throw Error('Stage plan frozen; resolve the active stage before adding tasks');
      if (input.validationProfile !== undefined && !Object.hasOwn(p.reviewProfiles || {}, input.validationProfile)) throw Error('Unknown approved validation profile');
      if (p.tasks[input.id] || deps.some(d => !p.tasks[d] || d === input.id)) throw Error('Duplicate task or missing dependency (add prerequisites first)');
      for (const targetId of supersedes) {
        const target = p.tasks[targetId];
        if (goalId && target?.goalId !== goalId) throw Error('修复任务不能替代其他目标的执行任务');
        if (!target || target.state !== 'blocked') throw Error('supersedes requires an existing blocked task: ' + targetId);
        if ((target.attempts || []).some(attempt => !attempt.settled)) throw Error('Cannot supersede a task with an unsettled attempt: ' + targetId);
        if (taskReferences(p, targetId, input.id, 'supersedes')) throw Error('supersedes relationship would create a cycle: ' + targetId);
        if (Object.values(p.tasks).some(task => task.supersedes?.includes(targetId) && !taskState.terminal(task))) throw Error('Blocked task already has an unfinished replacement: ' + targetId);
        if (deps.includes(targetId) || deps.some(dep => taskReferences(p, dep, targetId))) throw Error('Replacement task cannot depend on the blocked task it supersedes: ' + targetId);
      }
      p.tasks[input.id] = { id: input.id, title: input.title, instructions: input.instructions, acceptance: input.acceptance, allowedPaths: input.allowedPaths, dependsOn: deps,
        ...(goalId ? { goalId } : {}),
        ...(supersedes.length ? { supersedes, supersedeReason: input.supersedeReason.trim() } : {}),
        state: 'ready', repairs: 0, sessions: {}, attempts: [], findings: [] };
      Object.assign(p.tasks[input.id], attempts.taskFields({ ...input, maxAttempts }));
      if (input.validationProfile) p.tasks[input.id].validationProfile = input.validationProfile;
      this.store.event(s, 'task_created', { projectId, goalId, taskId: input.id });
    });
  }
  pause(projectId, paused) {
    if (!paused && this.store.state.projects[projectId]?.archivedAt) throw Error('Restore archived project before resuming');
    this.store.change(s => { if (!s.projects[projectId]) throw Error('Unknown project'); s.projects[projectId].paused = !!paused; });
  }
  finishProject(projectId, reopen = false) {
    if (this.active.has(projectId)) throw Error('Project still running');
    this.store.change(s => {
      const p = s.projects[projectId]; if (!p) throw Error('Unknown project');
      if (reopen) { if(p.completedAt)p.startup={state:'waiting'};delete p.completedAt; }
      else {
        if (p.goals && Object.values(p.goals).some(goal => !require('./goals.cjs').ended(goal))) throw Error('还有未完成目标；请使用 finish-goal 完成活动目标，或取消尚未开始的目标');
        const tasks=Object.values(p.tasks);
        if (require('./stage-review.cjs').active(p) || require('./stage-review.cjs').unresolved(p) || (!tasks.length && !Object.keys(p.goals || {}).length) || tasks.some(t => !taskState.terminal(t))) throw Error('Finish requires a nonempty queue with every task accepted or resolved by an accepted replacement');
        p.completedAt ||= new Date().toISOString();
        if (p.planning) {
          for(const activity of Object.values(p.brainActivities||{}))if(activity.source==='planning:'+p.planning.id&&!activity.settledAt){activity.settledAt=p.completedAt;activity.settled=true;this.store.event(s,'brain_activity_ended',{projectId,activityId:activity.id});}
          p.planningHistory ||= [];
          p.planningHistory.push({...p.planning,state:'completed',resolvedAt:p.completedAt,resolution:{outcome:'completed',summary:'Project explicitly finished by administrator'}});
          this.store.event(s,'planning_resolved',{projectId,planningId:p.planning.id,outcome:'completed'});
          delete p.planning;
        }
        for (const b of Object.values(p.bindings || {})) { b.armed=false;delete b.armedAt; }
      }
      this.store.event(s,reopen?'project_reopened':'project_completed',{projectId});
    });
  }
  budget(projectId, maxTurns) {
    if (maxTurns !== null) attempts.limit(maxTurns);
    this.store.change(s => { const p=s.projects[projectId];if (!p) throw Error('Unknown project'); p.maxTurns = maxTurns;p.projectBudgetEnabled=maxTurns!==null;this.store.event(s,'project_budget_updated',{projectId,maxTurns}); });
  }
  taskBudget(projectId, taskId, additionalAttempts, reason) {
    attempts.limit(additionalAttempts);nonempty(reason,'Budget reason');
    this.store.change(s=>{const t=s.projects[projectId]?.tasks[taskId];if(!t)throw Error('Unknown task');const before=t.maxAttempts;t.maxAttempts=attempts.limit(before+additionalAttempts);this.store.event(s,'task_budget_extended',{projectId,taskId,before,maxAttempts:t.maxAttempts,additionalAttempts,reason});});
  }
  configureValidation(projectId, config, profileName) {
    if(require('./stage-review.cjs').active(this.store.state.projects[projectId]||{}))throw Error('Validation is frozen by an active stage');
    if (profileName !== undefined) name(profileName);
    if (config?.mode === 'static' && !profileName) throw Error('Static validation requires a named profile');
    const value=config?.mode === 'static' ? {mode:'static',reason:nonempty(config.reason,'Static reason')} : require('./validation.cjs').policy(config);
    if(this.active.has(projectId))throw Error('Project still running');
    this.store.change(s=>{const p=s.projects[projectId];if(!p)throw Error('Unknown project');if(Object.values(p.tasks).some(t=>['running','reviewing'].includes(t.state)))throw Error('Configure at an idle/blocked review boundary');if(profileName){p.reviewProfiles||={};p.reviewProfiles[profileName]=value;}else p.reviewValidation=value;});
  }
  configureSnapshot(projectId, input) {
    if(require('./stage-review.cjs').active(this.store.state.projects[projectId]||{}))throw Error('Snapshot policy is frozen by an active stage');
    const value = require('./snapshot.cjs').policy(input);
    if (this.active.has(projectId)) throw Error('Project still running');
    this.store.change(s => {
      const p = s.projects[projectId]; if (!p) throw Error('Unknown project');
      if (Object.values(p.tasks).some(t => ['running','reviewing','review_ready','uncertain'].includes(t.state))) throw Error('Snapshot policy requires an idle boundary without pending review');
      // [AI-added] 2026-09-24 14:02: Apply local ignore rules during policy changes too.
      const conflicts = Object.values(p.tasks).filter(t => !taskState.terminal(t)).flatMap(t => require('./snapshot.cjs').excludedTaskPaths(t.allowedPaths, value, p.workspace).map(file => `${t.id}:${file}`));
      if (conflicts.length) throw Error('Snapshot exclusions overlap unfinished task allowedPaths: ' + conflicts.join(', '));
      p.snapshotPolicy = value;
    });
  }
  checkStorage(extraBytes = 0) {
    const m = require('./maintenance.cjs'), cfg = m.policy(this.store.state.storagePolicy);
    const bytes = ['artifacts','reviews','validations'].reduce((n,k) => n + (fs.existsSync(path.join(this.store.root,k)) ? m.size(path.join(this.store.root,k)) : 0),0);
    const reserved = [...this.storageReservations.values()].reduce((a,b)=>a+b,0);
    if (bytes + reserved + extraBytes > cfg.maxBytes) throw Error(`Storage budget exceeded: stored=${bytes}, reserved=${reserved}, required=${extraBytes}, limit=${cfg.maxBytes}. Preview cleanup or raise capacity.`);
    const disk = fs.statfsSync(this.store.root);
    if (extraBytes + reserved > disk.bavail * disk.bsize) throw Error('Insufficient free disk space for service copy');
  }
  createSnapshot(workspace, config) { return snapshot(workspace, this.artifacts, config, bytes => this.checkStorage(bytes)); }
  // [AI-added] 2026-09-17 11:46
  assertReviewWorkspace(p,t,snapshotPolicy,stage) {
    const candidate=loadSnapshot(this.artifacts,t.artifactId),live=manifest(p.workspace,snapshotPolicy),changed=difference(candidate.files,live);
    if(!changed.length)return;
    const control=require('./scope-recovery.cjs').controlFile,business=changed.filter(file=>!control(file));
    if(business.length)throw Error('Candidate is stale; live workspace differs from candidate: '+business.join(', '));
    const signature=sha(JSON.stringify({artifactHash:t.artifactHash,changed}));
    if(t.controlDrift?.at(-1)?.signature===signature)return;
    this.store.change(s=>{const q=s.projects[p.id].tasks[t.id];q.controlDrift||=[];q.controlDrift.push({at:new Date().toISOString(),stage,signature,paths:changed});this.store.event(s,'review_control_drift_accepted',{projectId:p.id,taskId:t.id,summary:changed.join(', ')});});
  }
  reviseTask(projectId, taskId, input, reason) {
    const stageProject=this.store.state.projects[projectId],stageTask=stageProject?.tasks[taskId];
    if(stageTask?.roundId){const round=stageProject.reviewStages[stageTask.roundId];if(!stageProject.paused||this.active.has(projectId)||!['collecting','blocked'].includes(round?.state)||round.attempt||Object.values(stageProject.tasks).some(t=>['running','reviewing','uncertain'].includes(t.state)))throw Error('Pause the stage at an idle boundary before revising an unstarted task');}
    nonempty(reason, 'Revision reason');
    if (this.active.has(projectId)) throw Error('Project still running');
    name(input?.id);
    if (input.id !== taskId) throw Error('Revision task id mismatch');
    validatePaths(input.allowedPaths);
    nonempty(input.title, 'title'); nonempty(input.instructions, 'instructions'); nonempty(input.acceptance, 'acceptance');
    const deps = input.dependsOn || [], supersedes = replacementInput(input);
    if (!Array.isArray(deps)) throw Error('dependsOn must be an array');
    this.store.change(s => {
      const p = s.projects[projectId], t = p?.tasks[taskId];
      if (!t || t.state !== 'ready' || t.attempts.length || p.completedAt || p.archivedAt) throw Error('Only an unstarted ready task can be revised; create a replacement task after execution starts');
      if (p.goals && (require('./goals.cjs').taskGoal(p, input.goalId) !== t.goalId)) throw Error('只能修订当前目标的执行任务');
      if (deps.some(dep => !p.tasks[dep] || dep === taskId || taskReferences(p,dep,taskId))) throw Error('Revision has a missing, self or cyclic dependency');
      if(t.roundId&&deps.some(dep=>!require('./stage-review.cjs').dependencyReady(p,t,dep)&&p.tasks[dep].stageId!==t.stageId))throw Error('Revised stage dependency must be inside the stage or already accepted');
      if (input.validationProfile !== undefined && !Object.hasOwn(p.reviewProfiles || {}, input.validationProfile)) throw Error('Unknown approved validation profile');
      // [AI-added] 2026-09-24 14:02: Revised named paths must remain visible to snapshots.
      const excluded = require('./snapshot.cjs').excludedTaskPaths(input.allowedPaths, p.snapshotPolicy, p.workspace);
      if (excluded.length) throw Error('Task allowedPaths overlap snapshot-excluded temporary paths: ' + excluded.join(', '));
      for (const targetId of supersedes) {
        const target = p.tasks[targetId];
        if (p.goals && target?.goalId !== t.goalId) throw Error('修复任务不能替代其他目标的执行任务');
        if (!target || target.state !== 'blocked') throw Error('supersedes requires an existing blocked task: ' + targetId);
        if ((target.attempts || []).some(attempt => !attempt.settled)) throw Error('Cannot supersede a task with an unsettled attempt: ' + targetId);
        if (taskReferences(p, targetId, taskId, 'supersedes')) throw Error('supersedes relationship would create a cycle: ' + targetId);
        if (Object.values(p.tasks).some(task => task.id !== taskId && task.supersedes?.includes(targetId) && !taskState.terminal(task))) throw Error('Blocked task already has an unfinished replacement: ' + targetId);
        if (deps.includes(targetId) || deps.some(dep => taskReferences(p, dep, targetId))) throw Error('Replacement task cannot depend on the blocked task it supersedes: ' + targetId);
      }
      t.instructionHistory ||= [];
      t.instructionHistory.push({ contractRevision: t.contractRevision, title: t.title, instructions: t.instructions, acceptance: t.acceptance,
        allowedPaths: t.allowedPaths, dependsOn: t.dependsOn || [], supersedes: t.supersedes || [], supersedeReason: t.supersedeReason || null,
        validationProfile: t.validationProfile || null, at: new Date().toISOString(), reason: reason.trim() });
      Object.assign(t, { title: input.title, instructions: input.instructions, acceptance: input.acceptance, allowedPaths: input.allowedPaths,
        dependsOn: deps, contractRevision: t.contractRevision + 1 });
      if (supersedes.length) { t.supersedes = supersedes; t.supersedeReason = input.supersedeReason.trim(); }
      else { delete t.supersedes; delete t.supersedeReason; }
      if (input.validationProfile) t.validationProfile = input.validationProfile; else delete t.validationProfile;
      if(t.roundId)require('./stage-review.cjs').reviseContract(p,t,reason.trim());
      this.store.event(s, 'task_revised', { projectId, taskId, contractRevision: t.contractRevision, reason: reason.trim() });
    });
  }
  resolveTask(projectId, taskId, replacementTaskId, reason, actor = 'brain') {
    if (this.active.has(projectId)) throw Error('Project still running');
    let duplicate = false;
    this.store.change(s => {
      const p = s.projects[projectId]; if (!p) throw Error('Unknown project');
      const result = taskState.resolve(p, taskId, replacementTaskId, reason, actor);
      duplicate = result.duplicate;
      if (!duplicate) this.store.event(s, 'task_resolved', { projectId, taskId, replacementTaskId, reason: reason.trim(), actor });
    });
    return { ok: true, duplicate, taskId, replacementTaskId };
  }
  retry(projectId, taskId, confirmedStopped, restartWorker = false, reason = null) {
    if (this.active.has(projectId)) throw Error('Project still running');
    this.store.change(s => {
      const p = s.projects[projectId], t = p?.tasks[taskId];
      if (!t || !['blocked', 'uncertain'].includes(t.state)) throw Error('Task is not blocked/uncertain');
      if (t.state === 'uncertain' && confirmedStopped !== true) throw Error('Confirm old agent/background processes have stopped before retry');
      t.state = !restartWorker && t.resumePhase === 'brain' && t.artifactId ? 'review_ready' : 'ready';
      t.error = null; t.blockKind = null; t.repairs = 0;
      // [AI-added] 2026-09-19: An explicit retry settles the outstanding brain attention; a later ack stays idempotent.
      if (t.attention) t.attention.acknowledged = true;
      this.store.event(s, 'operator_retry', { projectId, taskId, ...(reason ? { reason } : {}) });
    });
  }
  // [AI-added] 2026-09-22 09:20: Retry a durable receipt without issuing a new model attempt.
  deferSettlement(projectId,taskId,runId,error){
    const previous=this.pendingSettlements.get(runId);
    const entry=previous||{projectId,taskId,attemptId:runId,retries:0,startedAt:new Date().toISOString()};
    Object.assign(entry,{reason:error.message,code:error.code,retryable:error.retryable===true,receiptPersisted:fs.existsSync(this.receiptPath(runId)),nextAt:Date.now()+1000});
    entry.exhausted=!entry.retryable||!entry.receiptPersisted||entry.retries>=3;
    this.pendingSettlements.set(runId,entry);
  }
  settlementStatus(projectId){return [...this.pendingSettlements.values()].filter(e=>!projectId||e.projectId===projectId).map(e=>({...e}));}
  // [AI-added] 2026-09-22 09:20: Repair only missing notifications, including after a service restart.
  completeSettlementNotification(projectId,taskId){
    let current=this.store.state.projects[projectId].tasks[taskId];const latest=current.attempts.at(-1);
    const fresh=value=>value&&value.createdAt&&latest.settledAt&&value.createdAt>=latest.settledAt;
    const scopePending=(latest.scopeRejectedArtifactId&&(current.scopeReturns>2||current.workerReport?.status==='blocked'))||(latest.scopeRecovery&&current.state==='blocked');
    if(scopePending&&!fresh(current.scopeAlert)){
      require('./scope-recovery.cjs').alert(this,this.store.state.projects[projectId],current,current.error||current.workerReport?.summary||'Scope recovery needs attention');
      current=this.store.state.projects[projectId].tasks[taskId];
    }
    if(['blocked','uncertain'].includes(current.state)&&!fresh(current.attention)&&!fresh(current.scopeAlert))require('./brain-attention.cjs').raise(this,projectId,taskId,current.error);
  }
  retrySettlements(){
    for(const entry of this.pendingSettlements.values()){
      if(entry.exhausted||entry.nextAt>Date.now())continue;
      entry.retries++;
      try{
        const receipt=read(this.receiptPath(entry.attemptId));
        // [AI-added] 2026-09-22 10:20: Shared receipts use the same bounded storage gate.
        if(entry.kind==='batch'){
          require('./stage-review.cjs').settle(this,entry.projectId,entry.roundId,receipt);
          require('./planning.cjs').reconcile(this.store,entry.projectId);
          this.store.change(s=>this.store.event(s,'settlement_recovered',{projectId:entry.projectId,roundId:entry.roundId,attemptId:entry.attemptId,retries:entry.retries,code:entry.code}));
          this.pendingSettlements.delete(entry.attemptId);continue;
        }
        const task=this.store.state.projects[entry.projectId]?.tasks[entry.taskId],run=task?.attempts.at(-1);
        if(!run||run.id!==entry.attemptId)throw Error('Pending settlement no longer matches active attempt');
        if(!run.settled)this.settle(entry.projectId,entry.taskId,entry.attemptId,receipt);
        const current=this.store.state.projects[entry.projectId].tasks[entry.taskId];
        if(!current.attempts.at(-1).settled)continue;
        // A post-commit notification may have failed after the verdict was already durable.
        this.completeSettlementNotification(entry.projectId,entry.taskId);
        this.store.change(s=>this.store.event(s,'settlement_recovered',{projectId:entry.projectId,taskId:entry.taskId,attemptId:entry.attemptId,retries:entry.retries,reason:entry.reason,code:entry.code}));
        this.pendingSettlements.delete(entry.attemptId);
      }catch(e){
        if(e instanceof StorageWriteError)this.deferSettlement(entry.projectId,entry.taskId,entry.attemptId,e);
        else {entry.exhausted=true;entry.reason=e.message;entry.retryable=false;}
      }
    }
  }
  recover() {
    require('./stage-review.cjs').recover(this);
    for (const p of Object.values(this.store.state.projects)) for (const t of Object.values(p.tasks)) {
      // [AI-added] 2026-09-22 09:20: A committed blocked verdict can still lack its separate alert write.
      const latest=t.attempts.at(-1);
      if(latest?.settled&&!p.completedAt&&['blocked','uncertain','ready'].includes(t.state)&&fs.existsSync(this.receiptPath(latest.id))){
        try{this.completeSettlementNotification(p.id,t.id);}
        catch(e){if(!(e instanceof StorageWriteError))throw e;this.deferSettlement(p.id,t.id,latest.id,e);}
      }
      if (!['running', 'reviewing'].includes(t.state)) continue;
      const run = t.attempts.at(-1), receiptPath = this.receiptPath(run.id);
      if (fs.existsSync(receiptPath)) this.settle(p.id, t.id, run.id, read(receiptPath));
      else if (run.delivery) continue;
      else this.block(p.id, t.id, run.id, 'uncertain', 'Service stopped before a durable receipt; reconcile agent before retry');
    }
  }
  receiptPath(runId) { return path.join(this.store.root, 'receipts', runId + '.json'); }
  block(projectId, taskId, runId, state, error) {
    let applied = false;
    this.store.change(s => {
      const t = s.projects[projectId].tasks[taskId], run = t.attempts.at(-1);
      if (run.id !== runId || run.settled) return;
      applied = true;
      t.state = state; t.error = error; t.resumePhase = run.role==='reviewer'?'brain':run.role; run.settled = true; run.settledAt = new Date().toISOString(); run.outcome = state;
      this.store.event(s, state, { projectId, taskId, attemptId: runId, error });
    });
    // [AI-added] 2026-09-19: scope rejections escalate through scope_attention; every other
    // blocked/uncertain settlement must still reach the brain (raise arms the brain wake).
    if (applied && ['blocked','uncertain'].includes(state)) {
      const p = this.store.state.projects[projectId], t = p.tasks[taskId];
      if (!t.attempts.at(-1).scopeRecovery) require('./brain-attention.cjs').raise(this, projectId, taskId, error);
    }
  }
  settle(projectId, taskId, runId, receipt) {
    const p = this.store.state.projects[projectId], t = p.tasks[taskId], run = t.attempts.at(-1);
    if (!run || run.id !== runId || run.settled) return false;
    try {
      if (receipt.attemptId !== runId || receipt.role !== run.role) throw Error('Receipt identity mismatch');
      snapshotApi.frozenPolicy(run.snapshotPolicy);
      if (receipt.usage) {
        const usage = require('./usage.cjs').normalize(receipt.usage);
        this.store.change(s => { s.projects[projectId].tasks[taskId].attempts.at(-1).usage = usage; });
      }
      const result = parseResult(receipt.text, { projectId, taskId, attemptId: runId, role: run.role, artifactId: run.artifactId });
      if (run.role === 'worker') {
        const candidate = loadSnapshot(this.artifacts, receipt.artifactId), before = loadSnapshot(this.artifacts, run.baselineId);
        if (snapshotApi.monitoredHash(manifest(p.workspace, run.snapshotPolicy)) !== candidate.monitoredHash) throw Error('Workspace changed after completion snapshot');
        const scope=require('./scope-recovery.cjs').check(this,p,t,run,candidate,result,receipt);
        if(!scope)return false;
        const changed=scope.changed;
        this.store.change(s => {
          const task = s.projects[projectId].tasks[taskId];
          task.artifactId = candidate.id; task.artifactHash = candidate.hash; task.changedFiles = changed; task.workerReport = result;
          delete task.preReview; delete task.stageHeld;
          task.snapshotPolicy = run.snapshotPolicy;
          delete task.scopeRecovery;
          task.state = result.status === 'blocked' ? 'blocked' : 'review_ready';
          task.resumePhase = 'worker'; task.error = result.status === 'blocked' ? result.summary : null;
          task.attempts.at(-1).settled = true;
          task.attempts.at(-1).artifactId = candidate.id;
          task.attempts.at(-1).settledAt = new Date().toISOString();
          task.attempts.at(-1).submissionHash = sha(receipt.text);
          this.store.event(s, 'worker_submitted', { projectId, taskId, attemptId: runId, artifactId: candidate.id });
        });
        if(result.status==='blocked'){
          // [AI-added] 2026-09-19: A failed scope correction escalates as scope_attention; a plain
          // worker blocked receipt (missing preconditions, contract conflict) reaches the brain too.
          if(run.scopeRecovery)require('./scope-recovery.cjs').alert(this,p,t,result.summary);
          else require('./brain-attention.cjs').raise(this,projectId,taskId,result.summary);
        }
      } else {
        if (run.role !== 'reviewer') throw Error('Individual final review is removed; use stage-submit');
        if (!Array.isArray(receipt.reviewChanges)) throw Error('Review receipt requires reviewChanges');
        if (receipt.reviewChanges.length) throw Error('Reviewer changed its input files: '+receipt.reviewChanges.slice(0,20).map(c=>c.kind+' '+c.path).join(', ').slice(0,2000));
        if (run.validation && result.verdict === 'pass' && run.validation.mode !== 'static' && !run.validation.passed) throw Error('Required validation checks failed; cannot accept candidate');
        // [AI-added] 2026-09-17 11:46
        this.assertReviewWorkspace(p,t,run.snapshotPolicy,'settle');
        this.store.change(s => {
          const task = s.projects[projectId].tasks[taskId];
          task.review = result; task.findings = result.findings;
          task.preReview=result;
          require('./stage-review.cjs').held(s.projects[projectId],task,run,result);
          if (result.verdict === 'pass') task.state = 'review_ready';
          else if (result.verdict === 'blocked') task.state = 'blocked';
          else { task.repairs++; task.state = task.repairs <= 2 ? 'ready' : 'blocked'; }
          task.error = task.state === 'blocked' ? result.summary + (task.repairs > 2 ? ' (automatic repair limit reached)' : '') : null;
          task.resumePhase = result.verdict === 'needs_fix' ? 'worker' : 'brain';
          task.blockKind = result.verdict === 'blocked' ? (result.blockKind || 'review') : null;
          task.attempts.at(-1).settled = true;
          task.attempts.at(-1).settledAt = new Date().toISOString();
          task.attempts.at(-1).submissionHash = sha(receipt.text);
          this.store.event(s, 'review_decision', { projectId, taskId, attemptId: runId, role:run.role, verdict: result.verdict, artifactId: task.artifactId });
        });
        // [AI-added] 2026-09-19: Review verdicts that block the task escalate to the brain too.
        if (this.store.state.projects[projectId].tasks[taskId].state === 'blocked')
          require('./brain-attention.cjs').raise(this, projectId, taskId, this.store.state.projects[projectId].tasks[taskId].error);
      }
      return true;
    } catch (e) {
      // [AI-added] 2026-09-22 09:20: Storage errors are not business verdicts.
      if(e instanceof StorageWriteError){this.deferSettlement(projectId,taskId,runId,e);return false;}
      try{this.block(projectId, taskId, runId, 'blocked', e.message);if(run.scopeRecovery)require('./scope-recovery.cjs').alert(this,p,t,e.message);}
      catch(writeError){if(!(writeError instanceof StorageWriteError))throw writeError;this.deferSettlement(projectId,taskId,runId,writeError);}
      return false;
    }
  }
  tick() {
    if (this.stopping) return;
    // [AI-added] 2026-09-22 09:20: Recover before dispatch; exhausted entries require intervention.
    this.retrySettlements();
    if(this.pendingSettlements.size)return;
    if (this.storageBlocked) return;
    for (const p of Object.values(this.store.state.projects)) require('./goals.cjs').reconcile(this, p.id);
    for (const p of Object.values(this.store.state.projects)) {
      if (p.archivedAt) continue;
      require('./handover.cjs').finish(this,p.id);
      require('./planning.cjs').reconcile(this.store,p.id);
      if (this.active.size >= (this.config.maxConcurrent || 2)) break;
      if (p.paused || p.completedAt || this.active.has(p.id)) continue;
      if (require('./startup.cjs').waiting(p)) continue;
      // [AI-added] 2026-09-22 10:20: Only fixed peers advance while preliminary passes are held.
      const batchGate=require('./stage-review.cjs').gate(this,this.store.state.projects[p.id]);
      if(batchGate?.prepare){
        const controller=new AbortController(),entry={controller,promise:null};this.active.set(p.id,entry);
        entry.promise=require('./stage-review.cjs').prepare(this,p.id,batchGate.batch.id,controller.signal).catch(e=>{this.stopping=true;this.fatal=e;}).finally(()=>this.active.delete(p.id));continue;
      }
      if(batchGate?.stop)continue;
      if (Object.values(p.tasks).some(t => ['running', 'reviewing'].includes(t.state))) continue;
      // An uncertain former writer may still be alive; lock the entire workspace.
      if (Object.values(p.tasks).some(t => t.state === 'uncertain')) continue;
      const liveProject=this.store.state.projects[p.id];
      const task = Object.values(liveProject.tasks).find(t => (!liveProject.goals || t.goalId === liveProject.activeGoalId) && !t.stageHeld && (!batchGate||t.roundId===batchGate.batch.id) && !attempts.exhausted(t) && ['ready', 'review_ready'].includes(t.state) && (t.state==='review_ready'||matches(liveProject,t)) && t.dependsOn.every(d => require('./stage-review.cjs').dependencyReady(liveProject,t,d)));
      if (!task) continue;
      if (task.state==='ready' && !task.scopeRecovery && this.store.state.projects[p.id].planning) continue;
      if (attempts.projectExhausted(p)) { this.pause(p.id, true); continue; }
      const controller = new AbortController();
      const entry = { controller, promise: null };
      this.active.set(p.id, entry);
      entry.promise = this.execute(p.id, task.id, controller.signal).catch(e => {
        // Storage/IO failures stop dispatch rather than continuing with ambiguous state.
        this.stopping = true; this.fatal = e; console.error('Dispatcher stopped:', e.message);
      }).finally(() => this.active.delete(p.id));
    }
  }
  async execute(projectId, taskId, signal) {
    let p = this.store.state.projects[projectId], t = p.tasks[taskId];
    if (attempts.exhausted(t) || attempts.projectExhausted(p)) return;
    if (!t.roundId || t.stageHeld || !require('./pre-review.cjs').online(this,p)) return;
    const role = t.state === 'review_ready' ? 'reviewer' : 'worker', runId = id();
    if(role==='worker'&&!t.scopeRecovery&&t.allowedPaths.every(f=>!require('./scope-recovery.cjs').writable(f,t.allowedPaths,t.id))){
      require('./scope-recovery.cjs').alert(this,p,t,'任务仅授权了受保护目录或其他任务的回执路径。请大脑明确执行任务，将回执放到 docs/worker-results/'+t.id+'/，设计与契约留在大脑端；本次未消耗执行回合。');return;
    }
    // [AI-added] 2026-09-24 14:02: A running attempt cannot alter its diff by editing .taskignore.
    // [AI-added] 2026-09-24 14:19: Invalid ignore files are task attention, not dispatcher-fatal errors.
    let snapshotPolicy;
    try { snapshotPolicy = role === 'worker' ? snapshotApi.workspacePolicy(p.workspace,p.snapshotPolicy) : snapshotApi.frozenPolicy(t.snapshotPolicy); }
    catch (e) {
      this.store.change(s => { const task = s.projects[projectId].tasks[taskId]; task.state = 'blocked'; task.error = e.message; task.resumePhase = role === 'reviewer' ? 'brain' : role; });
      require('./brain-attention.cjs').raise(this, projectId, taskId, e.message);
      return;
    }
    const binding= p.bindings?.[bindingKey({role,workerId:t.currentWorkerId})];
    const run = { id: runId, role, ...(role==='worker'?{workerId:t.currentWorkerId}:{}), snapshotPolicy, contractRevision:t.contractRevision,
      provider: binding?.provider || 'desktop', model: binding?.wake?.model || null, startedAt: new Date().toISOString(), settled: false };
    if (binding?.wake) run.usageBinding = structuredClone(binding.wake);
    if(role==='worker' && t.scopeRecovery){
      run.scopeRecovery=structuredClone(t.scopeRecovery);
      run.reviewBaselineId=t.scopeRecovery.originalBaselineId;
      const current=manifest(p.workspace,snapshotPolicy);
      if(t.scopeRecovery.targets.some(x=>JSON.stringify(current[x.path]||null)!==JSON.stringify(x.observed)&&JSON.stringify(current[x.path]||null)!==JSON.stringify(x.expected))){require('./scope-recovery.cjs').alert(this,p,t,'越界文件在退回后又被修改，无法安全恢复；需要大脑核对差异。');return;}
    }
    let cwd = p.workspace, reviewManifest;
    const validationConfig = t.validationProfile ? p.reviewProfiles?.[t.validationProfile] : p.reviewValidation;
    try {
      if (role === 'worker') {
        // [AI-added] 2026-09-24 14:17: Recheck after registration; a later rule edit cannot hide a named deliverable.
        const excluded = snapshotApi.excludedTaskPaths(t.allowedPaths, snapshotPolicy);
        if (excluded.length) throw Error('Task allowedPaths overlap snapshot-excluded paths: ' + excluded.join(', '));
        run.baselineId = this.createSnapshot(cwd, snapshotPolicy).id;
      }
      else {
        // [AI-added] 2026-09-17 11:46
        this.assertReviewWorkspace(p,t,snapshotPolicy,'prepare');
        run.artifactId = t.artifactId;
        this.checkStorage(require('./maintenance.cjs').size(path.join(this.artifacts,t.artifactId,'tree')) * 2);
        cwd = path.join(this.store.root, 'reviews', runId, 'tree');
        reviewManifest = reviewCopy(this.artifacts, t.artifactId, cwd, snapshotPolicy);
        if (snapshotApi.monitoredHash(reviewManifest) !== loadSnapshot(this.artifacts, t.artifactId).monitoredHash) throw Error('Stored candidate snapshot integrity mismatch');
        const evidence = path.join(cwd, '.dispatch-evidence');
        if (fs.existsSync(evidence)) throw Error('Reserved .dispatch-evidence path exists');
        // The reviewer can inspect BEFORE and AFTER, including pre-existing untracked files.
        const workerRun = t.attempts.findLast(a => a.role === 'worker');
        if (!workerRun) throw Error('Preliminary review requires a submitted worker candidate');
        fs.mkdirSync(evidence, { recursive: true });
        for (const name of t.changedFiles) {
          const source = path.join(this.artifacts, workerRun.reviewBaselineId || workerRun.baselineId, 'tree', name);
          if (fs.existsSync(source)) {
            const dest = path.join(evidence, 'before', name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(source, dest);
          }
        }
        atomic(path.join(evidence, 'changes.json'), { changedFiles: t.changedFiles, reviewPaths: t.changedFiles, beforeDirectory: '.dispatch-evidence/before', candidateDirectory: '.', workerReport: t.workerReport });
        if(workerRun.scopeRecovery)atomic(path.join(evidence,'scope-recovery.json'),workerRun.scopeRecovery);
        // Evidence duplicates source; limits protect project snapshots, not generated evidence size.
        run.reviewPolicy = { ...snapshotPolicy, maxTotalBytes: Number.MAX_SAFE_INTEGER, maxFileBytes: Number.MAX_SAFE_INTEGER };
        reviewManifest = manifest(cwd, run.reviewPolicy);
      }
    } catch (e) {
      this.store.change(s => { const task = s.projects[projectId].tasks[taskId]; task.state = 'blocked'; task.error = e.message; task.resumePhase = role==='reviewer'?'brain':role; });
      // [AI-added] 2026-09-19: The attempt was never recorded, so block() cannot fire; escalate directly.
      require('./brain-attention.cjs').raise(this, projectId, taskId, e.message);
      return;
    }
    const delivery = () => ({ cwd, prompt: prompt(p, t, { ...run, artifactId: t.artifactId }) + '\n\n桌面会话模式：上述最终 JSON 是提交报告格式。将报告保存到项目外，通过 desktop-client submit 提交；不要仅在聊天里回复就结束交接。按 submit 返回的 nextAction/nextInstruction 继续：已绑定唤醒则实际 park，返回 job 继续处理，parked:true 才结束回合；无唤醒则实际 wait --seconds 60，宿主工具超时至少 90 秒。completed:true 才停止协作。', ...(reviewManifest ? { reviewManifest } : {}) });
    if (!(role!=='worker'&&validationConfig)) run.delivery=delivery();
    this.store.change(s => {
      const task = s.projects[projectId].tasks[taskId]; task.state = role === 'worker' ? 'running' : 'reviewing'; task.attempts.push(run); s.projects[projectId].turns++;
      this.store.event(s, 'attempt_prepared', { projectId, taskId, attemptId: runId, role });
    });
    p = this.store.state.projects[projectId]; t = p.tasks[taskId];
    if(role!=='worker'&&validationConfig){
      try {
        if (validationConfig.mode === 'static') {
          if (t.changedFiles.some(f => !/\.(md|txt|rst)$/i.test(f))) throw Error('Static profile only permits documentation changes');
          run.validation = { mode:'static', reason:validationConfig.reason, checksRun:false, artifactId:t.artifactId, artifactHash:t.artifactHash };
          atomic(path.join(cwd,'.dispatch-evidence','validation.json'),run.validation);
        } else {
          const required = require('./maintenance.cjs').size(path.join(this.artifacts,t.artifactId,'tree')) + require('./maintenance.cjs').size(path.join(p.workspace,'node_modules'));
          this.checkStorage(required); this.storageReservations.set(run.id, required);
          run.validation=await require('./validation.cjs').prepareIsolated({workspace:p.workspace,artifacts:this.artifacts,artifactId:t.artifactId,artifactHash:t.artifactHash,changedFiles:t.changedFiles,root:path.join(this.store.root,'validations',run.id),config:validationConfig,signal,onProcess:pid=>this.store.change(s=>{s.projects[projectId].tasks[taskId].attempts.at(-1).validationPid=pid;})});
          this.storageReservations.delete(run.id);
          fs.copyFileSync(run.validation.reportPath,path.join(cwd,'.dispatch-evidence','validation.json'));
          // [AI-added] 2026-09-22 09:20: Mechanical evidence failures stop before model review delivery.
          if(validationConfig.evidenceResult&&!run.validation.passed){
            this.store.change(s=>{s.projects[projectId].tasks[taskId].attempts.at(-1).validation=run.validation;});
            this.block(projectId,taskId,run.id,'blocked','Evidence validation failed; inspect '+run.validation.reportPath);
            this.store.change(s=>{s.projects[projectId].tasks[taskId].blockKind='evidence';});return;
          }
        }
        reviewManifest=manifest(cwd, run.reviewPolicy);
        this.store.change(s=>{const a=s.projects[projectId].tasks[taskId].attempts.at(-1);a.validation=run.validation;a.delivery=delivery();});
      }catch(e){
        this.storageReservations.delete(run.id);
        this.block(projectId,taskId,run.id,e.uncertain?'uncertain':'blocked',e.message);
        this.store.change(s=>{s.projects[projectId].tasks[taskId].blockKind='environment';});return;
      }
    }
  }

  async stop() {
    this.stopping = true;
    for (const entry of this.active.values()) entry.controller.abort();
    await Promise.all([...this.active.values()].map(e => e.promise));
  }
}
module.exports = { Dispatcher };
