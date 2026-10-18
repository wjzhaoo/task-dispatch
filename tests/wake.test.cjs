const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../runtime/core/storage.cjs');
const {Dispatcher}=require('../runtime/core/dispatcher.cjs');
const {Desktop}=require('../runtime/core/desktop.cjs');
const {Wake}=require('../runtime/core/wake.cjs');
function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wake-test-')),workspace=path.join(root,'work');fs.mkdirSync(workspace);
 const store=new Store(path.join(root,'data'));t.after(()=>store.close());
 const d=new Dispatcher(store,{maxConcurrent:2});
 const desktop=new Desktop(d);desktop.attach({workspace,role:'worker',clientId:'worker123',token:'a'.repeat(64)});
 // These cases exercise an already-started project's wake lifecycle.
 store.change(s=>{for(const p of Object.values(s.projects))p.startup={state:'started'};});
 const identity=desktop.authenticate('a'.repeat(64));let status='idle',sends=0,fail=false;
 const adapter={read:async()=>({thread:{id:'test-thread',cwd:workspace,status:{type:status}},turns:[]}),send:async()=>{sends++;if(fail)throw Error('lost ack');return {};}};
 const wake=new Wake(desktop,adapter);
 const bind=()=>wake.bind(identity,{provider:'codex',threadId:'test-thread',turnId:'old-turn'});
 const add=()=>{d.addTask(identity.projectId,{id:'T',title:'t',instructions:'i',acceptance:'a',allowedPaths:['README.md']});require('./stage-fixture.cjs').begin(d);};
 const run=()=>store.state.projects[identity.projectId].tasks.T.attempts.at(-1);
 return {store,d,desktop,identity,wake,adapter,bind,add,run,sends:()=>sends,status:v=>status=v,fail:()=>fail=true};
}
test('CodeArts rejects malformed model at binding before reading or sending',async t=>{
 const x=setup(t);let reads=0;
 const adapter={read:async()=>{reads++;return x.adapter.read();}};
 const wake=new Wake(x.desktop,{forProvider:()=>adapter});
 const input={provider:'qoder',threadId:'test-thread'};
 await assert.rejects(wake.bind(x.identity,{...input,model:'deepseek-v4-flash-0731'}),/provider\/model/);
 assert.equal(reads,0);assert.equal(x.sends(),0);
 await wake.bind(x.identity,input);assert.equal(reads,1);
});

test('wake binding rejects explicit provider auto before adapter selection',async t=>{
 const x=setup(t);let selected=false;
 const wake=new Wake(x.desktop,{forProvider:()=>{selected=true;throw Error('must not select');}});
 await assert.rejects(wake.bind(x.identity,{threadId:'thread',turnId:'turn'}),/explicit provider/);
 await assert.rejects(wake.bind(x.identity,{provider:'auto',threadId:'thread',turnId:'turn'}),/Provider auto is not allowed/);
 assert.equal(selected,false);
});

test('park does not poll models; sends once only after target idle, claim disarms',async t=>{
 const x=setup(t);await x.bind();assert.equal(x.wake.park(x.identity).parked,true);
 assert.match(x.store.state.projects[x.identity.projectId].bindings.worker.armedAt,/^\d{4}-/);
 x.add();x.d.tick();x.status('active');await x.wake.run();assert.equal(x.sends(),0);
 x.status('idle');await x.wake.run();await x.wake.run();assert.equal(x.sends(),1);assert.equal(x.run().wakeNotice.status,'sent');
 assert.ok(x.desktop.claim(x.identity));assert.equal(x.store.state.projects[x.identity.projectId].bindings.worker.armed,false);assert.equal(x.store.state.projects[x.identity.projectId].bindings.worker.armedAt,undefined);
});
test('lost acknowledgement never blindly resends; restart sending is reconciled',async t=>{
 const x=setup(t);await x.bind();x.wake.park(x.identity);x.add();x.d.tick();x.fail();await x.wake.run();await x.wake.run();assert.equal(x.sends(),1);assert.equal(x.run().wakeNotice.status,'uncertain');
 x.store.change(s=>{s.projects[x.identity.projectId].tasks.T.attempts.at(-1).wakeNotice.status='sending';});
 const marker=x.run().wakeNotice.marker;
 x.adapter.read=async()=>({thread:{status:{type:'idle'}},turns:[{items:[{type:'userMessage',content:[{text:marker}]}]}]});
 const restarted=new Wake(x.desktop,x.adapter);await restarted.run();assert.equal(x.run().wakeNotice.status,'sent');assert.equal(x.sends(),1);
});
test('binding workspace mismatch rejected, park with pending job returns it directly',async t=>{
 const x=setup(t);const old=x.adapter.read;x.adapter.read=async()=>({thread:{id:'test-thread',cwd:'X:/wrong'}});await assert.rejects(x.bind(),/workspace/);x.adapter.read=old;
 await x.bind();x.add();assert.ok(x.wake.park(x.identity).job);await x.wake.run();assert.equal(x.sends(),0);
});

