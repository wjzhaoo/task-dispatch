'use strict';
const {bindingKey}=require('./bindings.cjs');
function waiting(p){return p.mode==='desktop'&&status(p).state==='waiting';}
function status(p){return p.startup||{state:'waiting',message:'Connect the planned workers and reviewer, then start work.'};}
function assertStarted(p){if(waiting(p))throw Error('Project awaiting manual start: connect all planned peers, then brain must call start-work after the user says start');}
function start(desktop,identity,input){
 desktop.assertBinding(identity);
 if(identity.role!=='brain')throw Error('Only brain can start work');
 const p=desktop.store.state.projects[identity.projectId];
 if(p.completedAt)throw Error('Project completed; reopen before starting work');
 if(input.confirmed!==true)throw Error('Explicit user start instruction required (--confirmed)');
 if(input.withoutReviewer===true)throw Error('Stage workflow requires a reviewer; without-reviewer is removed');
 if(!waiting(p))return {ok:true,duplicate:true,startup:status(p)};
 if(p.paused)throw Error('Project paused; resume before starting work');
 const workers=p.staffing?.workers||Object.entries(p.bindings||{}).filter(([k])=>k==='worker'||k.startsWith('worker:')).map(([k])=>({workerId:k==='worker'?'default':k.slice(7)}));
 if(!workers.length)throw Error('No planned worker connected');
 const missing=[];
 for(const w of workers){const k=bindingKey({role:'worker',workerId:w.workerId}),b=p.bindings?.[k];if(!b||p.handovers?.[k]||(w.capability&&!b.capabilities?.includes(w.capability))||(b.wake&&!b.armed))missing.push(k);}
 {const b=p.bindings?.reviewer;if(!b||p.handovers?.reviewer||(b.wake&&!b.armed)||!require('./pre-review.cjs').online(desktop.d,p))missing.push('reviewer');}
 if(missing.length)throw Error('Peers not ready: '+missing.join(', '));
 desktop.store.change(s=>{const q=s.projects[p.id];q.startup={state:'started',startedAt:new Date().toISOString(),startedBy:identity.clientId};desktop.store.event(s,'work_started',{projectId:p.id,...q.startup});});
 return {ok:true,startup:status(desktop.store.state.projects[p.id])};
}
module.exports={waiting,status,assertStarted,start};
