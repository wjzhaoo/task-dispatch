// [AI-added] 2026-09-22 09:55: Metering is based on actual log deltas, including overlap and late updates.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const activities=require('../runtime/core/brain-activities.cjs'),usage=require('../runtime/core/usage.cjs'),{collect}=require('../runtime/core/codex-usage.cjs');
function fixture(t){
 const base=path.resolve('tmp/metrics-batch-20260922');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'activities-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const thread='11111111-1111-1111-1111-111111111111',p={id:'p',tasks:{T:{id:'T',attempts:[]}},bindings:{brain:{clientId:'brain',wake:{provider:'codex',threadId:thread}}}};
 const store={state:{projects:{p},events:[]},change(fn){fn(this.state);},event(s,type,data){s.events.push({id:String(s.events.length),type,...data});}},d={store,receiptPath:id=>path.join(root,id)},desktop={store,assertBinding(i){assert.equal(i.clientId,'brain');}},identity={projectId:'p',role:'brain',clientId:'brain'};
 const log=path.join(root,'rollout-'+thread+'.jsonl'),at=n=>'2026-01-01T00:00:0'+n+'Z',row=(n,i)=>JSON.stringify({timestamp:at(n),type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:i,cached_input_tokens:0,output_tokens:i/10,reasoning_output_tokens:0}}}});
 return {root,log,p,d,desktop,identity,at,row,thread};
}
test('activity identity, idempotent end, real usage and role boundaries',t=>{
 const x=fixture(t),input={activityId:'planning-1',kind:'planning',source:'initial plan'};
 activities.start(x.desktop,x.identity,input);assert.equal(activities.start(x.desktop,x.identity,input).duplicate,true);
 assert.throws(()=>activities.start(x.desktop,{...x.identity,role:'worker'},input),/Only brain/);
 assert.throws(()=>activities.start(x.desktop,x.identity,{...input,kind:'other'}),/Conflicting/);
 const meter={provider:'codex',model:'test',source:'platform',scope:'attempt',inputTokens:20,outputTokens:2};
 activities.end(x.desktop,x.identity,{activityId:input.activityId,usage:meter});assert.equal(activities.end(x.desktop,x.identity,{activityId:input.activityId}).duplicate,true);
 assert.throws(()=>activities.end(x.desktop,x.identity,{activityId:input.activityId,usage:{...meter,inputTokens:30}}),/Conflicting/);
 assert.equal(usage.summary(x.d.store.state).activityGroups.length,1);
});
test('collector refreshes running windows and assigns overlapping events only to the unique ledger',async t=>{
 const x=fixture(t),run={id:'r',role:'brain',usageBinding:x.p.bindings.brain.wake,startedAt:x.at(1)};x.p.tasks.T.attempts=[run];
 fs.writeFileSync(x.log,[x.row(0,100),x.row(1,200)].join('\n'));await collect(x.d,{root:x.root,now:Date.parse(x.at(2))});assert.equal(run.observedUsage.inputTokens,100);
 fs.appendFileSync(x.log,'\n'+x.row(2,300));await collect(x.d,{root:x.root,now:Date.parse(x.at(3))});assert.equal(run.observedUsage.inputTokens,200);
 x.p.brainActivities={a:{id:'a',role:'brain',kind:'planning',usageBinding:x.p.bindings.brain.wake,startedAt:x.at(2),settledAt:x.at(3),settled:true}};
 await collect(x.d,{root:x.root,now:Date.parse(x.at(3))});assert.equal(run.observedUsage.inputTokens,100);assert.equal(x.p.brainActivities.a.observedUsage,undefined);
 const out=usage.summary(x.d.store.state);assert.equal(out.totals[0].observedUniqueTokens.inputTokens,200);assert.equal(out.totals[0].coverage.conflictingEvents,1);
 assert.equal((await collect(x.d,{root:x.root,now:Date.parse(x.at(3))})).updatedAttempts,0);
 run.settled=true;run.settledAt=x.at(3);run.usage=usage.normalize({provider:'codex',model:'actual',source:'platform',scope:'attempt',inputTokens:500,outputTokens:50});
 await collect(x.d,{root:x.root,now:Date.parse(x.at(4))});assert.equal(run.usage.inputTokens,500);assert.equal(usage.summary(x.d.store.state).totals[0].combinedTokens,null);
});
test('counter reset establishes a new baseline and missing logs remain unknown',async t=>{
 const x=fixture(t);x.p.tasks.T.attempts=[{id:'r',role:'brain',usageBinding:x.p.bindings.brain.wake,startedAt:x.at(1),settledAt:x.at(5),settled:true}];
 fs.writeFileSync(x.log,[x.row(0,100),x.row(1,200),x.row(2,10),x.row(3,20),x.row(3,20)].join('\n'));await collect(x.d,{root:x.root});assert.equal(x.p.tasks.T.attempts[0].observedUsage.inputTokens,110);
 x.p.tasks.T.attempts.push({id:'other',role:'brain',usageBinding:{provider:'codex',threadId:'22222222-2222-2222-2222-222222222222'},startedAt:x.at(1),settledAt:x.at(5),settled:true});
 await collect(x.d,{root:x.root});assert.equal(x.p.tasks.T.attempts[1].usageObservation.reason,'log_not_found');
});
test('adjacent boundary is conflicting, gaps unallocated, cross-project sources deduplicate and rebinding never rewrites provenance',async t=>{
 const x=fixture(t),binding=structuredClone(x.p.bindings.brain.wake);
 x.p.tasks.T.attempts=[{id:'a',role:'brain',usageBinding:binding,startedAt:x.at(1),settledAt:x.at(2),settled:true},{id:'b',role:'brain',usageBinding:binding,startedAt:x.at(2),settledAt:x.at(3),settled:true},{id:'c',role:'brain',usageBinding:binding,startedAt:x.at(5),settledAt:x.at(6),settled:true}];
 fs.writeFileSync(x.log,[0,1,2,3,4,5,6].map(n=>x.row(n,100+n*100)).join('\n'));await collect(x.d,{root:x.root});
 let out=usage.summary(x.d.store.state);assert.equal(out.totals[0].coverage.conflictingEvents,1);assert.equal(out.totals[0].coverage.unallocatedEvents,1);
 x.d.store.state.projects.q={id:'q',tasks:{Q:{id:'Q',attempts:[{id:'q',role:'brain',usageBinding:binding,startedAt:x.at(1),settledAt:x.at(6),settled:true}]}}};
 x.p.bindings.brain.wake={provider:'codex',threadId:'22222222-2222-2222-2222-222222222222'};x.p.bindingHistory=[{clientId:'old'}];
 x.p.tasks.T.attempts.push({id:'legacy',role:'brain',startedAt:x.at(1),settledAt:x.at(6),settled:true});
 await collect(x.d,{root:x.root});out=usage.summary(x.d.store.state);assert.equal(out.observedUniqueTokens.inputTokens,600);assert.equal(out.observedEventCount,6);assert.equal(x.p.tasks.T.attempts.at(-1).observedUsage,undefined);assert.equal(x.p.tasks.T.attempts[0].usageBinding.threadId,x.thread);
});
test('replayed source events do not duplicate per-record observations or global totals',async t=>{
 const x=fixture(t);x.p.tasks.T.attempts=[{id:'r',role:'brain',usageBinding:x.p.bindings.brain.wake,startedAt:x.at(1),settledAt:x.at(3),settled:true}];
 fs.writeFileSync(x.log,[x.row(0,100),x.row(1,200),x.row(0,100),x.row(1,200)].join('\n'));await collect(x.d,{root:x.root});assert.equal(x.p.tasks.T.attempts[0].observedUsage.inputTokens,100);assert.equal(usage.summary(x.d.store.state).observedUniqueTokens.inputTokens,100);
 x.p.tasks.T.attempts.push(x.p.tasks.T.attempts[0]);await collect(x.d,{root:x.root});assert.equal(usage.summary(x.d.store.state).groups[0].attempts,1);assert.equal(x.p.tasks.T.attempts[0].usageWindow.conflicts,0);
});