test('submit tells a wake-bound worker to park and exposes real binding readiness',async t=>{
 const x=setup(t);await x.bind();x.add();
 const j=x.desktop.claim(x.identity);
 const result={projectId:j.projectId,taskId:j.taskId,attemptId:j.attemptId,role:'worker',status:'submitted',summary:'No file changes',checks:[],unverified:[]};
 const reply=x.desktop.submit(x.identity,{taskId:j.taskId,attemptId:j.attemptId,result});
 assert.equal(reply.nextAction,'park');assert.match(reply.nextInstruction,/实际调用 park/);
 assert.equal(x.desktop.status(x.identity).connections[0].wakeEnabled,true);
 assert.equal(x.desktop.status(x.identity).connections[0].armed,false);
 assert.equal(x.wake.park(x.identity).parked,true);
 assert.equal(x.desktop.status(x.identity).connections[0].armed,true);
 assert.equal(x.desktop.status(x.identity).connections[0].wakeState,'standby_authorized');
 assert.match(x.desktop.status(x.identity).connections[0].armedAt,/^\d{4}-/);
 await Promise.all([...x.d.active.values()].map(a=>a.promise));
});

// [AI-added] 2026-09-17 18:47: Cover the delivered-but-unclaimed repair wake gap.
test('an unclaimed task gets one automatic reminder and then becomes stalled',async t=>{
 const x=setup(t);await x.bind();assert.equal(x.wake.park(x.identity).parked,true);x.add();x.d.tick();
 const old=new Date(Date.now()-120000).toISOString();
 x.store.change(s=>{s.projects[x.identity.projectId].tasks.T.attempts.at(-1).wakeNotice={status:'sent',at:old,marker:'TASK-DISPATCH-WAKE:initial'};});
 await x.wake.run();assert.equal(x.sends(),1);assert.equal(x.run().wakeNotice.reminder.status,'sent');assert.equal(x.run().wakeNotice.claimStatus,'reminded');
 x.store.change(s=>{s.projects[x.identity.projectId].tasks.T.attempts.at(-1).wakeNotice.reminder.at=old;});
 await x.wake.run();await x.wake.run();assert.equal(x.sends(),1);assert.equal(x.run().wakeNotice.claimStatus,'stalled');assert.match(x.run().wakeNotice.error,/unclaimed/);
});

// [AI-added] 2026-09-19: A reminder whose marker never shows up must not be resent on every tick,
// and the grace anchor must stay on the first attempt so the escalation still fires.
test('an unconfirmed reminder is not resent and the grace anchor never moves',async t=>{
 const x=setup(t);await x.bind();x.wake.park(x.identity);x.add();x.d.tick();
 const old=new Date(Date.now()-120000).toISOString();
 x.store.change(s=>{s.projects[x.identity.projectId].tasks.T.attempts.at(-1).wakeNotice={status:'sent',at:old,marker:'TASK-DISPATCH-WAKE:initial'};});
 await x.wake.run();assert.equal(x.sends(),1);assert.equal(x.run().wakeNotice.reminder.status,'sent');
 const anchored=x.run().wakeNotice.reminder.at;
 await x.wake.run();await x.wake.run();await x.wake.run();
 assert.equal(x.sends(),1);assert.equal(x.run().wakeNotice.reminder.at,anchored);assert.equal(x.run().wakeNotice.claimStatus,'reminded');
 x.store.change(s=>{s.projects[x.identity.projectId].tasks.T.attempts.at(-1).wakeNotice.reminder.at=old;});
 await x.wake.run();assert.equal(x.sends(),1);assert.equal(x.run().wakeNotice.claimStatus,'stalled');
});

