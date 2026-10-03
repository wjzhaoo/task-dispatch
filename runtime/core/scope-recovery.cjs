'use strict';
const fs=require('node:fs'),path=require('node:path');
const {id,sha}=require('./storage.cjs');
/* Previous implementation:
const {allowed,difference,loadSnapshot,manifest}=require('./snapshot.cjs');
*/
// [AI-added] 2026-09-14 20:03
const {allowed,ignored,difference,loadSnapshot,manifest}=require('./snapshot.cjs');
const authorityFile=f=>/(^|\/)(plan|contract|status)\.md$/i.test(f)||/(^|\/)tasks\//i.test(f)||/(^|[-_])(review|acceptance|handoff|closeout|status|plan|contract)([-_.]|$)/i.test(path.posix.basename(f));
const planFile=f=>/^(?:plan\.md|contract\.md|docs\/(?:plans|reviews)(?:\/|$)|\.task-dispatch\/(?:plan\.md|contract\.md|tasks(?:\/|$)|reviews(?:\/|$)))/i.test(f);
// [AI-added] 2026-09-17 11:46
const controlFile=f=>planFile(f)||/^(?:docs\/(?:status|closeout|handoffs?)(?:\/|$)|\.task-dispatch\/(?:status|closeout|handoffs?)(?:\/|\.|$))/i.test(f)&&authorityFile(f);
// [AI-added] 2026-09-20: A worker normally writes only its own results directory, but the brain
// may explicitly authorize another task's directory (a correction round that preserves the
// original evidence). An entry naming a concrete docs/worker-results/<id>/ directory therefore
// counts; a blanket docs/worker-results/ grant still does not.
const authorizedResults=(f,paths)=>paths.some(p=>/^docs\/worker-results\/[^/]+\//i.test(p)&&f.startsWith(p));
const writable=(f,paths,taskId)=>allowed(f,paths)&&!planFile(f)&&(!/^docs\/worker-results\//i.test(f)||authorizedResults(f,paths)||!!taskId&&f.startsWith('docs/worker-results/'+taskId+'/'));
// Persisted attempts issued before directory separation finish under their issued rules.
// This compatibility applies only to receipt validation, never to a new dispatch.
const issuedWritable=(f,paths,run,taskId)=>run.scopePolicy==='separated-v1'?writable(f,paths,taskId):allowed(f,paths)&&(!(f==='plan.md'||f==='.task-dispatch/plan.md'||f.startsWith('docs/plans/'))||(f.includes('/evidence/')&&paths.includes(f)&&!authorityFile(f)));
const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
function alert(d,p,t,message){
 d.store.change(s=>{const q=s.projects[p.id].tasks[t.id];q.state='blocked';q.error=message;q.resumePhase='worker';q.scopeAlert={id:id(),message,createdAt:new Date().toISOString()};if(s.projects[p.id].bindings?.brain?.wake){s.projects[p.id].bindings.brain.armed=true;s.projects[p.id].bindings.brain.armedAt=new Date().toISOString();}d.store.event(s,'scope_attention',{projectId:p.id,taskId:t.id,message});});
}
function queue(d,p,t,run,candidate,result,receipt,targets,legacy=false){
 const current=manifest(p.workspace,run.snapshotPolicy);
 targets=targets.map(x=>({...x,observed:current[x.path]||null}));
 const count=(t.scopeReturns||0)+1;
 const originalBaselineId=run.scopeRecovery?.originalBaselineId||run.baselineId;
 const recovery={originalBaselineId,rejectedAttemptId:run.id,rejectedArtifactId:candidate.id,workerId:run.workerId||'default',clientId:run.claimedBy||null,targets,
  beforeDirectory:path.join(d.artifacts,originalBaselineId,'tree'),rejectedDirectory:path.join(d.artifacts,candidate.id,'tree')};
 d.store.change(s=>{const q=s.projects[p.id].tasks[t.id],a=q.attempts.find(a=>a.id===run.id);q.scopeReturns=count;q.scopeRecovery=recovery;q.workerId=recovery.workerId;q.currentWorkerId=recovery.workerId;
  a.settled=true;a.settledAt ||=new Date().toISOString();a.submissionHash=sha(receipt.text);a.scopeRejectedArtifactId=candidate.id;
  q.workerReport=result;q.error='Out-of-scope changes: '+targets.map(x=>x.path).join(', ');q.resumePhase='worker';q.state='ready';
  delete q.scopeRecoveryRequested;
  d.store.event(s,'scope_returned',{projectId:p.id,taskId:t.id,attemptId:run.id,paths:targets.map(x=>x.path),legacy});});
 if(count>2||result.status==='blocked')alert(d,p,t,count>2?'越界纠正已连续失败两轮，需要大脑处理；不要继续重试。':result.summary);
 else if(p.mode==='desktop' && recovery.clientId && p.bindings?.[require('./bindings.cjs').bindingKey({role:'worker',workerId:recovery.workerId})]?.clientId!==recovery.clientId)alert(d,p,t,'原执行员已断开或换绑，越界纠正不能自动交给另一执行员。');
 return false;
}
function check(d,p,t,run,candidate,result,receipt){
 const before=loadSnapshot(d.artifacts,run.baselineId),changes=difference(before.files,candidate.files),recovery=run.scopeRecovery;
 /* Previous implementation:
 const targets=(recovery?.targets||[]).filter(x=>!same(candidate.files[x.path],x.expected));
 */
 // [AI-added] 2026-09-14 20:03
 const targets=(recovery?.targets||[]).filter(x=>!ignored(x.path,run.snapshotPolicy)&&!same(candidate.files[x.path],x.expected));
 for(const f of changes){
  // [AI-added] 2026-09-14 20:03
  if(ignored(f,run.snapshotPolicy))continue;
  if(issuedWritable(f,t.allowedPaths,run,t.id))continue;
  const prior=recovery?.targets.find(x=>x.path===f);
  if(prior&&same(candidate.files[f],prior.expected))continue;
  if(!targets.some(x=>x.path===f))targets.push(prior||{path:f,expected:before.files[f]||null,reason:planFile(f)?'计划文档仅由大脑维护':'不在本任务允许范围'});
 }
 if(targets.length)return queue(d,p,t,run,candidate,result,receipt,targets);
 const original=loadSnapshot(d.artifacts,recovery?.originalBaselineId||run.baselineId);
 /* Previous implementation:
 return {changed:difference(original.files,candidate.files).filter(f=>issuedWritable(f,t.allowedPaths,run,t.id))};
 */
 // [AI-added] 2026-09-14 20:03
 return {changed:difference(original.files,candidate.files).filter(f=>!ignored(f,run.snapshotPolicy)&&issuedWritable(f,t.allowedPaths,run,t.id))};
}
// Import a legacy rejection without rerunning business implementation or editing its files.
function resume(d,projectId,taskId){
 const p=d.store.state.projects[projectId],t=p?.tasks[taskId],run=t?.attempts.at(-1);
 if(!t||t.state!=='blocked'||!t.error?.startsWith('Out-of-scope changes:')||run?.role!=='worker'||!run.settled||d.active.has(projectId)||Object.values(p.tasks).some(t=>['running','reviewing','uncertain'].includes(t.state)))throw Error('Scope recovery requires an idle project and blocked scope rejection');
 if(t.scopeRecovery)throw Error('Scope correction already attempted; inspect before retrying');
 const receipt=require('./storage.cjs').read(d.receiptPath(run.id)),result=require('./contracts.cjs').parseResult(receipt.text,{projectId,taskId,attemptId:run.id,role:'worker'});
 const before=loadSnapshot(d.artifacts,run.baselineId),candidate=loadSnapshot(d.artifacts,receipt.artifactId),current=manifest(p.workspace,run.snapshotPolicy),changes=difference(before.files,candidate.files),targets=[];
 for(const f of changes){
  if(writable(f,t.allowedPaths,t.id)){if(!same(current[f],candidate.files[f]))throw Error('Business file changed since receipt: '+f);continue;}
  let expected=before.files[f]||null,reason='恢复本次越界修改，保留他人改动';
  if(!same(current[f],candidate.files[f])){
   if(!before.files[f]||!candidate.files[f]||!current[f]||current[f].mode!==candidate.files[f].mode)throw Error('Cannot isolate scope change: '+f);
   const old=fs.readFileSync(path.join(d.artifacts,before.id,'tree',f)),bad=fs.readFileSync(path.join(d.artifacts,candidate.id,'tree',f)),live=fs.readFileSync(path.join(p.workspace,f));
   if(bad.length<=old.length||!bad.subarray(0,old.length).equals(old))throw Error('Concurrent edits require brain reconciliation: '+f);
   const addition=bad.subarray(old.length),at=live.indexOf(addition);
   if(at<0||live.indexOf(addition,at+1)!==-1)throw Error('Append cannot be isolated safely: '+f);
   expected={...current[f],hash:sha(Buffer.concat([live.subarray(0,at),live.subarray(at+addition.length)]))};
   reason='仅删除 rejectedDirectory 相对 beforeDirectory 中本次追加的完整片段，当前文件其他内容必须逐字节保留';
  }
  targets.push({path:f,expected,reason});
 }
 if(!targets.length)throw Error('No scope violations found');
 return queue(d,p,t,run,candidate,result,receipt,targets,true);
}
function request(d,projectId,taskId){
 const t=d.store.state.projects[projectId]?.tasks[taskId];
 if(!t||t.state!=='blocked'||!t.error?.startsWith('Out-of-scope changes:')||t.scopeRecovery)throw Error('Expected legacy scope rejection');
 d.store.change(s=>{s.projects[projectId].tasks[taskId].scopeRecoveryRequested=true;d.store.event(s,'scope_return_requested',{projectId,taskId});});
}
function reconcile(d,projectId){
 const p=d.store.state.projects[projectId];
 if(d.active.has(projectId)||p.paused||p.completedAt||Object.values(p.tasks).some(t=>['running','reviewing','uncertain','review_ready'].includes(t.state)||t.scopeRecovery&&t.state==='ready'))return;
 const t=Object.values(p.tasks).find(t=>t.scopeRecoveryRequested);
 if(t)try{resume(d,projectId,t.id);}catch(e){d.store.change(s=>{delete s.projects[projectId].tasks[t.id].scopeRecoveryRequested;});alert(d,p,t,e.message);}
}
function job(p){const t=Object.values(p.tasks).find(t=>t.scopeAlert&&!t.scopeAlert.acknowledged);return t?{kind:'scope_attention',projectId:p.id,taskId:t.id,alertId:t.scopeAlert.id,role:'brain',cwd:p.workspace,prompt:'越界纠正需要处理：'+t.scopeAlert.message+'。先查看状态和差异，向用户说明具体阻塞，不放宽 worker 对计划的编辑权限。处理或记录需要用户决定的事项后，用 scope-ack 确认已收到通知；确认不会放行任务。'}:null;}
function acknowledge(desktop,identity,input){if(identity.role!=='brain')throw Error('Only brain can acknowledge scope alerts');const t=desktop.store.state.projects[identity.projectId].tasks[input.taskId];if(t?.scopeAlert?.id!==input.alertId)throw Error('Stale scope alert');desktop.store.change(s=>{s.projects[identity.projectId].tasks[t.id].scopeAlert.acknowledged=true;});return {ok:true};}
// [AI-added] 2026-09-17 11:46
module.exports={authorityFile,planFile,controlFile,writable,check,resume,alert,request,reconcile,job,acknowledge};
