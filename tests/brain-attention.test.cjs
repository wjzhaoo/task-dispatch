const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {Store}=require('../runtime/core/storage.cjs');
const {Dispatcher}=require('../runtime/core/dispatcher.cjs');
const {Desktop}=require('../runtime/core/desktop.cjs');
const {Wake}=require('../runtime/core/wake.cjs');
const {Monitor}=require('../runtime/core/monitor.cjs');
const attention=require('../runtime/core/brain-attention.cjs');
function setup(t){
 fs.mkdirSync(path.resolve('tmp'),{recursive:true});
 const root=fs.mkdtempSync(path.resolve('tmp/attention-test-')),workspace=path.join(root,'work');fs.mkdirSync(workspace);
 const store=new Store(path.join(root,'data'));
 t.after(async()=>{await Promise.allSettled([...d.active.values()].map(entry=>entry.promise));store.close();fs.rmSync(root,{recursive:true,force:true});});
 const d=new Dispatcher(store,{maxConcurrent:2});
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

test('a blocked receipt wakes the brain and cannot be acknowledged until actually handled',async t=>{
 const x=setup(t);
 await x.wake.bind(x.brain,{provider:'codex',threadId:'brain-thread',turnId:'turn'});
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
 assert.throws(()=>attention.acknowledge(x.desktop,x.brain,{taskId:'T',alertId:x.task().attention.id}),/任务仍然阻塞/);
 assert.equal(x.wake.park(x.brain).job.kind,'task_attention');
 x.d.retry(x.worker.projectId,'T',false);
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
 await x.wake.bind(x.brain,{provider:'codex',threadId:'brain-thread',turnId:'turn'});
 assert.equal(x.wake.park(x.brain).parked,true);
 x.add();
 await x.claimWorkerSubmit(blockedReceipt('missing precondition'));
 await x.wake.run();
 assert.equal(x.sends(),1);
 assert.equal(x.task().attention.wakeNotice.status,'sent');
 await x.wake.run();
 assert.equal(x.sends(),1);
 attention.acknowledge(x.desktop,x.brain,{taskId:'T',alertId:x.task().attention.id,waitReason:'需要用户提供缺失的外部凭据'});
 assert.equal(attention.job(x.project()),null);
 await x.wake.run();assert.equal(x.sends(),1);
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

test('explicit user decisions remain visible as waiting-user alerts after deferral',async t=>{
 const x=setup(t);
 await x.wake.bind(x.brain,{provider:'codex',threadId:'brain-thread',turnId:'turn'});
 const monitor=new Monitor(x.store,x.d,x.wake);
 x.add();
 await x.claimWorkerSubmit(blockedReceipt('needs brain decision'));
 let alerts=monitor.snapshot().projects.find(p=>p.id===x.worker.projectId).alerts;
 assert.ok(alerts.some(a=>a.code==='task_attention'&&/needs brain decision/.test(a.message)));
 attention.acknowledge(x.desktop,x.brain,{taskId:'T',alertId:x.task().attention.id,waitReason:'请用户选择兼容旧格式还是迁移现有数据'});
 const snapshot=monitor.snapshot().projects.find(p=>p.id===x.worker.projectId);alerts=snapshot.alerts;
 assert.ok(!alerts.some(a=>a.code==='task_attention'));
 assert.ok(alerts.some(a=>a.code==='waiting_user'&&/迁移现有数据/.test(a.message)));
 assert.equal(snapshot.tasks.find(t=>t.id==='T').attention.waitReason,'请用户选择兼容旧格式还是迁移现有数据');
 assert.equal(x.wake.park(x.brain).parked,true);
 monitor.close();
});


test('legacy acknowledgements of unresolved blocks reopen with a new wake marker exactly once',async t=>{
 const x=setup(t);
 await x.wake.bind(x.brain,{provider:'codex',threadId:'brain-thread',turnId:'turn'});
 x.add();await x.claimWorkerSubmit(blockedReceipt('reviewer wrote nul'));
 await x.wake.run();assert.equal(x.sends(),1);
 const previous=x.task().attention.id;
 x.store.change(s=>{s.projects[x.worker.projectId].tasks.T.attention.acknowledged=true;});
 const monitor=new Monitor(x.store,x.d,x.wake);t.after(()=>monitor.close());
 assert.ok(monitor.snapshot().projects[0].alerts.some(a=>a.code==='task_attention'));
 await x.wake.run();
 assert.notEqual(x.task().attention.id,previous);
 assert.equal(x.task().attention.reopenedFrom,previous);
 assert.equal(x.task().attention.acknowledged,undefined);
 assert.equal(x.sends(),2);
 await x.wake.run();assert.equal(x.sends(),2);
 assert.equal(x.wake.park(x.brain).job.kind,'task_attention');
});

test('deferral requires a concrete bounded waiting reason and clears after real recovery',async t=>{
 const x=setup(t);x.add();await x.claimWorkerSubmit(blockedReceipt('missing access'));
 const input={taskId:'T',alertId:x.task().attention.id};
 for(const waitReason of ['', '   ', 'x'.repeat(2001), true])assert.throws(()=>attention.acknowledge(x.desktop,x.brain,{...input,waitReason}),/任务仍然阻塞/);
 attention.acknowledge(x.desktop,x.brain,{...input,waitReason:'等待用户提供测试环境访问权限'});
 assert.equal(attention.job(x.project()),null);
 x.d.retry(x.worker.projectId,'T',false);
 attention.acknowledge(x.desktop,x.brain,input);
 assert.equal(x.task().attention.waitReason,undefined);
 assert.ok(x.task().attention.resolvedAt);
 assert.ok(x.store.state.events.some(e=>e.type==='task_attention_deferred'));
 assert.ok(x.store.state.events.some(e=>e.type==='task_attention_resolved'));
});
