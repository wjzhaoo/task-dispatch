'use strict';
// [AI-added] 2026-09-15 20:30
// Presence is an explicit binding lifecycle, not a heartbeat lease. A transient
// adapter failure or a long review must never revoke an owned attempt.
function touch(d, identity) {
  if (identity.role !== 'reviewer') return;
  d.reviewerPresence ||= new Map();
  d.reviewerPresence.set(identity.projectId, {clientId:identity.clientId, at:Date.now()});
  if(d.reviewerChecks?.get(identity.projectId)===identity.clientId)d.reviewerChecks.delete(identity.projectId);
}
function checking(d, p) {
  return !!p.bindings?.reviewer && d.reviewerChecks?.get(p.id)===p.bindings.reviewer.clientId && !p.handovers?.reviewer;
}
function online(d, p) {
  const seen=d.reviewerPresence?.get(p.id);
  return !!seen && seen.clientId===p.bindings?.reviewer?.clientId && !p.handovers?.reviewer;
}
function passed(t) {
  return t.preReview?.verdict==='pass' && t.preReview.artifactId===t.artifactId;
}
function disconnect(d,p,clientId,reason='reviewer_detached') {
  for(const t of Object.values(p.tasks)) {
    const r=t.attempts.at(-1);
    if(t.state!=='reviewing'||r?.role!=='reviewer'||r.settled||(r.claimedBy&&r.claimedBy!==clientId))continue;
    d.store.change(s=>{
      const q=s.projects[p.id].tasks[t.id],a=q.attempts.at(-1);
      if(a.id!==r.id||a.settled||(a.claimedBy&&a.claimedBy!==clientId))return;
      a.settled=true;a.settledAt=new Date().toISOString();a.outcome=reason;
      q.state='review_ready';q.resumePhase='brain';
      d.store.event(s,reason,{projectId:p.id,taskId:t.id,attemptId:a.id});
    });
  }
  d.reviewerPresence?.delete(p.id);
}
module.exports={touch,online,passed,disconnect,checking};