// [AI-added] 2026-09-19: A host that acknowledges but never records the reminder must surface an
// actionable stall reason instead of retrying forever.
test('a reminder the host never recorded stalls with an actionable reason',async t=>{
 const x=setup(t);await x.bind();x.wake.park(x.identity);x.add();x.d.tick();
 const old=new Date(Date.now()-120000).toISOString();
 x.store.change(s=>{s.projects[x.identity.projectId].tasks.T.attempts.at(-1).wakeNotice={status:'sent',at:old,marker:'TASK-DISPATCH-WAKE:initial'};});
 x.fail();
 await x.wake.run();assert.equal(x.run().wakeNotice.reminder.status,'uncertain');assert.match(x.run().wakeNotice.reminder.error,/lost ack/);
 x.store.change(s=>{s.projects[x.identity.projectId].tasks.T.attempts.at(-1).wakeNotice.reminder.lastAttemptAt=old;});
 await x.wake.run();assert.equal(x.sends(),1);assert.equal(x.run().wakeNotice.claimStatus,'stalled');
 assert.match(x.run().wakeNotice.error,/never appeared in its session history/);
});

// [AI-added] 2026-09-17 20:23: A hung host API call must not retain Wake.busy forever.
test('hung host reads time out and a later cycle can deliver the same attempt',async t=>{
 const x=setup(t);await x.bind();x.wake.park(x.identity);x.add();x.d.tick();const healthy=x.adapter.read;x.wake.readTimeoutMs=20;x.adapter.read=()=>new Promise(()=>{});
 await x.wake.run();assert.match(x.run().wakeNotice.error,/Host read timed out/);assert.equal(x.sends(),0);
 x.adapter.read=healthy;await x.wake.run();assert.equal(x.sends(),1);assert.equal(x.run().wakeNotice.status,'sent');
});

// [AI-added] 2026-09-17 20:23: A timed-out send is uncertain and never blindly repeated.
test('hung host sends time out as uncertain without freezing later wake ticks',async t=>{
 const x=setup(t);await x.bind();x.wake.park(x.identity);x.add();x.d.tick();x.wake.sendTimeoutMs=20;x.adapter.send=()=>new Promise(()=>{});
 await x.wake.run();assert.equal(x.run().wakeNotice.status,'uncertain');assert.match(x.run().wakeNotice.error,/Host send timed out/);
 await x.wake.run();assert.equal(x.run().wakeNotice.status,'uncertain');
});

test('reachable MiMo reviewer stays online and a transient wrong-workspace read does not revoke ownership',async t=>{
 const x=setup(t);
 x.desktop.attach({workspace:x.store.state.projects[x.identity.projectId].workspace,role:'reviewer',clientId:'reviewer123',token:'b'.repeat(64),sessionId:'mimo-reviewer'});
 const identity=x.desktop.authenticate('b'.repeat(64));
 let cwd=x.store.state.projects[identity.projectId].workspace;
 const adapter={read:async()=>({thread:{id:'mimo-reviewer',cwd,reachable:true,status:{type:'unknown'}},turns:[]})};
 const wake=new Wake(x.desktop,{forProvider:()=>adapter});
 await wake.bind(identity,{provider:'mimo',threadId:'mimo-reviewer',model:'test/model'});
 assert.equal(wake.park(identity).parked,true);
 const pre=require('../runtime/core/pre-review.cjs');
 x.d.reviewerPresence.get(identity.projectId).at=0;
 await wake.run();assert.equal(pre.online(x.d,x.store.state.projects[identity.projectId]),true);
 x.d.reviewerPresence.get(identity.projectId).at=0;cwd='X:/wrong';
 await wake.run();assert.equal(pre.online(x.d,x.store.state.projects[identity.projectId]),true);
});
