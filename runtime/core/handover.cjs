'use strict';
const {bindingKey}=require('./bindings.cjs');
function pendingWork(p,key) {
  // [AI-added] 2026-09-22 10:20: Shared review ownership cannot expire or silently transfer.
  if(key==='brain'&&Object.values(p.reviewStages||{}).some(b=>b.attempt&&!b.attempt.settled))return true;
  return Object.values(p.tasks).some(t=>t.attempts.some(a=>!a.settled&&bindingKey(a)===key) ||
    (t.scopeRecovery&&bindingKey({role:'worker',workerId:t.scopeRecovery.workerId})===key));
}
// [AI-added] 2026-09-16 21:34
function replacement(next) {return {clientId:next.clientId,tokenHash:next.tokenHash,sessionId:next.sessionId,capabilities:next.capabilities,...next.connection};}
function recoverBinding(d,projectId,key,next,supersededClientId) {
  const p=d.store.state.projects[projectId],old=p?.bindings?.[key];
  if(!old||old.clientId!==next.previousClientId)throw Error('Binding changed during recovery; inspect current owner');
  const attempts=[];
  if(key==='brain')for(const b of Object.values(p.reviewStages||{}))if(b.attempt&&!b.attempt.settled){if(b.attempt.claimedBy&&b.attempt.claimedBy!==old.clientId)throw Error('Batch belongs to an unexpected client');attempts.push({roundId:b.id,attemptId:b.attempt.id,claimed:b.attempt.claimedBy===old.clientId});}
  for(const t of Object.values(p.tasks))for(const a of t.attempts)if(!a.settled&&bindingKey(a)===key){
    if(a.claimedBy&&a.claimedBy!==old.clientId)throw Error('Unsettled attempt belongs to an unexpected client');
    attempts.push({taskId:t.id,attemptId:a.id,claimed:a.claimedBy===old.clientId,scopeRecovery:t.scopeRecovery?.clientId===old.clientId});
  }
  const recoveredAt=new Date().toISOString();
  return d.store.transaction(() => {
    d.store.change(s=>{
      const q=s.projects[projectId],previous=q.bindings[key];
      q.bindingHistory||=[];
      q.bindingHistory.push({binding:key,clientId:previous.clientId,sessionId:previous.sessionId,replacedAt:recoveredAt,recovery:true});
      q.bindings[key]=replacement(next);
      for(const item of attempts){
        const a=item.roundId?q.reviewStages[item.roundId].attempt:q.tasks[item.taskId].attempts.find(value=>value.id===item.attemptId);
        if(item.claimed){a.claimedBy=next.clientId;a.recoveredFromClientId=previous.clientId;a.recoveredAt=recoveredAt;}
        if(item.scopeRecovery)q.tasks[item.taskId].scopeRecovery.clientId=next.clientId;
      }
      if(q.handovers)delete q.handovers[key];
      d.store.event(s,'binding_recovery_confirmed',{projectId,binding:key,from:previous.clientId,to:next.clientId,recoveredAttempts:attempts.filter(item=>item.claimed).map(item=>item.attemptId),...(supersededClientId?{supersededClientId}:{})});
    });
    require('./rebind-invitations.cjs').update(d.store,projectId,next.invitationId,'completed',next.clientId);
    return {recovered:true,recoveredAttempts:attempts.filter(item=>item.claimed).map(item=>item.attemptId),...(supersededClientId?{supersededClientId}:{})};
  });
}
function finish(d,projectId) {
  const p=d.store.state.projects[projectId];
  if(d.active.has(projectId))return;
  const ready=Object.entries(p.handovers||{}).filter(([key,next])=>!pendingWork(p,key)&&p.bindings?.[key]?.clientId===next.previousClientId);
  if(!ready.length)return;
  d.store.transaction(() => {
    for(const [key,next] of ready) {
      d.store.change(s=>{
        const q=s.projects[projectId];
        q.bindingHistory||=[];
        const old=q.bindings[key];
        q.bindingHistory.push({binding:key,clientId:old.clientId,sessionId:old.sessionId,replacedAt:new Date().toISOString()});
        q.bindings[key]=replacement(next);
        delete q.handovers[key];
        d.store.event(s,'desktop_handover_completed',{projectId,binding:key,from:old.clientId,to:next.clientId});
      });
      // [AI-added] 2026-09-17 11:46
      require('./rebind-invitations.cjs').update(d.store,projectId,next.invitationId,'completed',next.clientId);
    }
  });
}
module.exports={pendingWork,finish,recoverBinding};
