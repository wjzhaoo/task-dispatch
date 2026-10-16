'use strict';
const {bindingKey}=require('./bindings.cjs');

const path=require('node:path');
const {assertRoleProvider}=require('./platforms.cjs');
// [AI-added] 2026-09-17 20:21: Isolate the wake runner from hung host API calls.
const hostCall=require('./host-call.cjs');
// [AI-added] 2026-09-14 22:06
const PLANNING_CLAIM_GRACE_MS=60_000;
// [AI-added] 2026-09-17 18:43: Bound automatic task reminders without equating delivery with claim.
const TASK_CLAIM_GRACE_MS=60_000;
// [AI-added] 2026-09-21 23:41: A completed host repair makes the interrupted send safely
// retryable on the next marker-reconciliation tick; an unperformed repair does not.
function repairMessage(error,repair){return error.message+(repair?.note?'; '+repair.note:'');}
function sendFailure(error,repair){return {status:(error.safeToRetry||repair?.attempted)?'pending':'uncertain',error:repairMessage(error,repair)};}
class Wake {
  constructor(desktop,adapter) { this.desktop=desktop;this.store=desktop.store;this.adapter=adapter;this.busy=null;this.stopped=false;this.next=0;this.readTimeoutMs=15000;this.sendTimeoutMs=30000; }
  forProvider(provider='codex') {
    if (this.adapter.forProvider) return this.adapter.forProvider(provider);
    if (provider !== 'codex') throw Error('Wake provider not connected: '+provider);
    return this.adapter;
  }
  send(adapter,binding,message,timeoutMs=this.sendTimeoutMs) {
    if(binding.provider!=='opencode')return hostCall.send(adapter,binding,message,timeoutMs);
    // OpenCode performs another async database read before spawning the CLI.
    // Recheck the authorization and pending notice after that read as well.
    const expected=JSON.stringify(binding);
    const canSend=()=>{
      if(this.stopped)return false;
      const p=Object.values(this.store.state.projects).find(p=>p.workspace===binding.workspace);
      if(!p||p.paused||p.completedAt)return false;
      if(!Object.values(p.bindings||{}).some(b=>b.armed&&JSON.stringify(b.wake)===expected))return false;
      const starts=marker=>marker&&message.startsWith(`[${marker}]`);
      if(message.startsWith('[TASK-DISPATCH-WAKE:'))return Object.values(p.tasks||{}).some(t=>{
        const r=t.attempts?.at(-1);
        return r&&!r.settled&&!r.claimedBy&&r.delivery&&JSON.stringify(p.bindings?.[bindingKey(r)]?.wake)===expected&&['TASK-DISPATCH-WAKE:'+r.id,r.wakeNotice?.reminder?.marker,r.wakeNotice?.manualReminder?.marker].some(starts);
      });
      if(message.startsWith('[TASK-DISPATCH-PLANNING:'))return p.planning?.state==='pending'&&!p.planning.needsAttention&&starts('TASK-DISPATCH-PLANNING:'+p.planning.id);
      if(message.startsWith('[TASK-DISPATCH-SCOPE:')){const job=require('./scope-recovery.cjs').job(p);return !!job&&starts('TASK-DISPATCH-SCOPE:'+p.tasks[job.taskId].scopeAlert.id);}
      if(message.startsWith('[TASK-DISPATCH-ATTENTION:')){const job=require('./brain-attention.cjs').job(p);return !!job&&starts('TASK-DISPATCH-ATTENTION:'+p.tasks[job.taskId].attention.id);}
      if(message.startsWith('[TASK-DISPATCH-BATCH:')){const job=require('./stage-review.cjs').job(p);return !!job&&starts('TASK-DISPATCH-BATCH:'+(job.attemptId||job.alertId))&&!(job.kind==='stage_review'&&p.reviewStages[job.roundId].attempt?.claimedBy);}
      return false;
    };
    return hostCall.send(adapter,{...binding,canSend},message,timeoutMs);
  }
  // [AI-added] 2026-09-24 13:26: Verified host data may be reused by the continuation path only.
  async bind(identity,input,verifiedInfo) {
    this.desktop.assertBinding(identity);
    const p=this.store.state.projects[identity.projectId], b=p.bindings[bindingKey(identity)];
    if (input.enabled === false) { this.store.change(s=>{const q=s.projects[p.id].bindings[bindingKey(identity)];q.wake=null;q.armed=false;delete q.armedAt;});return {ok:true}; }
    if (input.experimentalAcknowledged!==true) throw Error('Private Desktop protocol requires explicit acknowledgement');
    // [AI-added] 2026-09-15 18:56
    // [AI-added] 2026-09-14 09:43
/* Previous implementation:
const provider=input.provider || 'codex', adapter=this.forProvider(provider);
*/
/* Previous implementation:
const provider=input.provider === 'codeartsdoer' ? 'codearts' : input.provider || 'codex', adapter=this.forProvider(provider);
*/
if(!input.provider)throw Error('wake-bind requires explicit provider');
const provider=assertRoleProvider(identity.role,input.provider), adapter=this.forProvider(provider);
    for (const k of provider==='codex'?['threadId','turnId']:['threadId']) if(typeof input[k]!=='string'||!input[k].trim())throw Error(k+' required');
    if(b.sessionId && b.sessionId!==input.threadId)throw Error('Wake thread differs from connected session');
    if(b.wake&&((b.wake.provider||'codex')!==provider||b.wake.threadId!==input.threadId||b.wake.turnId!==input.turnId))throw Error('Disable old wake binding before replacing it');
    for(const project of Object.values(this.store.state.projects))for(const [role,binding]of Object.entries(project.bindings||{}))if((binding.wake?.provider||'codex')===provider&&binding.wake?.threadId===input.threadId&&(project.id!==p.id||role!==bindingKey(identity)))throw Error('Desktop thread already bound to another project/role');
    if (provider === 'mimo' && (typeof input.model !== 'string' || !/^[^\s/]+\/[^\s]+$/.test(input.model))) throw Error('MiMo requires explicit provider/model');
    if (provider === 'codearts' && input.model !== undefined && (typeof input.model !== 'string' || !/^[^\s/]+\/\S+$/.test(input.model))) throw Error('CodeArts model must be provider/model; omit it to preserve the session model');
    // [AI-added] 2026-09-15 18:56
    if (provider === 'qoder' && input.model !== undefined && (typeof input.model !== 'string' || !/^[^\s/]+\/\S+$/.test(input.model))) throw Error('Qoder model must be provider/model; omit it to preserve the session model');
    if (provider === 'opencode' && input.model !== undefined && (typeof input.model !== 'string' || !/^[^\s/]+\/\S+$/.test(input.model))) throw Error('OpenCode model must be provider/model; omit it to preserve the session model');
    if (b.wake?.model && b.wake.model !== input.model) throw Error('Disable old wake binding before replacing model');
    const candidate={provider,threadId:input.threadId,...(input.turnId?{turnId:input.turnId}:{}),...(input.model?{model:input.model}:{}),...(['qoder','opencode'].includes(provider)?{workspace:p.workspace}:{})};
    // Previous implementation: const r=await hostCall.read(adapter,candidate,this.readTimeoutMs);
    // [AI-added] 2026-09-24 13:26: Direct wake-bind still performs its own host read.
    const r=verifiedInfo || await (provider==='opencode' ? hostCall.bounded('Host verify',()=>adapter.verify(candidate),this.readTimeoutMs) : hostCall.read(adapter,candidate,this.readTimeoutMs));
    if(r.thread?.id!==candidate.threadId||!r.thread.cwd||path.relative(p.workspace,r.thread.cwd)!=='')throw Error('Desktop thread workspace does not match project');
    this.desktop.assertBinding(identity);
    this.store.change(s=>{const q=s.projects[p.id].bindings[bindingKey(identity)];q.wake=candidate;q.armed=false;delete q.armedAt;});
    return {ok:true,message:'Bound. Use park after work; do not keep a wait process running.'};
  }
  park(identity) {
    const completed=this.desktop.completion(identity);if(completed)return completed;
    const b=this.store.state.projects[identity.projectId].bindings[bindingKey(identity)];
    if(!b.wake)throw Error('Wake is not configured');
    const job=this.desktop.claim(identity);
    if(job){
      if(job.kind==='planning')this.store.change(s=>{
        const q=s.projects[identity.projectId].planning;
        q.parkAttempts=(q.parkAttempts||0)+1;
        if(q.parkAttempts>=2&&!q.needsAttention){q.needsAttention=true;this.store.event(s,'planning_stalled',{projectId:identity.projectId,planningId:q.id});}
      });
      return {job,...(job.kind==='planning'?{parked:false,needsAttention:!!this.store.state.projects[identity.projectId].planning.needsAttention}:{})};
    }
    this.store.change(s=>{const q=s.projects[identity.projectId].bindings[bindingKey(identity)];q.armed=true;q.armedAt=new Date().toISOString();});
    return {parked:true,planningBlock:this.store.state.projects[identity.projectId].planning?.resolution||null,message:'End this model turn. The service will notify this thread when work arrives. Do not poll or call wait.'};
  }
  tick() {
    if(this.stopped||this.busy||Date.now()<this.next)return;
    this.busy=this.run().catch(e=>{this.error=e.message;}).finally(()=>{this.next=Date.now()+3000;this.busy=null;});
  }
  // [AI-added] 2026-09-20: A restartable host failure (Qoder bridge not loaded, MiMo Desktop
  // closed) triggers the adapter's own rate-limited repair, which starts/restarts the app so the
  // plugin/re-discovery happens on startup. Returns structured retry evidence plus human-readable
  // operator text (also recorded as a wake_repair event); returns null when nothing applies.
  // The pending wake retries itself on the next tick.
  async repair(adapter, error, context) {
    if (!adapter?.repairBridge || !(error.restartable || error.repairAction)) return null;
    let result;
    try { result = await adapter.repairBridge(error); } catch { return {attempted:false,note:'宿主应用自动修复失败，请手动重启宿主应用'}; }
    if (!result) return null;
    this.store.change(s => this.store.event(s, 'wake_repair', { ...context, action: error.repairAction || (result.action === 'restart' ? 'restart' : 'launch'), attempted: !!result.attempted, outcome: result.action || result.reason, exe: result.exe || null, killed: result.killed ?? null }));
    if (result.attempted) return {attempted:true,note:`服务已自动${result.action === 'restart' ? '重启' : '启动'}宿主应用（${result.exe}），等待唤醒自动重试`};
    if (result.reason === 'rate-limited') return null;
    if (result.reason === 'session-active') return {attempted:false,note:'宿主应用无响应，但存在进行中的会话，服务不会强杀；请手动重启宿主应用'};
    if (result.reason === 'status-unknown') return {attempted:false,note:'宿主应用无响应且状态未知，服务不会强杀；请手动重启宿主应用'};
    return {attempted:false,note:`宿主应用自动修复未执行（${result.reason}${result.error ? '：' + result.error : ''}），需人工处理`};
  }
  async run() {
    for(const p of Object.values(this.store.state.projects)) {
      if(p.paused||p.completedAt||p.mode!=='desktop')continue;
      const reviewer=p.bindings?.reviewer;
      if(reviewer?.wake) {
        try {
          const info=await hostCall.read(this.forProvider(reviewer.wake.provider||'codex'),reviewer.wake,this.readTimeoutMs);
          if(info.thread?.id===reviewer.wake.threadId && info.thread.cwd && path.relative(p.workspace,info.thread.cwd)==='' &&
              (['idle','active','busy','running'].includes(info.thread?.status?.type) || info.thread.reachable===true)) {
            if(this.store.state.projects[p.id].bindings?.reviewer?.clientId===reviewer.clientId)
              require('./pre-review.cjs').touch(this.desktop.d,{projectId:p.id,role:'reviewer',clientId:reviewer.clientId});
          }
        } catch { /* A stale wake binding is not proof of presence. */ }
      }
      if(require('./startup.cjs').waiting(p))continue;
      require('./planning.cjs').reconcile(this.store,p.id);
      if(require('./stage-review.cjs').job(this.store.state.projects[p.id]))await this.batchNotice(p.id);
      else if(require('./scope-recovery.cjs').job(this.store.state.projects[p.id]))await this.scopeNotice(p.id);
      else if(require('./brain-attention.cjs').job(this.store.state.projects[p.id]))await this.attentionNotice(p.id);
      else await this.planningNotice(p.id);
      for(const t of Object.values(p.tasks)) {
        const r=t.attempts.at(-1),b=r&&p.bindings?.[bindingKey(r)];
        if(!r||r.settled||!r.delivery||!b?.wake||!b.armed||r.claimedBy)continue;
        const update=value=>{
          const old=this.store.state.projects[p.id].tasks[t.id].attempts.find(a=>a.id===r.id)?.wakeNotice;
          if(JSON.stringify(old)===JSON.stringify({...old,...value}))return;
          this.store.change(s=>{const run=s.projects[p.id].tasks[t.id].attempts.find(a=>a.id===r.id);run.wakeNotice={...run.wakeNotice,...value};});
        };
        // [AI-added] 2026-09-17 18:43: Reconcile one automatic reminder and explicit operator reminders separately.
        const notice=r.wakeNotice||{},elapsed=at=>Date.now()-Date.parse(at||'') >= TASK_CLAIM_GRACE_MS;
        let followup=notice.manualReminder||notice.reminder;
        if(notice.status==='sent'&&!followup&&elapsed(notice.at)){
          followup={kind:'automatic',count:1,status:'pending',marker:`TASK-DISPATCH-WAKE:${r.id}:REMINDER:1`,requestedAt:new Date().toISOString()};
          update({claimStatus:'reminder_pending',reminder:followup});
        }
        // [AI-added] 2026-09-19: Anchor the reminder grace on the first attempt. Moving the anchor on
        // every resend kept elapsed() permanently false, so the attempt never escalated to stalled.
        const anchor=followup&&(followup.at||followup.lastAttemptAt||followup.requestedAt);
        if(notice.status==='sent'&&['sent','uncertain'].includes(followup?.status)&&elapsed(anchor)){
          // [AI-added] 2026-09-19: Separate "delivered but unclaimed" from "accepted but never landed".
          update(followup.status==='uncertain'
            ? {claimStatus:'stalled',error:'The reminder was accepted by the target host but never appeared in its session history; the host most likely refused the invocation. Restart the target app, then retry the task.'}
            : {claimStatus:'stalled',error:'Wake delivered but the task remains unclaimed after the reminder grace period.'});
          continue;
        }
        if(notice.status==='sent'&&!followup)continue;
        let info, adapter;
        try { adapter=this.forProvider(b.wake.provider||'codex'); info=await hostCall.read(adapter,b.wake,this.readTimeoutMs); }
        // [AI-added] 2026-09-20: restartable host failures get one rate-limited auto-repair
        // (start/restart the app) and the outcome rides along in the visible error.
        catch(e){const repair=await this.repair(adapter,e,{projectId:p.id,taskId:t.id});update({error:repairMessage(e,repair)});continue;}
        if(notice.status==='sent'&&followup){
          const found=(info.turns||[]).some(turn=>(turn.items||[]).some(item=>item.type==='userMessage'&&(item.content||[]).some(c=>typeof c.text==='string'&&c.text.includes(followup.marker))));
          const key=followup.kind==='manual'?'manualReminder':'reminder';
          const setFollowup=value=>update({[key]:{...followup,...value}});
          if(found){setFollowup({status:'sent',at:followup.at||new Date().toISOString(),error:null});update({claimStatus:'reminded',error:null});continue;}
          if(['sending','uncertain'].includes(followup.status)){setFollowup({status:'uncertain',error:followup.error||'Reminder delivery uncertain; check the target conversation before requesting another reminder.'});continue;}
          // [AI-added] 2026-09-19: A verified send is final. Only an explicitly retryable attempt is
          // resent, so a silently refused wake can no longer loop forever and hide the escalation.
          if(followup.status!=='pending')continue;
          if(info.thread?.status?.type!=='idle'&&!((b.wake.provider==='mimo')&&info.thread?.status?.type==='unknown'))continue;
          const current=this.store.state.projects[p.id],run=current.tasks[t.id].attempts.at(-1),binding=current.bindings[bindingKey(r)];
          if(this.stopped||current.paused||run.id!==r.id||run.settled||run.claimedBy||!binding?.armed||JSON.stringify(binding.wake)!==JSON.stringify(b.wake))continue;
          const attemptedAt=new Date().toISOString();
          setFollowup({status:'sending',lastAttemptAt:attemptedAt,attempts:(followup.attempts||1)+1,error:null});
          try{
            await this.send(adapter,b.wake,`[${followup.marker}] task-dispatch 的任务 ${t.id} 已通知但仍未领取。请立即使用本会话已有凭据执行 desktop-client claim，核对 attemptId 后继续处理并 submit；之后 park。不要只回复文字或重复启动 wait。`,this.sendTimeoutMs);
            // The grace anchor stays on the first accepted send; resends never move it.
            setFollowup({status:'sent',at:followup.at||attemptedAt,lastAttemptAt:attemptedAt,error:null});update({claimStatus:'reminded',error:null});
          }catch(e){const repair=await this.repair(adapter,e,{projectId:p.id,taskId:t.id,reminder:true});setFollowup(sendFailure(e,repair));}
          continue;
        }
        const marker='TASK-DISPATCH-WAKE:'+r.id;
        const found=(info.turns||[]).some(turn=>(turn.items||[]).some(item=>item.type==='userMessage'&&(item.content||[]).some(c=>typeof c.text==='string'&&c.text.includes(marker))));
        if (found) { update({status:'sent',marker,error:null}); continue; }
        if(['sending','uncertain'].includes(r.wakeNotice?.status)) {
          update(found?{status:'sent',error:null}:{status:'uncertain',error:'Delivery uncertain; no automatic resend. Check target conversation; manually claim/park if needed.'});continue;
        }
        // MiMo may not emit an initial SSE state. A parked binding authorizes sending;
        // its HTTP busy rejection is definitive and safe to retry. Never infer idle.
        if(info.thread?.status?.type!=='idle' && !((b.wake.provider==='mimo') && info.thread?.status?.type==='unknown'))continue;
        // Recheck after asynchronous IO: a client may have claimed/disabled/paused meanwhile.
        const current=this.store.state.projects[p.id],run=current.tasks[t.id].attempts.at(-1),binding=current.bindings[bindingKey(r)];
        if(this.stopped||current.paused||run.id!==r.id||run.settled||run.claimedBy||!binding?.armed||JSON.stringify(binding.wake)!==JSON.stringify(b.wake))continue;
        update({status:'sending',marker,at:new Date().toISOString(),error:null});
        try {
          // [AI-added] 2026-09-14 22:59
          if((b.wake.provider||'codex')==='codex')await this.send(adapter,b.wake,`[${marker}] task-dispatch 有待处理任务。项目 ${p.id}，任务 ${t.id}，角色 ${r.role}。请用本会话已有凭据执行 desktop-client claim 领取正式任务，处理并 submit；之后 park，无任务时结束回合。不要轮询、调用 wait 或直接读取 state.json。通知不等于任务已领取，先核对 claim 返回的 attemptId。`,this.sendTimeoutMs);
          else
          // [AI-added] 2026-09-14 22:06
          await this.send(adapter,b.wake,`[${marker}] task-dispatch 有待处理任务。项目 ${p.id}，任务 ${t.id}，角色 ${r.role}。必须立即调用终端/命令工具，原样复用本会话已有的客户端、credential 和 data 路径，实际执行 desktop-client claim 领取正式任务；不得只展示、复述或建议命令，不得凭记忆重写路径。若宿主无法调用终端，明确报告阻塞。处理并 submit；之后 park，无任务时结束回合。不要轮询、调用 wait 或直接读取 state.json。通知不等于任务已领取，先核对 claim 返回的 attemptId。`,this.sendTimeoutMs);
          update({status:'sent',error:null});
        } catch(e){const repair=await this.repair(adapter,e,{projectId:p.id,taskId:t.id});update(sendFailure(e,repair));}
      }
    }
  }
  async planningNotice(projectId) {
    const p=this.store.state.projects[projectId],q=p.planning,b=p.bindings?.brain;
    if(!q||q.state!=='pending'||!b?.wake||!b.armed||q.needsAttention||Object.values(p.tasks).some(t=>['running','reviewing','uncertain'].includes(t.state)))return;
    const marker='TASK-DISPATCH-PLANNING:'+q.id;
    const update=value=>this.store.change(s=>{const v=s.projects[projectId].planning;if(v?.id===q.id)v.wakeNotice={...v.wakeNotice,...value};});
    // [AI-added] 2026-09-14 22:06
    if(q.wakeNotice?.status==='sent'){
      // [AI-added] 2026-09-14 22:59
      if((b.wake.provider||'codex')==='codex')return;
      const sentAt=Date.parse(q.wakeNotice.at);
      if(!Number.isFinite(sentAt)||Date.now()-sentAt<PLANNING_CLAIM_GRACE_MS)return;
      let info;
      try{info=await hostCall.read(this.forProvider(b.wake.provider||'codex'),b.wake,this.readTimeoutMs);}catch(e){update({error:e.message});return;}
      if(info.thread?.status?.type!=='idle')return;
      this.store.change(s=>{
        const current=s.projects[projectId],planning=current?.planning,binding=current?.bindings?.brain;
        if(planning?.id!==q.id||planning.state!=='pending'||planning.needsAttention||planning.wakeNotice?.status!=='sent'||!binding?.armed)return;
        planning.needsAttention=true;
        planning.wakeNotice.error='Planning wake was delivered but remained unclaimed after the grace period.';
        this.store.event(s,'planning_stalled',{projectId,planningId:planning.id});
      });
      return;
    }
    let adapter,info;
    try{adapter=this.forProvider(b.wake.provider||'codex');info=await hostCall.read(adapter,b.wake,this.readTimeoutMs);}catch(e){const repair=await this.repair(adapter,e,{projectId});update({error:repairMessage(e,repair)});return;}
    const found=(info.turns||[]).some(t=>(t.items||[]).some(i=>i.type==='userMessage'&&(i.content||[]).some(c=>c.text?.includes(marker))));
    if(found){update({status:'sent',marker,error:null});return;}
    if(['sending','uncertain'].includes(q.wakeNotice?.status)){update({status:'uncertain',error:'阶段收尾通知送达不确定，请人工检查；不自动重发。'});return;}
    if(info.thread?.status?.type!=='idle'&&!((b.wake.provider==='mimo')&&info.thread?.status?.type==='unknown'))return;
    const current=this.store.state.projects[projectId];
    if(this.stopped||current.paused||current.completedAt||current.planning?.id!==q.id||current.planning.state!=='pending'||!current.bindings?.brain?.armed||JSON.stringify(current.bindings.brain.wake)!==JSON.stringify(b.wake)||Object.values(current.tasks).some(t=>['running','reviewing','uncertain'].includes(t.state)))return;
    update({status:'sending',marker,at:new Date().toISOString()});
    try{
      const obligation=q.kind==='initial'?'用户已在 Web 管理端确认开始，现有初始规划待办':'验收后尚有阶段收尾待办';
      if (p.goals) {
        await this.send(adapter,b.wake,`[${marker}] 项目 ${projectId} ${obligation}，所属目标 ${q.goalId}。使用已有凭据实际 claim，按正式 planning 完成 stage-register、finish-goal 或 closeout（记录阻塞），随后 resume。沿用现有成员与开始授权；空队列保留待命。`,this.sendTimeoutMs);
        update({status:'sent',error:null}); return;
      }
      // [AI-added] 2026-09-14 22:59
      if((b.wake.provider||'codex')==='codex')await this.send(adapter,b.wake,`[${marker}] 项目 ${projectId} ${obligation}。请用已有凭据 claim，按 kind=planning 的要求同步计划并登记已授权后续任务，或记录具体阻塞，再 closeout。空队列不代表项目完成；不要直接 park。`,this.sendTimeoutMs);
      else
      // [AI-added] 2026-09-14 22:06
      await this.send(adapter,b.wake,`[${marker}] 项目 ${projectId} ${obligation}。必须立即调用终端/命令工具，原样复用本会话已有的客户端、credential 和 data 路径，实际执行 claim；不得只展示、复述或建议命令，不得凭记忆重写路径。若宿主无法调用终端，明确报告阻塞。领取后按 kind=planning 的要求同步计划并登记已授权后续任务，或记录具体阻塞，再实际执行 closeout。空队列不代表项目完成；不要直接 park。`,this.sendTimeoutMs);
      update({status:'sent',error:null});
    }catch(e){const repair=await this.repair(adapter,e,{projectId});update(sendFailure(e,repair));}
  }
  async scopeNotice(projectId) {
    const p=this.store.state.projects[projectId],job=require('./scope-recovery.cjs').job(p),b=p.bindings?.brain;
    if(!job||!b?.wake||!b.armed)return;
    const q=p.tasks[job.taskId].scopeAlert;
    if(q.wakeNotice?.status==='sent')return;
    const marker='TASK-DISPATCH-SCOPE:'+q.id;
    const update=value=>this.store.change(s=>{const a=s.projects[projectId].tasks[job.taskId].scopeAlert;if(a?.id===q.id)a.wakeNotice={...a.wakeNotice,...value};});
    let adapter,info;
    try{adapter=this.forProvider(b.wake.provider||'codex');info=await hostCall.read(adapter,b.wake,this.readTimeoutMs);}catch(e){const repair=await this.repair(adapter,e,{projectId});update({error:repairMessage(e,repair)});return;}
    const found=(info.turns||[]).some(t=>(t.items||[]).some(i=>i.type==='userMessage'&&(i.content||[]).some(c=>c.text?.includes(marker))));
    if(found){update({status:'sent',marker,error:null});return;}
    if(['sending','uncertain'].includes(q.wakeNotice?.status)){update({status:'uncertain',error:'越界阻塞通知送达不确定，不自动重发。'});return;}
    if(info.thread?.status?.type!=='idle'&&!((b.wake.provider==='mimo')&&info.thread?.status?.type==='unknown'))return;
    const current=this.store.state.projects[projectId],a=current.tasks[job.taskId].scopeAlert;
    if(this.stopped||current.paused||current.completedAt||a?.id!==q.id||a.acknowledged||!current.bindings?.brain?.armed||JSON.stringify(current.bindings.brain.wake)!==JSON.stringify(b.wake))return;
    update({status:'sending',marker,at:new Date().toISOString()});
    // [AI-added] 2026-09-14 22:59
    if((b.wake.provider||'codex')==='codex'){
      try{await this.send(adapter,b.wake,`[${marker}] 项目 ${projectId} 的任务 ${job.taskId} 越界纠正需要大脑处理。请用已有凭据 claim 读取 scope_attention，核对差异并说明阻塞后 scope-ack；不要扩大 worker 修改计划的权限。`,this.sendTimeoutMs);update({status:'sent',error:null});}
      catch(e){const repair=await this.repair(adapter,e,{projectId});update(sendFailure(e,repair));}
      return;
    }
    // [AI-added] 2026-09-14 22:06
    try{await this.send(adapter,b.wake,`[${marker}] 项目 ${projectId} 的任务 ${job.taskId} 越界纠正需要大脑处理。必须立即调用终端/命令工具，原样复用本会话已有的客户端、credential 和 data 路径，实际执行 claim 读取 scope_attention；不得只展示、复述或建议命令，不得凭记忆重写路径。若宿主无法调用终端，明确报告阻塞。核对差异并说明阻塞后实际执行 scope-ack；不要扩大 worker 修改计划的权限。`,this.sendTimeoutMs);update({status:'sent',error:null});}
    catch(e){const repair=await this.repair(adapter,e,{projectId});update(sendFailure(e,repair));}
  }
  // [AI-added] 2026-09-19: Blocked/uncertain settlements reach the brain through the same
  // wake path as scope_attention. One confirmed send, then marker-based reconciliation.
  async attentionNotice(projectId) {
    const p=this.store.state.projects[projectId],job=require('./brain-attention.cjs').job(p),b=p.bindings?.brain;
    if(!job||!b?.wake||!b.armed)return;
    const q=p.tasks[job.taskId].attention;
    if(q.wakeNotice?.status==='sent')return;
    const marker='TASK-DISPATCH-ATTENTION:'+q.id;
    const update=value=>this.store.change(s=>{const a=s.projects[projectId].tasks[job.taskId].attention;if(a?.id===q.id)a.wakeNotice={...a.wakeNotice,...value};});
    let adapter,info;
    try{adapter=this.forProvider(b.wake.provider||'codex');info=await hostCall.read(adapter,b.wake,this.readTimeoutMs);}catch(e){const repair=await this.repair(adapter,e,{projectId});update({error:repairMessage(e,repair)});return;}
    const found=(info.turns||[]).some(t=>(t.items||[]).some(i=>i.type==='userMessage'&&(i.content||[]).some(c=>c.text?.includes(marker))));
    if(found){update({status:'sent',marker,error:null});return;}
    if(['sending','uncertain'].includes(q.wakeNotice?.status)){update({status:'uncertain',error:'任务阻塞通知送达不确定，不自动重发。'});return;}
    if(info.thread?.status?.type!=='idle'&&!((b.wake.provider==='mimo')&&info.thread?.status?.type==='unknown'))return;
    const current=this.store.state.projects[projectId],a=current.tasks[job.taskId].attention;
    if(this.stopped||current.paused||current.completedAt||a?.id!==q.id||a.acknowledged||!current.bindings?.brain?.armed||JSON.stringify(current.bindings.brain.wake)!==JSON.stringify(b.wake))return;
    update({status:'sending',marker,at:new Date().toISOString()});
    // [AI-added] 2026-09-14 22:59
    if((b.wake.provider||'codex')==='codex'){
      try{await this.send(adapter,b.wake,`[${marker}] 项目 ${projectId} 的任务 ${job.taskId} 处于 ${q.kind} 状态，需要大脑处理。请用已有凭据 claim 读取 task_attention，核对状态并向用户说明阻塞原因，处置后执行 attention-ack；原因未核实前不要盲目重试。`,this.sendTimeoutMs);update({status:'sent',error:null});}
      catch(e){const repair=await this.repair(adapter,e,{projectId});update(sendFailure(e,repair));}
      return;
    }
    // [AI-added] 2026-09-14 22:06
    try{await this.send(adapter,b.wake,`[${marker}] 项目 ${projectId} 的任务 ${job.taskId} 处于 ${q.kind} 状态，需要大脑处理。必须立即调用终端/命令工具，原样复用本会话已有的客户端、credential 和 data 路径，实际执行 claim 读取 task_attention；不得只展示、复述或建议命令，不得凭记忆重写路径。若宿主无法调用终端，明确报告阻塞。核对状态并向用户说明阻塞原因，处置后实际执行 attention-ack；原因未核实前不要盲目重试。`,this.sendTimeoutMs);update({status:'sent',error:null});}
    catch(e){const repair=await this.repair(adapter,e,{projectId});update(sendFailure(e,repair));}
  }
  // [AI-added] 2026-09-22 10:20: One marker per shared review or batch attention; uncertain sends never replay.
  async batchNotice(projectId){
    const p=this.store.state.projects[projectId],job=require('./stage-review.cjs').job(p),binding=p.bindings?.brain;
    if(!job||!binding?.wake||!binding.armed||this.desktop.d.pendingSettlements.size)return;
    const batch=p.reviewStages[job.roundId];if(job.kind==='stage_review'&&batch.attempt.claimedBy)return;
    const marker='TASK-DISPATCH-BATCH:'+(job.attemptId||job.alertId),notice=batch.wakeNotice?.marker===marker?batch.wakeNotice:{};
    const current=()=>{const q=this.store.state.projects[projectId],j=q&&require('./stage-review.cjs').job(q);return !this.stopped&&!q?.paused&&!q?.completedAt&&q?.bindings?.brain?.armed&&q.bindings.brain.clientId===binding.clientId&&JSON.stringify(q.bindings.brain.wake)===JSON.stringify(binding.wake)&&j?.roundId===job.roundId&&(j.attemptId||j.alertId)===(job.attemptId||job.alertId)&&!(job.kind==='stage_review'&&q.reviewStages[job.roundId].attempt?.claimedBy);};
    const update=value=>this.store.change(s=>{const b=s.projects[projectId]?.reviewStages?.[job.roundId];if(b&&!require('./stage-review.cjs').ended(b)){const previous=b.wakeNotice?.marker===marker?b.wakeNotice:{};b.wakeNotice={...previous,marker,...value};}});
    if(notice.status==='sent'){if(Date.now()-Date.parse(notice.at)>TASK_CLAIM_GRACE_MS&&!notice.error)update({claimStatus:'stalled',error:'批次通知已送达但仍未领取，请核对会话；不会自动重复审核或换人。'});return;}
    let adapter,info;try{adapter=this.forProvider(binding.wake.provider||'codex');info=await hostCall.read(adapter,binding.wake,this.readTimeoutMs);}catch(e){update({error:e.message});return;}
    if(!current())return;
    const found=(info.turns||[]).some(t=>(t.items||[]).some(i=>i.type==='userMessage'&&(i.content||[]).some(c=>c.text?.includes(marker))));
    if(found){update({status:'sent',at:notice.at||new Date().toISOString(),error:null});return;}
    if(['sending','uncertain'].includes(notice.status)){update({status:'uncertain',error:'批次通知送达不确定，请核对目标会话；不自动重发。'});return;}
    if(info.thread?.status?.type!=='idle'&&!(binding.wake.provider==='mimo'&&info.thread?.status?.type==='unknown'))return;
    update({status:'sending',at:new Date().toISOString()});
    try{await this.send(adapter,binding.wake,`[${marker}] 项目 ${projectId} 有 ${job.kind} 待办。立即调用终端工具，复用已有客户端、credential 和 data 路径实际执行 claim，并完成批次逐项审核或阻塞处置。不要仅展示命令；领取后按返回指令提交并 park。`,this.sendTimeoutMs);update({status:'sent',error:null});}catch(e){update(sendFailure(e,null));}
  }
  async close(){this.stopped=true;await this.busy;}
}
module.exports={Wake};
