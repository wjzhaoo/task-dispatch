// [AI-added] 2026-09-22 09:55: Derive historical metrics from identities, never mutable repair counters.
'use strict';
function summary(state,projectId){
 return Object.values(state.projects).filter(p=>!projectId||p.id===projectId).map(p=>{
  const seen=new Set(),events=(state.events||[]).filter(e=>e.projectId===p.id&&e.id&&!seen.has(e.id)&&seen.add(e.id));
  const tasks=Object.values(p.tasks),runs=new Map(tasks.flatMap(t=>(t.attempts||[]).map(r=>[r.id,r])));
  for(const b of Object.values(p.reviewStages||{}))for(const r of [...(b.attemptHistory||[]),...(b.attempt?[b.attempt]:[])])runs.set(r.id,r);
  const preparedEvents=events.filter(e=>['attempt_prepared','stage_review_prepared'].includes(e.type)&&e.attemptId);
  for(const e of preparedEvents)if(!runs.has(e.attemptId))runs.set(e.attemptId,{id:e.attemptId,role:e.role,historyOnly:true});
  const rows=tasks.map(t=>{
   const es=events.filter(e=>e.taskId===t.id),passed=new Set(),paired=new Set(),returned=new Set(),byRole={brain:0,reviewer:0,unknown:0};
   let repairs=0;
   for(const e of es){
    if(e.type!=='review_decision')continue;
    const role=e.role||runs.get(e.attemptId)?.role||'unknown';
    if(e.verdict==='needs_fix'){repairs++;byRole[role]=(byRole[role]||0)+1;}
    if(!e.artifactId)continue;
    if(role==='reviewer'&&e.verdict==='pass')passed.add(e.artifactId);
    if(role==='brain'&&passed.has(e.artifactId)&&['pass','needs_fix','blocked'].includes(e.verdict)){
     paired.add(e.artifactId);if(e.verdict==='needs_fix')returned.add(e.artifactId);
    }
   }
   const references=[...new Map([...(t.attempts||[]),...(t.stageReviewRefs||[]).map(id=>runs.get(id)).filter(Boolean),...preparedEvents.filter(e=>e.taskId===t.id).map(e=>runs.get(e.attemptId))].map(r=>[r.id,r])).values()];
   const prepared=references.length;
   return {taskId:t.id,prepared,claimed:references.filter(r=>r.claimedAt).length,settled:references.filter(r=>r.settled).length,businessRepairs:repairs,repairsByRole:byRole,scopeReturns:es.filter(e=>e.type==='scope_returned').length,infrastructureRecoveries:es.filter(e=>(e.type==='settlement_recovered')).length,infrastructureFailures:es.filter(e=>['EPERM','EBUSY','ENOSPC','EACCES'].includes(e.code)&&!['settlement_recovered','wake_repair'].includes(e.type)).length,unclassifiedRetries:es.filter(e=>e.type==='operator_retry'&&!e.code).length,matchedCandidates:paired.size,postPreReviewReturns:returned.size,historyComplete:!(t.state&&t.state!=='ready'&&!references.length)&&es.filter(e=>e.type==='review_decision').every(e=>['brain','reviewer'].includes(e.role||runs.get(e.attemptId)?.role))&&references.every(r=>!r.historyOnly&&(events.some(e=>e.type==='attempt_prepared'&&e.attemptId===r.id)||events.some(e=>e.type==='stage_review_prepared'&&e.attemptId===r.id)))};
  });
  const totals=Object.fromEntries(['businessRepairs','scopeReturns','infrastructureRecoveries','infrastructureFailures','unclassifiedRetries','matchedCandidates','postPreReviewReturns'].map(k=>[k,rows.reduce((n,t)=>n+t[k],0)]));
  totals.infrastructureRecoveries=events.filter(e=>e.type==='settlement_recovered').length;
  totals.infrastructureFailures=events.filter(e=>['EPERM','EBUSY','ENOSPC','EACCES'].includes(e.code)&&!['settlement_recovered','wake_repair'].includes(e.type)).length;
  return {projectId:p.id,...totals,prepared:runs.size,claimed:[...runs.values()].filter(r=>r.claimedAt).length,settled:[...runs.values()].filter(r=>r.settled).length,matchedTasks:rows.filter(t=>t.matchedCandidates).length,returnedTasks:rows.filter(t=>t.postPreReviewReturns).length,historyComplete:rows.every(t=>t.historyComplete),tasks:rows,note:'Attempts are dispatch records, not model calls. Missing history is not zero.'};
 });
}
module.exports={summary};
