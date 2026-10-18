'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {Store}=require('../runtime/core/storage.cjs');
const {Dispatcher}=require('../runtime/core/dispatcher.cjs');
const {Desktop}=require('../runtime/core/desktop.cjs');
const {Wake}=require('../runtime/core/wake.cjs');
function setup(t){
 fs.mkdirSync(path.resolve('tmp'),{recursive:true});
 const base=fs.mkdtempSync(path.resolve('tmp/planning-')),workspace=path.join(base,'work');fs.mkdirSync(workspace);
 let store=new Store(path.join(base,'data'));
 const make=()=>{const d=new Dispatcher(store,{maxConcurrent:2});return {d,desktop:new Desktop(d)};};
 let {d,desktop}=make();
 const brain=desktop.attach({workspace,role:'brain',clientId:'brain123',token:'a'.repeat(64)});
 const worker=desktop.attach({workspace,role:'worker',clientId:'worker123',token:'b'.repeat(64)});
 require('./stage-fixture.cjs').start(desktop,brain);
 // [AI-added] 2026-09-14 22:06
 let sends=0,fail=false,status='idle',messages=[];
 const adapter={read:async()=>({thread:{id:'brain',cwd:workspace,status:{type:status}},turns:[]}),send:async(_binding,message)=>{sends++;messages.push(message);if(fail)throw Error('lost ack');}};
 let wake=new Wake(desktop,adapter);
 const x={brain,worker,adapter,sends:()=>sends,fail:()=>fail=true,status:value=>status=value,messages:()=>messages,
  get store(){return store;},get d(){return d;},get desktop(){return desktop;},get wake(){return wake;},
  p:()=>store.state.projects[brain.projectId],
  add:(id,deps=[])=>d.addTask(brain.projectId,{id,title:id,instructions:'i',acceptance:'a',allowedPaths:['README.md'],dependsOn:deps}),
  accepted:()=>{x.add('D03');store.change(s=>{s.projects[brain.projectId].tasks.D03.state='accepted';});d.tick();},
  bind:()=>wake.bind(brain,{provider:'codex',threadId:'brain',turnId:'turn'}),
  restart:()=>{store.close();store=new Store(path.join(base,'data'));({d,desktop}=make());wake=new Wake(desktop,adapter);d.recover();d.tick();}
 };t.after(()=>store.close());return x;
}
test('accepted stage queue produces durable closeout; park refuses omission and worker cannot resolve',async t=>{
 const x=setup(t);await x.bind();x.accepted();
 const first=x.wake.park(x.brain);assert.equal(first.parked,false);assert.equal(first.job.kind,'planning');
 x.restart();assert.equal(x.desktop.claim(x.brain).planningId,first.job.planningId);
 assert.equal(x.wake.park(x.brain).needsAttention,true);
 const report={planningId:first.job.planningId,outcome:'planned',summary:'next',planEvidence:'plan updated',nextTaskIds:['D04']};
 assert.throws(()=>x.desktop.closeout(x.worker,report),/Only brain/);
 assert.throws(()=>x.desktop.closeout(x.brain,report),/stage-register/);
 x.add('D04',['D03']);assert.equal(x.desktop.claim(x.worker),null);
 require('./stage-fixture.cjs').begin(x.d,x.brain.projectId);
 assert.equal(x.desktop.claim(x.worker).taskId,'D04');
 x.restart();assert.equal(x.p().planning,undefined);assert.equal(x.p().planningHistory.length,1);
});
// [AI-added] 2026-09-14 22:53
test('auxiliary claims carry platform-neutral continuation instructions on wake hosts',async t=>{
 const x=setup(t);await x.bind();x.accepted();
 for(const provider of ['codex','qoder',undefined,'mimo']){
  x.store.change(s=>{s.projects[x.brain.projectId].bindings.brain.provider=provider; s.projects[x.brain.projectId].bindings.brain.wake=provider?{provider,threadId:'brain',turnId:'turn',...(provider==='qoder'?{workspace:x.p().workspace}:{})}:null;});
  const job=x.desktop.claim(x.brain),original=require('../runtime/core/planning.cjs').job(x.p());
  if(provider)assert.match(job.prompt,/成功后必须.*实际执行 park/);
  else assert.equal(job.prompt,original.prompt);
  x.store.change(s=>{s.projects[x.brain.projectId].tasks.D03.scopeAlert={id:'alert',message:'test'};});
  const scope=x.desktop.claim(x.brain),originalScope=require('../runtime/core/scope-recovery.cjs').job(x.p());
  if(provider)assert.match(scope.prompt,/成功后必须.*实际执行 park/);
  else assert.equal(scope.prompt,originalScope.prompt);
  x.store.change(s=>{delete s.projects[x.brain.projectId].tasks.D03.scopeAlert;});
 }
});
test('explicit authorization block persists, permits parking, and can be resolved with registered tasks',async t=>{
 const x=setup(t);await x.bind();x.accepted();const planningId=x.desktop.claim(x.brain).planningId;
 assert.throws(()=>x.desktop.closeout(x.brain,{planningId,outcome:'blocked',summary:'wait',planEvidence:'updated'}),/reason/);
 x.desktop.closeout(x.brain,{planningId,outcome:'blocked',summary:'等待真实调用授权',planEvidence:'计划记录阻塞',reason:'真实调用尚未授权'});
 x.restart();const parked=x.wake.park(x.brain);assert.equal(parked.parked,true);assert.match(parked.planningBlock.reason,/授权/);
 x.add('D04',['D03']);assert.equal(x.desktop.claim(x.worker),null);await x.wake.run();assert.equal(x.sends(),0);
 require('./stage-fixture.cjs').begin(x.d,x.brain.projectId);
 assert.equal(x.desktop.claim(x.worker).taskId,'D04');
});
// [AI-added] 2026-09-14 20:39
test('terminal accepted branches do not require artificial downstream dependencies',async t=>{
 const x=setup(t);await x.bind();x.accepted();const planningId=x.desktop.claim(x.brain).planningId;
 x.add('terminal');x.store.change(s=>{s.projects[x.brain.projectId].tasks.terminal.state='accepted';});x.d.tick();
 x.add('D04',['D03']);
 require('./stage-fixture.cjs').begin(x.d,x.brain.projectId);
 assert.equal(x.desktop.claim(x.worker).taskId,'D04');
});
test('empty queue wakes planning once across restart, uncertain sends are not repeated',async t=>{
 const x=setup(t);await x.bind();x.accepted();await x.wake.run();assert.equal(x.sends(),1);
 // [AI-added] 2026-09-14 22:06
 // [AI-added] 2026-09-14 22:59
 assert.match(x.messages()[0],/请用已有凭据 claim/);assert.doesNotMatch(x.messages()[0],/不得只展示/);
 x.restart();await x.wake.run();assert.equal(x.sends(),1);
 const y=setup(t);await y.bind();y.accepted();y.fail();await y.wake.run();y.restart();await y.wake.run();assert.equal(y.sends(),1);assert.equal(y.p().planning.wakeNotice.status,'uncertain');
});
// [AI-added] 2026-09-14 22:06
test('delivered planning wake flags only idle unclaimed closeout after grace without resending',async t=>{
 const x=setup(t);await x.bind();x.accepted();await x.wake.run();
 // [AI-added] 2026-09-14 22:59
 x.wake.adapter={forProvider:()=>x.adapter};
 x.store.change(s=>{s.projects[x.brain.projectId].bindings.brain.provider='mimo';s.projects[x.brain.projectId].bindings.brain.wake.provider='mimo';});
 x.store.change(s=>{s.projects[x.brain.projectId].planning.wakeNotice.at=new Date(Date.now()-61_000).toISOString();});
 x.status('active');await x.wake.run();assert.equal(x.p().planning.needsAttention,undefined);
 x.status('idle');await x.wake.run();assert.equal(x.p().planning.needsAttention,true);assert.match(x.p().planning.wakeNotice.error,/unclaimed/);assert.equal(x.sends(),1);
 const y=setup(t);await y.bind();y.accepted();await y.wake.run();
 y.store.change(s=>{s.projects[y.brain.projectId].planning.wakeNotice.at=new Date(Date.now()-61_000).toISOString();});
 assert.equal(y.desktop.claim(y.brain).kind,'planning');await y.wake.run();assert.equal(y.p().planning.needsAttention,undefined);assert.equal(y.sends(),1);
});
// [AI-added] 2026-09-14 22:59
test('Codex delivered planning does not generate timeout attention without timeout attention',async t=>{
 const x=setup(t);await x.bind();x.accepted();await x.wake.run();
 x.store.change(s=>{s.projects[x.brain.projectId].planning.wakeNotice.at=new Date(Date.now()-120_000).toISOString();});
 x.adapter.read=async()=>{throw Error('Codex sent notices must not query status');};
 await x.wake.run();assert.equal(x.p().planning.needsAttention,undefined);
 assert.equal(x.p().planning.wakeNotice.error,null);assert.equal(x.sends(),1);
});
test('finish remains explicit; pause and completed projects do not wake',async t=>{
 const x=setup(t);await x.bind();x.accepted();x.d.pause(x.brain.projectId,true);await x.wake.run();assert.equal(x.sends(),0);
 x.d.pause(x.brain.projectId,false);x.d.finishProject(x.brain.projectId);await x.wake.run();assert.equal(x.sends(),0);assert.equal(x.wake.park(x.brain).completed,true);
 assert.equal(x.p().planning,undefined);assert.equal(x.p().planningHistory.at(-1).state,'completed');
 x.d.finishProject(x.brain.projectId);assert.equal(x.p().planningHistory.length,1);
 x.d.finishProject(x.brain.projectId,true);x.d.tick();assert.equal(x.p().planning,undefined);
});
