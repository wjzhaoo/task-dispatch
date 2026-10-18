'use strict';
const {id}=require('./storage.cjs');
// [AI-added] 2026-09-19: scope_attention only covers out-of-scope conflicts. Every other
// blocked/uncertain settlement used to leave the brain uninformed: no wake, no claimable
// job, only a dashboard alert. This gives those settlements the same push path.
function raise(d,projectId,taskId,message){
 d.store.change(s=>{
  const q=s.projects[projectId]?.tasks[taskId];
  if(!q||!['blocked','uncertain'].includes(q.state))return;
  const wake=!!s.projects[projectId].bindings?.brain?.wake;
  q.attention={id:id(),message:typeof message==='string'?message.slice(0,2000):'任务需要大脑处理',kind:q.state,createdAt:new Date().toISOString(),wake};
  if(s.projects[projectId].bindings?.brain?.wake){s.projects[projectId].bindings.brain.armed=true;s.projects[projectId].bindings.brain.armedAt=new Date().toISOString();}
  d.store.event(s,'task_attention',{projectId,taskId,state:q.state,message:q.attention.message,wake});
 });
}
const blocked=t=>['blocked','uncertain'].includes(t.state);
const registeredReplacement=(p,t,r)=>r?.supersedes?.includes(t.id)&&p.reviewStages?.[r.roundId]?.reviewTaskIds.includes(r.id);
const remediation=(p,t)=>p&&registeredReplacement(p,t,p.tasks[t.attention?.remediationTaskId]);
const actionable=(t,p)=>blocked(t)&&t.attention&&(!t.attention.acknowledged||(!t.attention.waitReason&&!remediation(p,t)));
function reconcile(d,projectId){
 const p=d.store.state.projects[projectId];
 for(const t of Object.values(p.tasks))if(blocked(t)&&t.attention?.acknowledged&&!t.attention.waitReason&&!remediation(p,t)){
  // Older clients could acknowledge an unresolved block and then park forever.
  const previous=t.attention.id;
  raise(d,projectId,t.id,t.error||t.attention.message);
  d.store.change(s=>{s.projects[projectId].tasks[t.id].attention.reopenedFrom=previous;});
 }
}
function job(p){
 const t=Object.values(p.tasks).find(t=>actionable(t,p));
 return t?{kind:'task_attention',projectId:p.id,taskId:t.id,alertId:t.attention.id,role:'brain',cwd:p.workspace,
  prompt:'项目 '+p.id+' 的任务 '+t.id+' 处于 '+t.attention.kind+' 状态需要大脑处理：'+t.attention.message+'。先 claim 读取状态与相关差异，查清原因并实际处置：使用大脑凭据执行 retry、assign --retry、task-budget、revise-task，或登记带 supersedes 的替代任务。替代任务 accepted 后旧阻塞才可 resolve-task；不得直接伪造 accepted。可安全解决的内部问题应继续处理，不得只报告问题、确认通知后 park。涉及新增用户授权、真实外部调用或费用时向用户求助，原因未核实前不盲目重试。任务脱离 blocked/uncertain，或已登记并注册带 supersedes 的替代任务后，用 attention-ack --task '+t.id+' --alert-id '+t.attention.id+' 结算通知。确实需要等待用户决定时，必须在该命令增加 --wait-reason "具体需要用户决定或提供的事项"，服务会保留等待用户告警；不得把普通确认当作完成处置。'}:null;
}
function acknowledge(desktop,identity,input){
 if(identity.role!=='brain')throw Error('Only brain can acknowledge task attention');
 const t=desktop.store.state.projects[identity.projectId]?.tasks[input.taskId];
 if(t?.attention?.id!==input.alertId)throw Error('Stale task attention');
 const p=desktop.store.state.projects[identity.projectId];
 const replacement=Object.values(p.tasks).find(r=>registeredReplacement(p,t,r)&&!blocked(r));
 const waiting=blocked(t),reason=typeof input.waitReason==='string'?input.waitReason.trim():'';
 if(waiting&&!replacement&&(!reason||reason.length>2000))throw Error('任务仍然阻塞，不能只确认通知后挂起。请先实际处置；确需用户决定时提供 --wait-reason（1 至 2000 字），明确等待事项。');
 // Retry/assign may already have settled the alert; repeated acknowledgements stay idempotent.
 if(!t.attention.acknowledged||(waiting?(replacement?t.attention.remediationTaskId!==replacement.id:t.attention.waitReason!==reason):!t.attention.resolvedAt))desktop.store.change(s=>{
  const a=s.projects[identity.projectId].tasks[t.id].attention;
  a.acknowledged=true;a.acknowledgedAt=new Date().toISOString();
  if(waiting&&replacement){a.remediationTaskId=replacement.id;delete a.waitReason;}
  else if(waiting){a.waitReason=reason;delete a.remediationTaskId;}
  else{a.resolvedAt=new Date().toISOString();delete a.waitReason;delete a.remediationTaskId;}
  desktop.store.event(s,waiting?(replacement?'task_attention_remediation':'task_attention_deferred'):'task_attention_resolved',{projectId:identity.projectId,taskId:t.id,alertId:input.alertId,...(waiting?(replacement?{replacementTaskId:replacement.id}:{reason}):{})});
 });
 require('./brain-activities.cjs').autoEnd(desktop,identity,'attention:'+input.alertId);return {ok:true};
}
module.exports={raise,job,acknowledge,reconcile,actionable};
