// [AI-added] 2026-09-22 09:55: Explicit activity boundaries never estimate model tokens.
'use strict';
const {id}=require('./storage.cjs');
function authorize(desktop,identity){desktop.assertBinding(identity);if(identity.role!=='brain')throw Error('Only brain can record activities');}
function start(desktop,identity,input){
 authorize(desktop,identity);const p=desktop.store.state.projects[identity.projectId];
 if(!['planning','troubleshooting','other'].includes(input.kind))throw Error('Invalid brain activity kind');
 if(typeof input.source!=='string'||!input.source.trim())throw Error('Activity source required');
 const activityId=input.activityId||id();require('./contracts.cjs').name(activityId);
 const old=p.brainActivities?.[activityId];
 if(old){if(old.kind!==input.kind||old.source!==input.source||old.clientId!==identity.clientId)throw Error('Conflicting brain activity');return {activityId,duplicate:true};}
 const b=p.bindings.brain,at=new Date().toISOString();
 desktop.store.change(s=>{const q=s.projects[p.id];q.brainActivities||={};q.brainActivities[activityId]={id:activityId,role:'brain',kind:input.kind,source:input.source,clientId:identity.clientId,startedAt:at,provider:b.wake?.provider||b.provider||'unknown',usageBinding:structuredClone(b.wake||{provider:b.provider||'unknown',threadId:b.sessionId})};desktop.store.event(s,'brain_activity_started',{projectId:p.id,activityId,kind:input.kind,source:input.source});});
 return {activityId};
}
function end(desktop,identity,input){
 authorize(desktop,identity);const a=desktop.store.state.projects[identity.projectId].brainActivities?.[input.activityId];
 if(!a||a.clientId!==identity.clientId)throw Error('Activity belongs to another binding');
 const usage=input.usage?require('./usage.cjs').normalize(input.usage):null;
 if(a.usage&&usage&&JSON.stringify(a.usage)!==JSON.stringify(usage))throw Error('Conflicting activity usage');
 if(a.settledAt&&(!usage||a.usage))return {ok:true,duplicate:true};
 desktop.store.change(s=>{const r=s.projects[identity.projectId].brainActivities[input.activityId];r.settledAt||=new Date().toISOString();r.settled=true;if(usage)r.usage=usage;desktop.store.event(s,'brain_activity_ended',{projectId:identity.projectId,activityId:r.id});});return {ok:true};
}
function autoStart(desktop,identity,kind,source){
 const key=require('./storage.cjs').sha(source+identity.clientId).slice(0,40);
 return start(desktop,identity,{activityId:'auto-'+key,kind,source});
}
function autoEnd(desktop,identity,source){
 const a=Object.values(desktop.store.state.projects[identity.projectId].brainActivities||{}).find(a=>a.source===source&&a.clientId===identity.clientId&&!a.settledAt);
 if(a)return end(desktop,identity,{activityId:a.id});
}
function records(p){const items=[...Object.values(p.tasks||{}).flatMap(t=>(t.attempts||[]).map(r=>({kind:'attempt',taskId:t.id,key:'attempt:'+r.id,record:r}))),...Object.values(p.brainActivities||{}).map(r=>({kind:'activity',key:'activity:'+r.id,record:r})),...Object.values(p.reviewStages||{}).flatMap(b=>[...(b.attemptHistory||[]),...(b.attempt?[b.attempt]:[])].map(r=>({kind:'stage',roundId:b.id,key:'stage:'+r.id,record:r})))];return [...new Map(items.map(item=>[item.key,item])).values()];}
module.exports={start,end,autoStart,autoEnd,records};
