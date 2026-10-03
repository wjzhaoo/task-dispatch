'use strict';
const {id}=require('./storage.cjs');
// [AI-added] 2026-09-21 09:38: Resolved predecessors are terminal, while only accepted work opens a new closeout stage.
const {terminal}=require('./task-state.cjs');

// A durable project-level obligation, separate from immutable review candidates.
function reconcile(store, projectId) {
  const p=store.state.projects[projectId];
  if (!p || p.mode!=='desktop' || p.completedAt) return;
  const covered=new Set((p.planningHistory||[]).flatMap(x=>x.acceptedTaskIds));
  const missing=Object.values(p.tasks).filter(t=>t.state==='accepted'&&!covered.has(t.id)&&!p.planning?.acceptedTaskIds.includes(t.id)).map(t=>t.id);
  if (!missing.length) return;
  store.change(s=>{
    const q=s.projects[projectId];
    q.planning ||= {id:id(),state:'pending',acceptedTaskIds:[],createdAt:new Date().toISOString()};
    q.planning.acceptedTaskIds.push(...missing);
    if(q.bindings?.brain?.wake){q.bindings.brain.armed=true;q.bindings.brain.armedAt=new Date().toISOString();}
    store.event(s,'planning_required',{projectId,planningId:q.planning.id,acceptedTaskIds:missing});
  });
}
function job(p) {
  if (!p.planning || p.planning.state!=='pending') return null;
  return {kind:'planning',projectId:p.id,planningId:p.planning.id,role:'brain',cwd:p.workspace,
    acceptedTaskIds:p.planning.acceptedTaskIds,needsAttention:!!p.planning.needsAttention,
    prompt:'阶段终审已结算。读取 status.reviewStages 的整体结论及 issues；未通过时必须追加新任务并在 stage-register.members[].repairKeys 关联所有问题，保持相同 stageId、milestone、acceptance，使用新 roundId。已通过可规划下一个完整功能阶段。plan 只登记草案；stage-register 提交完整计划并自动结清本待办。不能将原任务重置为 ready，也不能将小脑初审当最终通过。全部目标完成时调用 finish-project；无法推进用 closeout outcome=blocked 报告原因。不得因空队列宣称完成。'};

}
function closeout(desktop, identity, input) {
  desktop.assertBinding(identity);
  if(identity.role!=='brain')throw Error('Only brain can close out a stage');
  const p=desktop.store.state.projects[identity.projectId];
  const old=(p.planningHistory||[]).find(x=>x.id===input.planningId);
  const value={outcome:input.outcome,summary:input.summary,planEvidence:input.planEvidence,...(input.outcome==='planned'?{nextTaskIds:input.nextTaskIds}:{reason:input.reason})};
  if(old){if(JSON.stringify(old.resolution)!==JSON.stringify(value))throw Error('Conflicting closeout');require('./brain-activities.cjs').autoEnd(desktop,identity,'planning:'+input.planningId);return {ok:true,duplicate:true};}
  if(!p.planning||p.planning.id!==input.planningId)throw Error('Stale planning id');
  if(!['planned','blocked'].includes(input.outcome))throw Error('Expected planned or blocked; project completion requires finish-project');
  for(const k of ['summary','planEvidence',...(input.outcome==='blocked'?['reason']:[])])if(typeof input[k]!=='string'||!input[k].trim())throw Error(k+' required');
  if(input.outcome==='planned')throw Error('Use stage-register to submit a complete stage plan');
  desktop.store.change(s=>{
    const q=s.projects[p.id];q.planning.state='blocked';q.planning.resolution=value;
    desktop.store.event(s,'planning_resolved',{projectId:p.id,planningId:input.planningId,...value});
  });
  require('./brain-activities.cjs').autoEnd(desktop,identity,'planning:'+input.planningId);
  desktop.d.tick();return {ok:true,outcome:input.outcome};
}
module.exports={reconcile,job,closeout};
