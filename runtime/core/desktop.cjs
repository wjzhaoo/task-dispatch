'use strict';
const path = require('node:path');
const { id, sha, atomic, read, plainDirectory, desktopProjectId } = require('./storage.cjs');
// [AI-added] 2026-09-22 09:20: Durable receipt existence is checked before any replacement.
const fs = require('node:fs');
const { snapshot, manifest, difference, changes, reservedNames, loadSnapshot, allowed, ignored } = require('./snapshot.cjs');
const { parseResult } = require('./contracts.cjs');
const {workerId:validateWorkerId,bindingKey,capabilities:validateCapabilities,matches} = require('./bindings.cjs');
const attempts = require('./attempts.cjs');
class Desktop {
  constructor(dispatcher) { this.d = dispatcher; this.store = dispatcher.store; dispatcher.desktop = this; }
  attach({ workspace, role, clientId, token, sessionId, workerId, capabilities, replaceClientId, recover, confirmedStopped, managedRebind, rebindInvitationId, joinInvitationId }) {
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200)) throw Error('Invalid sessionId');
    if (!['brain', 'worker', 'reviewer'].includes(role)) throw Error('Role must be brain, worker or reviewer');
    // [AI-added] 2026-09-16 21:34
    if(recover!==undefined||confirmedStopped!==undefined){
      if(recover!==true||confirmedStopped!==true)throw Error('Recovery requires recover=true and confirmedStopped=true');
      // [AI-added] 2026-09-17 11:46
      if(!replaceClientId&&!managedRebind)throw Error('Recovery requires an existing binding and a different replacement client');
    }
    if (role !== 'worker' && workerId !== undefined) throw Error(role+' cannot have workerId');
    const key=bindingKey({role,workerId}), caps=validateCapabilities(capabilities);
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(clientId)) throw Error('Invalid clientId');
    const dir = plainDirectory(workspace);
    let p = Object.values(this.store.state.projects).find(p => p.workspace === dir);
    if (joinInvitationId) {
      if (!p?.webSetup || require('./project-setup.cjs').joinId(p, key) !== joinInvitationId) throw Error('首次接入邀请无效，或目标成员已变化');
      if (p.bindings?.[key] && p.bindings[key].clientId !== clientId) throw Error('该成员已加入；首次邀请不能替换现有会话，请使用改绑邀请');
      if (replaceClientId || managedRebind) throw Error('首次接入邀请不能用于改绑');
    }
    if (!p) {
      const projectId = desktopProjectId(dir);
      this.d.addProject({ id: projectId, workspace: dir, mode: 'desktop' });
      p = this.store.state.projects[projectId];
    }
    if (p.mode !== 'desktop') throw Error('Workspace is registered in headless mode; use a separate workspace');
    if (p.archivedAt) throw Error('Project archived; restore it in the management console');
    // [AI-added] 2026-09-17 11:46
    let invitation;
    if(managedRebind){
      invitation=require('./rebind-invitations.cjs').authorize(this.store,{workspace:dir,invitationId:rebindInvitationId,role,workerId,recover,clientId});
      if(invitation.completed){recover=undefined;confirmedStopped=undefined;replaceClientId=undefined;}
      else if(replaceClientId!==invitation.invite.previousClientId)throw Error('Managed rebind invitation no longer matches the selected binding');
    }
    if(sessionId && Object.entries(p.bindings||{}).some(([k,b])=>k!==key&&(b.sessionId===sessionId||b.wake?.threadId===sessionId))) throw Error('Session already bound to another project role/worker');
    if(sessionId && Object.entries(p.handovers||{}).some(([k,b])=>k!==key&&b.sessionId===sessionId))throw Error('Session already waiting for another role/worker');
    const old = p.bindings?.[key];
    if(old && replaceClientId && old.clientId!==clientId) {
      if(old.clientId!==replaceClientId)throw Error('Binding changed during handover; inspect current owner');
      if(!sessionId || typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw Error('Handover requires session and new token');
      const next={previousClientId:old.clientId,clientId,tokenHash:sha(token),sessionId,capabilities:caps,...(managedRebind?{invitationId:rebindInvitationId}:{})};
      // [AI-added] 2026-09-16 21:34
      const pending=p.handovers?.[key],differentPending=pending&&JSON.stringify(pending)!==JSON.stringify(next);
      if(differentPending&&!recover)throw Error('Another session is already waiting for handover');
      if(!pending||differentPending)this.store.change(s=>{const q=s.projects[p.id];q.handovers||={};q.handovers[key]=next;this.store.event(s,'desktop_handover_requested',{projectId:p.id,binding:key,from:old.clientId,to:clientId,...(differentPending?{supersededClientId:pending.clientId}:{})});});
      if(managedRebind)require('./rebind-invitations.cjs').update(this.store,p.id,rebindInvitationId,'claimed',clientId);
      // [AI-added] 2026-09-16 21:34
      if(recover){
        const result=require('./handover.cjs').recoverBinding(this.d,p.id,key,next,differentPending?pending.clientId:undefined);
        return {projectId:p.id,role,clientId,handoverPending:false,...result};
      }
      require('./handover.cjs').finish(this.d,p.id);
      const handoverPending=!!this.store.state.projects[p.id].handovers?.[key];
      return {projectId:p.id,role,clientId,...(role==='worker'?{workerId:validateWorkerId(workerId)}:{}),handoverPending,
        ...(handoverPending?{message:'正在交接：旧端须提交在途任务或解决原执行员恢复；服务在安全边界自动换绑。新端暂不执行，请保留本会话并再次 connect 核对。'}:{})};
    }
    if(recover!==undefined||confirmedStopped!==undefined)throw Error('Brain recovery requires a different bound session/client');
    if (old) {
      if (old.clientId !== clientId || !token || old.tokenHash !== sha(token)) throw Error('Role already bound to another client; reuse its credential file');
      if (sessionId && ((old.sessionId && old.sessionId !== sessionId) || (old.wake?.threadId && old.wake.threadId !== sessionId))) throw Error('Role belongs to another session');
      if (capabilities !== undefined && JSON.stringify(caps) !== JSON.stringify(old.capabilities || [])) throw Error('Capabilities changed; detach before replacing worker configuration');
      if (sessionId && !old.sessionId) this.store.change(s => { s.projects[p.id].bindings[key].sessionId = sessionId; });
      return { projectId: p.id, role, clientId, token, ...(role==='worker'?{workerId:validateWorkerId(workerId)}:{}) };
    }
    // Caller creates a random token before registering, so a lost response can safely retry.
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw Error('Expected random client token');
    this.store.change(s => {
      const q = s.projects[p.id]; q.bindings ||= {};
      q.bindings[key] = { clientId, tokenHash: sha(token), capabilities:caps, ...(sessionId ? {sessionId} : {}) };
      this.store.event(s, 'desktop_attached', { projectId: p.id, role, clientId });
    });
    return { projectId: p.id, role, clientId, token, ...(role==='worker'?{workerId:validateWorkerId(workerId)}:{}) };
  }
  authenticate(token) {
    if (!token) throw Error('Missing desktop token');
    const hash = sha(token);
    for (const p of Object.values(this.store.state.projects)) for (const [key, b] of Object.entries(p.bindings || {})) {
      if (b.tokenHash === hash) return { projectId:p.id,role:['brain','reviewer'].includes(key)?key:'worker',...(['brain','reviewer'].includes(key)?{}:{workerId:key==='worker'?'default':key.slice(7)}),clientId:b.clientId };
    }
    throw Error('Invalid desktop token');
  }
  assertBinding(identity) {
    if (this.store.state.projects[identity.projectId]?.archivedAt) throw Error('Project archived; restore it in the management console');
    const b=this.store.state.projects[identity.projectId]?.bindings?.[bindingKey(identity)];
    if (!b || b.clientId!==identity.clientId) throw Error('Binding revoked; reconnect before working');
    require('./pre-review.cjs').touch(this.d,identity);
    return b;
  }
  detach(identity, target, targetRole) {
    this.assertBinding(identity);
    if(targetRole!==undefined&&targetRole!=='reviewer')throw Error('Only reviewer can be selected with --role');
    if(targetRole&&identity.role!=='brain')throw Error('Only brain can detach reviewer');
    if(targetRole&&target!==undefined)throw Error('Choose reviewer role or workerId, not both');
    const key=targetRole==='reviewer'?'reviewer':target ? bindingKey({role:'worker',workerId:target}) : bindingKey(identity);
    if (key!==bindingKey(identity) && identity.role!=='brain') throw Error('Only brain can detach another worker');
    const p=this.store.state.projects[identity.projectId];
    const unfinished=require('./handover.cjs').pendingWork(p,key);
    if(key==='reviewer'&&unfinished)require('./pre-review.cjs').disconnect(this.d,p,p.bindings.reviewer.clientId);
    else if(this.d.active.has(p.id) || unfinished) throw Error('Binding has an unfinished attempt; submit or block it before detach');
    if(!p.bindings[key])throw Error('Binding not found');
    if(p.handovers?.[key])throw Error('Binding has pending handover; complete it before detach');
    this.store.change(s=>{delete s.projects[p.id].bindings[key];this.store.event(s,'desktop_detached',{projectId:p.id,binding:key});});
    return {detached:true,binding:key};
  }
  assign(identity, input) {
    this.assertBinding(identity);
    if(identity.role!=='brain')throw Error('Only brain can assign workers');
    const p=this.store.state.projects[identity.projectId],t=p.tasks[input.taskId];
    if(t?.scopeRecovery)throw Error('Scope correction must return to original worker');
    const workerId=validateWorkerId(input.workerId);
    if(input.requiredCapability!==undefined)validateWorkerId(input.requiredCapability);
    if(!t||!['ready','blocked'].includes(t.state)||this.d.active.has(p.id))throw Error('Assignment requires ready or blocked task');
    if(input.retry && (t.state!=='blocked'||t.resumePhase!=='worker'||this.d.needsRepairAuthorization(t)))throw Error('Assignment retry requires a blocked implementation task');
    if(typeof input.reason!=='string'||!input.reason.trim())throw Error('Assignment reason required');
    if(input.updatePlan && t.attempts.length)throw Error('Plan adjustment requires an unstarted task');
    this.store.change(s=>{
      const q=s.projects[p.id].tasks[t.id],previousWorkerId=q.currentWorkerId;
      q.currentWorkerId=workerId;q.workerId=workerId;
      if(input.requiredCapability!==undefined)q.requiredCapability=input.requiredCapability;
      if(input.updatePlan){q.plannedWorkerId=workerId;q.plannedRequiredCapability=q.requiredCapability??null;}
      this.store.event(s,'worker_assigned',{projectId:p.id,taskId:t.id,previousWorkerId,workerId,requiredCapability:q.requiredCapability,updatePlan:!!input.updatePlan,reason:input.reason});
    });
    if(input.retry)this.d.retry(p.id,t.id,false);
    const current=this.store.state.projects[p.id];
    return {ok:true,workerId,plannedWorkerId:current.tasks[t.id].plannedWorkerId,currentWorkerId:workerId,waitingForWorker:!matches(current,current.tasks[t.id])};
  }
  taskBudget(identity,input) {
    this.assertBinding(identity);
    if(identity.role!=='brain')throw Error('Only brain can extend task budget');
    this.d.taskBudget(identity.projectId,input.taskId,input.additionalAttempts,input.reason);
    this.d.tick();return {ok:true,maxAttempts:this.store.state.projects[identity.projectId].tasks[input.taskId].maxAttempts};
  }
  // [AI-added] 2026-09-21 09:38: Brain credentials can settle workflow control-plane blocks without borrowing the administrator token.
  retry(identity,input) {
    this.assertBinding(identity);
    if(identity.role!=='brain')throw Error('Only brain can retry tasks');
    if(typeof input.reason!=='string'||!input.reason.trim())throw Error('Retry reason required');
    this.d.retry(identity.projectId,input.taskId,input.confirmedStopped===true,input.restartWorker===true,input.reason.trim());
    this.d.tick();return {ok:true,state:this.store.state.projects[identity.projectId].tasks[input.taskId].state};
  }
  configureRepair(identity,input) {
    this.assertBinding(identity);
    if(identity.role!=='brain')throw Error('Only brain can configure repairs');
    this.d.configureRepair(identity.projectId,input.taskId,input.config);
    return {ok:true,taskId:input.taskId};
  }
  reconcileReview(identity,input) {
    this.assertBinding(identity);
    if(identity.role!=='brain')throw Error('Only brain can reconcile review candidates');
    this.d.reconcileReview(identity.projectId,input.taskId,input);
    this.d.tick();return {ok:true,state:this.store.state.projects[identity.projectId].tasks[input.taskId].state};
  }
  reviseTask(identity,input) {
    this.assertBinding(identity);
    if(identity.role!=='brain')throw Error('Only brain can revise task contracts');
    this.d.reviseTask(identity.projectId,input.taskId,input.task,input.reason);
    const task=this.store.state.projects[identity.projectId].tasks[input.taskId];
    this.d.tick();return {ok:true,taskId:task.id,contractRevision:task.contractRevision};
  }
  resolveTask(identity,input) {
    this.assertBinding(identity);
    if(identity.role!=='brain')throw Error('Only brain can resolve replaced tasks');
    const result=this.d.resolveTask(identity.projectId,input.taskId,input.replacementTaskId,input.reason,'brain');
    this.d.tick();return result;
  }
  claim(identity) {
    // [AI-added] 2026-09-22 09:20: Never redeliver a run whose receipt is awaiting durable settlement.
    if(this.d.pendingSettlements.size)return null;
    this.assertBinding(identity);
    this.d.tick();
    if(this.d.pendingSettlements.size)return null;
    const p = this.store.state.projects[identity.projectId];
    if (p.paused || p.completedAt || require('./startup.cjs').waiting(p)) return null;
    const hasAttention=identity.role==='brain'&&(require('./scope-recovery.cjs').job(p)||require('./brain-attention.cjs').job(p));
    const batchJob=hasAttention?null:require('./stage-review.cjs').claim(this,identity);if(batchJob)return batchJob;
    for (const t of Object.values(p.tasks)) {
      const r = t.attempts.at(-1);
      if (!r || r.settled || !r.delivery || r.role !== identity.role || !['running','reviewing'].includes(t.state)) continue;
      if (bindingKey(r) !== bindingKey(identity)) continue;
      if(r.scopeRecovery?.clientId && r.scopeRecovery.clientId!==identity.clientId)continue;
      if (r.claimedBy && r.claimedBy !== identity.clientId) throw Error('Attempt belongs to another client');
      if (!r.claimedBy) this.store.change(s => { const a=s.projects[p.id].tasks[t.id].attempts.at(-1);a.claimedBy = identity.clientId;a.claimedAt = new Date().toISOString(); });
      if (p.bindings?.[bindingKey(identity)]?.armed) this.store.change(s => { const b=s.projects[p.id].bindings[bindingKey(identity)];b.armed=false;delete b.armedAt; });
      const wakeHint = p.bindings?.[bindingKey(identity)]?.wake ? '\n\n此会话已启用自动唤醒：上文中提交后 wait 的要求改为调用 park。park 返回 job 就继续处理；返回 parked:true 就结束当前回合，不调用 wait 或轮询状态。' : '';
      return { projectId: p.id, goalId: t.goalId, taskId: t.id, attemptId: r.id, role: r.role, workerId: r.workerId, artifactId: r.artifactId, cwd: r.delivery.cwd, prompt: r.delivery.prompt + wakeHint };
    }
    if(identity.role==='brain'){
      const current=this.store.state.projects[p.id];
      // [AI-added] 2026-09-14 22:53
      const withParkHint=job=>current.bindings?.brain?.wake
        ? {...job,prompt:job.prompt+'\n\n自动唤醒后续步骤：实际调用终端工具执行本待办要求的 '+(job.kind==='planning'?(current.goals?'stage-register（提交完整计划）、finish-goal（完成当前目标）或 closeout（记录具体阻塞）':'stage-register（提交完整计划）或 closeout（记录具体阻塞）'):'closeout 或 scope-ack')+'，成功后必须使用本会话已有客户端、credential 和 data 路径实际执行 park。不得只展示命令。park 返回 job 时继续处理；返回 parked:true 时结束当前回合，不调用 wait 或轮询。返回 completed:true 时结束回合。若操作失败或缺少权限，说明具体阻塞，不声称已挂起。'}
        : job;
      const scope=require('./scope-recovery.cjs').job(current);
      // Previous implementation: if(scope)return scope;
      // [AI-added] 2026-09-14 22:53
      if(scope){require('./brain-activities.cjs').autoStart(this,identity,'troubleshooting','scope:'+scope.alertId);return withParkHint(scope);}
      // [AI-added] 2026-09-19: Attention bypasses the in-flight gate; a task that is itself
      // uncertain would otherwise make its own attention permanently unclaimable.
      const attention=require('./brain-attention.cjs').job(current);
      if(attention){require('./brain-activities.cjs').autoStart(this,identity,'troubleshooting','attention:'+attention.alertId);return withParkHint(attention);}
      if(Object.values(current.tasks).some(t=>['running','reviewing','uncertain'].includes(t.state)))return null;
      const planning=require('./planning.cjs').job(current);
      if(planning){
        require('./brain-activities.cjs').autoStart(this,identity,'planning','planning:'+planning.planningId);
        if(current.bindings.brain.armed)this.store.change(s=>{const b=s.projects[p.id].bindings.brain;b.armed=false;delete b.armedAt;});
        // Previous implementation: return planning;
        // [AI-added] 2026-09-14 22:53
        return withParkHint(planning);
      }
    }
    return null;
  }
  completion(identity) {
    this.assertBinding(identity);
    const p=this.store.state.projects[identity.projectId];
    return p.completedAt ? {completed:true,projectId:p.id,completedAt:p.completedAt,message:'项目已结束，全部已登记任务已通过或由已通过的替代任务解决。结束当前回合，不再调用 wait/park；新增工作由管理员 reopen-project 后再接入。'} : null;
  }
  status(identity) {
    this.assertBinding(identity);
    const p = this.store.state.projects[identity.projectId];
    return { projectId: p.id, workspace: p.workspace, role: identity.role, workerId:identity.workerId, paused: !!p.paused,
      completed: !!p.completedAt, turns: p.turns, projectAttempts:p.turns, maxTurns: p.maxTurns, projectBudgetEnabled:p.projectBudgetEnabled, budgetExhausted: attempts.projectExhausted(p),
      wakeEnabled: !!p.bindings?.[bindingKey(identity)]?.wake,
      dispatch:require('./maintenance.cjs').dispatchStatus(this.d),
      storageRecovery:this.d.settlementStatus(p.id),
      usage:require('./usage.cjs').summary(this.store.state,p.id),
      reviewStages:require('./stage-review.cjs').summary(p),
      handoverPending:!!p.handovers?.[bindingKey(identity)],
      staffing:p.staffing||null, executionMode:'serial-shared-workspace',
      ...(p.webSetup ? { brief: require('./goals.cjs').brief(p), peerSetupManagedBy: 'web', ...require('./goals.cjs').summary(p) } : {}),
      planning:p.planning || null,
      startup:require('./startup.cjs').status(p),
      workers:Object.entries(p.bindings||{}).filter(([k])=>!['brain','reviewer'].includes(k)).map(([key,b])=>({workerId:key==='worker'?'default':key.slice(7),sessionId:b.sessionId,capabilities:b.capabilities||[]})),
      reviewerOnline:require('./pre-review.cjs').online(this.d,p),
      connections:Object.entries(p.bindings||{}).map(([key,b])=>({binding:key,sessionId:b.sessionId,wakeEnabled:!!b.wake,provider:b.wake?.provider||b.provider||b.continuation?.provider||null,continuationError:b.continuationError||null,armed:!!b.armed,armedAt:b.armedAt||null,wakeState:b.armed?'standby_authorized':b.wake?'not_parked':'unconfigured'})),
      boundRoles: Object.keys(p.bindings || {}),
      tasks: Object.values(p.tasks).map(t => ({ id: t.id, goalId: t.goalId, title: t.title, state: t.state, dependsOn: t.dependsOn || [], supersedes:t.supersedes||[],resolution:t.resolution||null,contractRevision:t.contractRevision||1,stageId:t.stageId,roundId:t.roundId,stageHeld:!!t.stageHeld,
        error: t.error || null, scopeReturns:t.scopeReturns||0,scopeRecoveryRequested:!!t.scopeRecoveryRequested,scopeRecoveryPaths:t.scopeRecovery?.targets.map(x=>x.path),scopeAlert:t.scopeAlert||null, attention:t.attention||null, workerId:t.workerId||'default',plannedWorkerId:t.plannedWorkerId,currentWorkerId:t.currentWorkerId,plannedRequiredCapability:t.plannedRequiredCapability,attemptCounts:attempts.counts(t),maxAttempts:t.maxAttempts,budgetExhausted:attempts.exhausted(t),requiredCapability:t.requiredCapability,waitingForWorker:t.state==='ready'&&!matches(p,t) })) };
  }
  finishProject(identity) {
    this.assertBinding(identity);
    if (identity.role !== 'brain') throw Error('Only brain can finish a desktop project');
    const planningId=this.store.state.projects[identity.projectId].planning?.id;
    this.d.finishProject(identity.projectId);
    if(planningId)require('./brain-activities.cjs').autoEnd(this,identity,'planning:'+planningId);
    return this.completion(identity);
  }
  finishGoal(identity, input) { return require('./goals.cjs').finish(this, identity, input); }
  nextStep(identity, task) {
    const p=this.store.state.projects[identity.projectId];
    // [AI-added] 2026-09-22 09:20: A saved receipt is not yet an accepted settlement.
    if(this.d.pendingSettlements.size)return {nextAction:'attention',nextInstruction:'回执结算遇到存储错误，服务已暂停派发并有界恢复；查看 status.storageRecovery，不要重新执行任务或创建新 attempt。'};
    if(p.completedAt)return {completed:true,nextAction:'stop',nextInstruction:'整个项目已结束，结束回合，不再 wait/park。'};
    if(p.paused || ['blocked','uncertain'].includes(task?.state) || (['ready','review_ready'].includes(task?.state) && attempts.exhausted(task)))return {nextAction:'attention',nextInstruction:'项目暂停、任务阻塞或尝试额度耗尽。报告实际原因，不声称已完成，不循环重试。'};
    if(identity.role==='brain' && p.planning?.state==='pending')return {nextAction:'claim',nextInstruction:p.goals?'实际调用 claim 领取当前目标的规划或收尾；达到验收要求后 finish-goal --goal <当前目标 ID> --summary <验收摘要>，不要结束整个项目。':'实际调用 claim 领取阶段收尾待办并处理；全部任务已通过则按已有授权调用管理端结束项目，不能虚构下一任务。'};
    if(p.bindings?.[bindingKey(identity)]?.wake)return {nextAction:'park',nextInstruction:'实际调用 park。返回 job 继续处理；只有 parked:true 或 completed:true 才结束回合。不要 wait，不把 submit 成功当作已挂起。'};
    return {nextAction:'wait',nextInstruction:'本端未启用唤醒。持续协作期间提交后实际调用 wait --seconds 60，宿主超时至少留出额外 30 秒；有进程会话 ID 就续等同一进程。idle:true 不是完成，按授权续等；completed:true 才结束。不能只说等待后直接结束，也不能重复启动 wait。'};
  }
  // [AI-added] 2026-09-22 09:20: Advisory read only; submission always validates the current tree again.
  preflight(identity,{taskId,attemptId}){
    const p=this.store.state.projects[identity.projectId],t=p?.tasks[taskId],r=t?.attempts.at(-1);
    if(p?.archivedAt||p?.bindings?.[bindingKey(identity)]?.clientId!==identity.clientId||!r||r.id!==attemptId||r.settled||r.role!==identity.role||bindingKey(r)!==bindingKey(identity)||r.claimedBy!==identity.clientId)throw Error('Preflight identity or active attempt mismatch');
    const before=r.role==='worker'?loadSnapshot(this.d.artifacts,r.baselineId).files:r.delivery.reviewManifest;
    const after=manifest(r.role==='worker'?p.workspace:r.delivery.cwd,r.role==='worker'?r.snapshotPolicy:r.reviewPolicy);
    const changed=changes(before,after).filter(c=>!ignored(c.path,r.role==='worker'?r.snapshotPolicy:r.reviewPolicy));
    const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
    const outside=r.role==='worker'?changed.filter(c=>{
      const target=r.scopeRecovery?.targets.find(x=>x.path===c.path);
      if(target&&same(after[c.path],target.expected))return false;
      return !(r.scopePolicy==='separated-v1'?require('./scope-recovery.cjs').writable(c.path,t.allowedPaths,t.id):allowed(c.path,t.allowedPaths));
    }):changed;
    const unresolved=(r.scopeRecovery?.targets||[]).filter(x=>!ignored(x.path,r.snapshotPolicy)&&!same(after[x.path],x.expected)).map(x=>x.path);
    const reserved=reservedNames(after);
    return {ok:!outside.length&&!unresolved.length&&!reserved.length,taskId,attemptId,advisory:true,changes:changed.slice(0,100),outOfScope:outside.slice(0,100),unresolvedRecovery:unresolved.slice(0,100),reservedNames:reserved.slice(0,100),counts:{changes:changed.length,outOfScope:outside.length,unresolvedRecovery:unresolved.length,reservedNames:reserved.length},truncated:[changed,outside,unresolved,reserved].some(a=>a.length>100)};
  }
  submit(identity, { taskId, attemptId, result, usage }) {
    if(identity.role==='brain')throw Error('Use stage-submit for whole-stage final acceptance');
    const p = this.store.state.projects[identity.projectId], t = p.tasks[taskId];
    const r = t?.attempts.find(a => a.id === attemptId);
    if (!r || r.role !== identity.role || bindingKey(r)!==bindingKey(identity) || r.claimedBy !== identity.clientId) throw Error('Submission identity mismatch');
    const text = JSON.stringify(result), hash = sha(text);
    if (r.settled) {
      if (r.submissionHash === hash) {
        if (usage && JSON.stringify(require('./usage.cjs').normalize(usage)) !== JSON.stringify(r.usage)) throw Error('Conflicting duplicate usage');
        return { ok: true, duplicate: true, state: t.state, ...this.nextStep(identity,t) };
      }
      throw Error('Attempt already settled or conflicting duplicate');
    }
    if (r !== t.attempts.at(-1)) throw Error('Stale attempt');
    parseResult(text, { ...identity, taskId, attemptId, artifactId: r.artifactId });
    // [AI-added] 2026-09-22 09:20: A retry reuses the original receipt and original candidate.
    const receiptFile=this.d.receiptPath(r.id),normalizedUsage=require('./usage.cjs').normalize(usage);
    let receipt;
    if(fs.existsSync(receiptFile)){
      receipt=read(receiptFile);
      if(receipt.text!==text||JSON.stringify(receipt.usage??null)!==JSON.stringify(normalizedUsage))throw Error('Conflicting durable receipt');
    }else{
      receipt={attemptId,role:r.role,text,usage:normalizedUsage};
      if(r.role==='worker')receipt.artifactId=this.d.createSnapshot(p.workspace,r.snapshotPolicy).id;
      else {receipt.reviewChanges=changes(r.delivery.reviewManifest,manifest(r.delivery.cwd,r.reviewPolicy));receipt.reviewChanged=receipt.reviewChanges.length>0;}
      atomic(receiptFile,receipt);
    }
    if(!this.d.pendingSettlements.has(r.id))this.d.settle(p.id,t.id,r.id,receipt);
    this.d.tick();
    const current=this.store.state.projects[p.id].tasks[t.id];
    return { ok: !this.d.pendingSettlements.has(r.id),receiptPersisted:true,settlementPending:this.d.pendingSettlements.has(r.id),state: current.state, ...this.nextStep(identity,current) };
  }
  plan(identity, task) {
    if (identity.role !== 'brain') throw Error('Only brain can create tasks');
    this.assertBinding(identity);
    require('./startup.cjs').assertStarted(this.store.state.projects[identity.projectId]);
    const old = this.store.state.projects[identity.projectId].tasks[task.id];
    if (old) {
      const p = this.store.state.projects[identity.projectId];
      if (p.goals && old.goalId !== require('./goals.cjs').taskGoal(p, task.goalId)) throw Error('任务编号已用于其他目标，请使用当前目标前缀的新编号');
      for (const k of ['title','instructions','acceptance','allowedPaths']) if (JSON.stringify(old[k]) !== JSON.stringify(task[k])) throw Error('Conflicting task id');
      if (JSON.stringify(old.dependsOn) !== JSON.stringify(task.dependsOn || [])) throw Error('Conflicting dependencies');
      if (JSON.stringify(old.supersedes||[]) !== JSON.stringify(task.supersedes||[]) || (old.supersedeReason||null)!==(task.supersedeReason||null)) throw Error('Conflicting replacement relationship');
      if (old.plannedWorkerId !== (task.workerId||'default') || old.plannedRequiredCapability !== (task.requiredCapability??null)) throw Error('Conflicting worker assignment');
      if (old.validationProfile !== task.validationProfile) throw Error('Conflicting validation profile');
      return { ok: true, duplicate: true };
    }
    const staffing=this.store.state.projects[identity.projectId].staffing;
    if(staffing) {
      const selected=staffing.workers.find(w=>w.workerId===(task.workerId||'default'));
      if(!selected || task.requiredCapability!==selected.capability)throw Error('Task must name an assessed workerId and its requiredCapability');
    }
    this.d.addTask(identity.projectId, task); this.d.tick(); return { ok: true, queued:true, dispatch:require('./maintenance.cjs').dispatchStatus(this.d), message:'任务已登记到草案；由大脑 stage-register 提交完整阶段计划后才会派发。' };
  }
  closeout(identity,input) { return require('./planning.cjs').closeout(this,identity,input); }
  staff(identity,input) {
    this.assertBinding(identity);
    if(identity.role!=='brain')throw Error('Only brain can assess staffing');
    const p = this.store.state.projects[identity.projectId];
    if (p.goals) return require('./project-setup.cjs').configureTeam(this, p.id, input.staffing?.workers);
    const staffing=require('./bindings.cjs').staffing(input.staffing);
    this.store.change(s=>{s.projects[identity.projectId].staffing=staffing;this.store.event(s,'staffing_assessed',{projectId:identity.projectId,...staffing});});
    return {ok:true,staffing};
  }
  progress(identity, v) {
    const r = this.store.state.projects[identity.projectId]?.tasks[v.taskId]?.attempts.at(-1);
    if (!r || r.id !== v.attemptId || r.role !== identity.role || r.claimedBy !== identity.clientId || r.settled) throw Error('Progress requires current claimed attempt');
    if (!Number.isSafeInteger(v.sequence) || v.sequence < 1 || !['reading','implementing','testing','preparing-report','blocked'].includes(v.stage) || typeof v.summary !== 'string' || !v.summary.trim() || v.summary.length > 1000) throw Error('Invalid progress');
    if (r.progress && v.sequence <= r.progress.sequence) {
      if (v.sequence === r.progress.sequence && v.stage === r.progress.stage && v.summary === r.progress.summary) return {ok:true,duplicate:true};
      throw Error('Stale/conflicting progress sequence');
    }
    this.store.change(s => { s.projects[identity.projectId].tasks[v.taskId].attempts.at(-1).progress = { sequence:v.sequence, stage:v.stage, summary:v.summary, at:new Date().toISOString() }; });
    return {ok:true};
  }
}
module.exports = { Desktop };
