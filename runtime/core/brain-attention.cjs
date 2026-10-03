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
function job(p){
 const t=Object.values(p.tasks).find(t=>t.attention&&!t.attention.acknowledged);
 return t?{kind:'task_attention',projectId:p.id,taskId:t.id,alertId:t.attention.id,role:'brain',cwd:p.workspace,
  prompt:'项目 '+p.id+' 的任务 '+t.id+' 处于 '+t.attention.kind+' 状态需要大脑处理：'+t.attention.message+'。先 claim 读取状态与相关差异，向用户说明具体阻塞原因；按原因使用大脑凭据执行 retry、assign --retry、configure-repair、reconcile-review、task-budget、revise-task，或登记带 supersedes 的替代任务。替代任务 accepted 后旧阻塞才可 resolve-task；不得直接伪造 accepted。涉及新用户授权、真实外部调用或费用时必须向用户求助，原因未核实前不盲目重试。处置完成或记录用户决定后，用 attention-ack --task '+t.id+' --alert-id '+t.attention.id+' 确认通知；确认本身不放行任务。'}:null;
}
function acknowledge(desktop,identity,input){
 if(identity.role!=='brain')throw Error('Only brain can acknowledge task attention');
 const t=desktop.store.state.projects[identity.projectId]?.tasks[input.taskId];
 if(t?.attention?.id!==input.alertId)throw Error('Stale task attention');
 // Brain may settle the attention (assign --retry) before acking; ack stays idempotent.
 if(t.attention.acknowledged){require('./brain-activities.cjs').autoEnd(desktop,identity,'attention:'+input.alertId);return {ok:true};}
 desktop.store.change(s=>{s.projects[identity.projectId].tasks[t.id].attention.acknowledged=true;});
 require('./brain-activities.cjs').autoEnd(desktop,identity,'attention:'+input.alertId);return {ok:true};
}
module.exports={raise,job,acknowledge};
