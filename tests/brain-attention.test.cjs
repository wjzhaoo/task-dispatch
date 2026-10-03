const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../runtime/core/storage.cjs');
const {Dispatcher}=require('../runtime/core/dispatcher.cjs');
const {Desktop}=require('../runtime/core/desktop.cjs');
const {Wake}=require('../runtime/core/wake.cjs');
const {Monitor}=require('../runtime/core/monitor.cjs');
const attention=require('../runtime/core/brain-attention.cjs');
function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'attention-test-')),workspace=path.join(root,'work');fs.mkdirSync(workspace);
 const store=new Store(path.join(root,'data'));t.after(()=>store.close());
 const d=new Dispatcher(store,{enableRealCalls:false},()=>{throw Error('no model');});
 const desktop=new Desktop(d);
 desktop.attach({workspace,role:'worker',clientId:'worker123',token:'a'.repeat(64)});
 desktop.attach({workspace,role:'brain',clientId:'brain123',token:'b'.repeat(64)});
 store.change(s=>{for(const p of Object.values(s.projects))p.startup={state:'started'};});
 const worker=desktop.authenticate('a'.repeat(64)),brain=desktop.authenticate('b'.repeat(64));
 let sends=0;
 const adapter={read:async()=>({thread:{id:'brain-thread',cwd:workspace,status:{type:'idle'}},turns:[]}),send:async()=>{sends++;return {};}};
 const wake=new Wake(desktop,adapter);
 const add=()=>{d.addTask(worker.projectId,{id:'T',title:'t',instructions:'i',acceptance:'a',allowedPaths:['README.md']});require('./stage-fixture.cjs').begin(d);};
 const project=()=>store.state.projects[worker.projectId];
 const task=()=>project().tasks.T;
 const run=()=>task().attempts.at(-1);
 // submit's internal tick cannot dispatch the next attempt until the previous execute's
 // finally cleanup (a microtask) runs; flush so the following claim sees a clean scheduler.
 const settle=async()=>new Promise(r=>setImmediate(r));
 const claimWorkerSubmit=async submit=>{await settle();d.tick();const j=desktop.claim(worker);assert.ok(j,'worker claim returned null');desktop.submit(worker,{taskId:j.taskId,attemptId:j.attemptId,result:{projectId:j.projectId,taskId:j.taskId,attemptId:j.attemptId,role:'worker',...submit}});await settle();return j;};
 const reviewer=require('./stage-fixture.cjs').peers(desktop,brain.projectId).reviewer;
 const reviewSubmit=(j,verdict,extra={})=>desktop.submit(reviewer,{taskId:j.taskId,attemptId:j.attemptId,result:{projectId:j.projectId,taskId:j.taskId,attemptId:j.attemptId,role:'reviewer',artifactId:j.artifactId,verdict,summary:'review '+verdict,findings:verdict==='needs_fix'?[{key:'k',message:'m'}]:[],...extra}});
 return {store,d,desktop,wake,adapter,worker,brain,reviewer,add,project,task,run,sends:()=>sends,settle,claimWorkerSubmit,reviewSubmit};
}
const blockedReceipt=summary=>({status:'blocked',summary,checks:[],unverified:[]});
const okReceipt=()=>({status:'submitted',summary:'done',checks:[],unverified:[]});

test('a plain worker blocked receipt raises task_attention, arms brain wake and acks',async t=>{
 const x=setup(t);
 await x.wake.bind(x.brain,{provider:'codex',threadId:'brain-thread',turnId:'turn',experimentalAcknowledged:true});
 assert.equal(x.wake.park(x.brain).parked,true);
 x.add();
 await x.claimWorkerSubmit(blockedReceipt('contract conflict: save format changed'));
 assert.equal(x.task().state,'blocked');
 assert.equal(x.task().attention.kind,'blocked');
 assert.match(x.task().attention.message,/contract conflict/);
 assert.equal(x.project().bindings.brain.armed,true);
 assert.ok(x.store.state.events.some(e=>e.type==='task_attention'&&e.wake===true&&e.taskId==='T'));
 const job=x.desktop.claim(x.brain);
 assert.equal(job.kind,'task_attention');
 assert.equal(job.alertId,x.task().attention.id);
 assert.match(job.prompt,/attention-ack/);
 assert.throws(()=>attention.acknowledge(x.desktop,x.worker,{taskId:'T',alertId:x.task().attention.id}),/Only brain/);
 assert.throws(()=>attention.acknowledge(x.desktop,x.brain,{taskId:'T',alertId:'stale'}),/Stale/);
 attention.acknowledge(x.desktop,x.brain,{taskId:'T',alertId:x.task().attention.id});
 assert.equal(x.task().attention.acknowledged,true);
 assert.equal(attention.job(x.project()),null);
 attention.acknowledge(x.desktop,x.brain,{taskId:'T',alertId:x.task().attention.id});
});

test('a submitted worker receipt and auto-repair needs_fix never raise attention',async t=>{
 const x=setup(t);
 x.add();
 await x.claimWorkerSubmit(okReceipt());
 assert.ok(['review_ready','reviewing'].includes(x.task().state));
 assert.equal(x.task().attention,undefined);
 let j=x.desktop.claim(x.reviewer);
 assert.equal(j.role,'reviewer');
 x.reviewSubmit(j,'needs_fix');
 assert.ok(['ready','running'].includes(x.task().state));
 assert.equal(x.task().repairs,1);
 assert.equal(x.task().attention,undefined);
 await x.claimWorkerSubmit(okReceipt());
 j=x.desktop.claim(x.reviewer);
 x.reviewSubmit(j,'blocked',{blockKind:'review'});
 assert.equal(x.task().state,'blocked');
 assert.ok(x.task().attention);
 assert.ok(x.store.state.events.some(e=>e.type==='task_attention'&&e.taskId==='T'));
});

test('attention stays claimable while another task is uncertain; brain without wake records wake:false',async t=>{
 const x=setup(t);
 x.d.addTask(x.worker.projectId,{id:'T2',title:'t2',instructions:'i',acceptance:'a',allowedPaths:['README.md']});x.add();
 x.store.change(s=>{const q=s.projects[x.worker.projectId].tasks.T;q.state='blocked';q.error='boom';});
 attention.raise(x.d,x.worker.projectId,'T','boom');
 x.store.change(s=>{s.projects[x.worker.projectId].tasks.T2.state='uncertain';});
 assert.ok(x.store.state.events.some(e=>e.type==='task_attention'&&e.wake===false));
 // Without the gate bypass the uncertain task would make the attention permanently unclaimable.
 const job=x.desktop.claim(x.brain);
 assert.equal(job.kind,'task_attention');
});

test('attentionNotice sends one wake to the parked brain and never resends',async t=>{
 const x=setup(t);
 await x.wake.bind(x.brain,{provider:'codex',threadId:'brain-thread',turnId:'turn',experimentalAcknowledged:true});
 assert.equal(x.wake.park(x.brain).parked,true);
 x.add();
 await x.claimWorkerSubmit(blockedReceipt('missing precondition'));
 await x.wake.run();
 assert.equal(x.sends(),1);
 assert.equal(x.task().attention.wakeNotice.status,'sent');
 await x.wake.run();
 assert.equal(x.sends(),1);
 attention.acknowledge(x.desktop,x.brain,{taskId:'T',alertId:x.task().attention.id});
 assert.equal(attention.job(x.project()),null);
});

test('operator retry settles the attention and a later ack stays idempotent',async t=>{
 const x=setup(t);
 x.add();
 x.store.change(s=>{const q=s.projects[x.worker.projectId].tasks.T;q.state='blocked';q.error='boom';});
 attention.raise(x.d,x.worker.projectId,'T','boom');
 await x.settle();x.d.retry(x.worker.projectId,'T',false);
 assert.equal(x.task().state,'ready');
 assert.equal(x.task().attention.acknowledged,true);
 assert.equal(attention.acknowledge(x.desktop,x.brain,{taskId:'T',alertId:x.task().attention.id}).ok,true);
});

test('wait-mode attempts do not break monitor capture; silence raises wait alerts',async t=>{
 const x=setup(t);
 const monitor=new Monitor(x.store,x.d,x.wake);
 x.add();x.d.tick();
 await Promise.all([...x.d.active.values()].map(a=>a.promise));
 // No wake binding on the worker: the attempt has no wakeNotice, which used to throw inside capture.
 x.store.change(s=>{});
 assert.equal(x.store.observationError,undefined);
 const id=`${x.worker.projectId}/worker/worker123`;
 monitor.contacts.set(id,{lastRequestAt:new Date(Date.now()-700000).toISOString(),action:'wait',status:200});
 let alerts=monitor.snapshot().projects.find(p=>p.id===x.worker.projectId).alerts;
 assert.ok(alerts.some(a=>a.code==='wait_stalled'));
 assert.ok(!alerts.some(a=>a.code==='claim_stalled'||a.code==='unclaimed'));
 x.store.change(s=>{const q=s.projects[x.worker.projectId].tasks.T;q.state='blocked';q.attempts.at(-1).settled=true;});
 alerts=monitor.snapshot().projects.find(p=>p.id===x.worker.projectId).alerts;
 assert.ok(alerts.some(a=>a.code==='connection_silent'));
 assert.ok(!alerts.some(a=>a.code==='wait_stalled'));
 monitor.close();
});

test('unacknowledged attention shows as a monitor alert until acked',async t=>{
 const x=setup(t);
 const monitor=new Monitor(x.store,x.d,x.wake);
 x.add();
 await x.claimWorkerSubmit(blockedReceipt('needs brain decision'));
 let alerts=monitor.snapshot().projects.find(p=>p.id===x.worker.projectId).alerts;
 assert.ok(alerts.some(a=>a.code==='task_attention'&&/needs brain decision/.test(a.message)));
 attention.acknowledge(x.desktop,x.brain,{taskId:'T',alertId:x.task().attention.id});
 alerts=monitor.snapshot().projects.find(p=>p.id===x.worker.projectId).alerts;
 assert.ok(!alerts.some(a=>a.code==='task_attention'));
 monitor.close();
});
