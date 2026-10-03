// [AI-added] 2026-09-22 09:20: Fault injection verifies durable, same-attempt recovery.
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store,atomic,StorageWriteError}=require('../runtime/core/storage.cjs');
const {Dispatcher}=require('../runtime/core/dispatcher.cjs');
const {Desktop}=require('../runtime/core/desktop.cjs');
function root(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'storage-recovery-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
async function review(t,withEvidence=false){
 const dir=root(t),workspace=path.join(dir,'work');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'README.md'),'candidate');
 if(withEvidence){
  fs.mkdirSync(path.join(workspace,'node_modules'));
  fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({scripts:{check:'node check.cjs'}}));fs.writeFileSync(path.join(workspace,'package-lock.json'),'{}');
  fs.writeFileSync(path.join(workspace,'check.cjs'),"// [AI-added] 2026-09-22 09:20\nconst fs=require('fs');fs.writeFileSync('tmp/result.json',JSON.stringify({version:1,checks:[{id:'complete',passed:true,errors:[]}]}));");
 }
 const store=new Store(path.join(dir,'service'));t.after(()=>store.close());
 const d=new Dispatcher(store,{enableRealCalls:false},()=>{throw Error('No model calls allowed');}),desktop=new Desktop(d);
 d.addProject({id:'p',workspace,mode:'desktop'});
 desktop.attach({workspace,role:'brain',clientId:'brain-client',token:'a'.repeat(64)});const identity=require('./stage-fixture.cjs').peers(desktop,'p').reviewer;
 store.change(s=>{s.projects.p.startup={state:'started'};});
 d.addTask('p',{id:'T',title:'review',instructions:'review',acceptance:'correct',allowedPaths:['README.md']});
 if(withEvidence)d.configureValidation('p',{dependencies:'copy-node-modules',checks:[['run','check']],evidenceResult:'tmp/result.json'});
 d.pause('p',true);require('./stage-fixture.cjs').begin(d,'p');
 const a=d.createSnapshot(workspace);
 store.change(s=>Object.assign(s.projects.p.tasks.T,{state:'review_ready',artifactId:a.id,artifactHash:a.hash,changedFiles:[],attempts:[{id:'worker-0',role:'worker',settled:true,baselineId:a.id}]}));
 await d.execute('p','T');d.pause('p',false);const job=desktop.claim(identity);d.pause('p',true);
 const result={projectId:'p',taskId:'T',attemptId:job.attemptId,role:'reviewer',artifactId:a.id,verdict:'pass',summary:'verified',findings:[]};
 return {dir,workspace,store,d,desktop,identity,job,result};
}
function failRename(t,file,predicate=()=>true,code='EPERM'){
 const original=fs.renameSync;let calls=0;
 t.mock.method(fs,'renameSync',(from,to)=>{if(to===file&&predicate(++calls))throw Object.assign(Error('injected '+code),{code});return original(from,to);});
 return ()=>calls;
}
test('atomic contention retries only rename; permanent failure preserves target and unpublished state',t=>{
 const dir=root(t),file=path.join(dir,'state.json');atomic(file,{old:true});let attempts=0,waited=0;
 const io={...fs,renameSync:(from,to)=>{if(++attempts===1)throw Object.assign(Error('busy'),{code:'EBUSY'});fs.renameSync(from,to);}};
 atomic(file,{new:true},{io,wait:ms=>waited+=ms});assert.equal(attempts,2);assert.equal(waited,20);assert.deepEqual(JSON.parse(fs.readFileSync(file)),{new:true});
 const broken={...fs,renameSync:()=>{throw Object.assign(Error('permission'),{code:'EACCES'});}};
 assert.throws(()=>atomic(file,{bad:true},{io:broken,wait:()=>assert.fail('must not retry')}),e=>e instanceof StorageWriteError&&!e.retryable);
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),{new:true});
 const store=new Store(path.join(dir,'service'));t.after(()=>store.close());const before=JSON.stringify(store.state);
 failRename(t,store.file,()=>true,'ENOSPC');assert.throws(()=>store.change(s=>s.revision=500),StorageWriteError);
 assert.equal(JSON.stringify(store.state),before);assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(store.file))),before);
});
test('durable review receipt recovers once without repeating review or accepting conflicting submission',async t=>{
 const x=await review(t,true),count=x.store.state.projects.p.tasks.T.attempts.length;
 assert.equal(x.store.state.projects.p.tasks.T.attempts.at(-1).validation.passed,true);
 assert.equal(x.desktop.preflight(x.identity,{taskId:'T',attemptId:x.job.attemptId}).ok,true);
 assert.equal(fs.existsSync(path.join(x.workspace,'tmp')),false);
 failRename(t,x.store.file,n=>n<=4);
 const submitted=x.desktop.submit(x.identity,{taskId:'T',attemptId:x.job.attemptId,result:x.result});
 assert.equal(submitted.ok,false);assert.equal(submitted.receiptPersisted,true);assert.equal(submitted.settlementPending,true);
 assert.equal(x.store.state.projects.p.tasks.T.state,'reviewing');assert.equal(x.desktop.claim(x.identity),null);
 assert.throws(()=>x.desktop.submit(x.identity,{taskId:'T',attemptId:x.job.attemptId,result:{...x.result,summary:'different'}}),/Conflicting durable receipt/);
 x.d.pendingSettlements.get(x.job.attemptId).nextAt=0;x.d.tick();
 assert.equal(x.store.state.projects.p.tasks.T.state,'review_ready');assert.equal(x.store.state.projects.p.tasks.T.attempts.length,count);
 assert.equal(x.d.pendingSettlements.size,0);x.d.tick();x.d.recover();
 assert.equal(x.store.state.events.filter(e=>e.type==='review_decision').length,1);
 assert.equal(x.store.state.events.filter(e=>e.type==='settlement_recovered').length,1);
 assert.equal(x.desktop.submit(x.identity,{taskId:'T',attemptId:x.job.attemptId,result:x.result}).duplicate,true);
});
test('persistent contention exhausts bounded recovery and restart replays the same receipt',async t=>{
 const x=await review(t);const count=x.store.state.projects.p.tasks.T.attempts.length,before=JSON.stringify(x.store.state);
 const calls=failRename(t,x.store.file);
 x.desktop.submit(x.identity,{taskId:'T',attemptId:x.job.attemptId,result:x.result});
 for(let n=0;n<3;n++){x.d.pendingSettlements.get(x.job.attemptId).nextAt=0;x.d.tick();}
 const status=x.desktop.status(x.identity).storageRecovery[0];assert.equal(status.exhausted,true);assert.equal(status.retries,3);
 const saved=calls();for(let n=0;n<5;n++)x.d.tick();assert.equal(calls(),saved);
 assert.equal(JSON.stringify(x.store.state),before);assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(x.store.file))),before);
 assert.equal(x.store.state.projects.p.tasks.T.attempts.length,count);
 t.mock.restoreAll();x.store.close();
 const restored=new Store(x.store.root);t.after(()=>restored.close());const resumed=new Dispatcher(restored,{enableRealCalls:false},()=>assert.fail('model restart'));
 resumed.recover();resumed.recover();assert.equal(restored.state.projects.p.tasks.T.state,'review_ready');
 assert.equal(restored.state.events.filter(e=>e.type==='review_decision').length,1);assert.equal(restored.state.projects.p.tasks.T.attempts.length,count);
});
test('replayed receipt still rejects changed workspace and malformed identity',async t=>{
 for(const kind of ['workspace','identity']){
  const x=await review(t);failRename(t,x.store.file,n=>n<=4);
  x.desktop.submit(x.identity,{taskId:'T',attemptId:x.job.attemptId,result:x.result});t.mock.restoreAll();
  if(kind==='workspace')fs.writeFileSync(path.join(x.workspace,'README.md'),'drift');
  else {const f=x.d.receiptPath(x.job.attemptId),r=JSON.parse(fs.readFileSync(f));r.role='worker';fs.writeFileSync(f,JSON.stringify(r));}
  x.d.pendingSettlements.get(x.job.attemptId).nextAt=0;x.d.tick();
  assert.equal(x.store.state.projects.p.tasks.T.state,'blocked');assert.equal(x.store.state.events.filter(e=>e.type==='review_decision').length,0);
 }
});
test('permanent storage errors do not auto retry or report accepted',async t=>{
 const x=await review(t);failRename(t,x.store.file,()=>true,'ENOSPC');
 assert.equal(x.desktop.submit(x.identity,{taskId:'T',attemptId:x.job.attemptId,result:x.result}).ok,false);
 assert.equal(x.d.settlementStatus('p')[0].exhausted,true);assert.equal(x.d.settlementStatus('p')[0].retryable,false);
 assert.equal(x.store.state.projects.p.tasks.T.state,'reviewing');
});
// [AI-added] 2026-09-22 09:20: A verdict commit and its attention notification are separate durable writes.
test('post-commit attention failure restores notification without duplicating the verdict',async t=>{
 const x=await review(t);x.store.change(s=>{s.projects.p.tasks.T.attention={id:'old',acknowledged:true};});
 failRename(t,x.store.file,n=>n>=2&&n<=5);
 const result={...x.result,verdict:'blocked',summary:'Missing prerequisite'};
 assert.equal(x.desktop.submit(x.identity,{taskId:'T',attemptId:x.job.attemptId,result}).settlementPending,true);
 assert.equal(x.store.state.projects.p.tasks.T.state,'blocked');assert.equal(x.store.state.projects.p.tasks.T.attention.id,'old');
 x.d.pendingSettlements.get(x.job.attemptId).nextAt=0;x.d.tick();
 assert.equal(x.d.pendingSettlements.size,0);assert.notEqual(x.store.state.projects.p.tasks.T.attention.id,'old');
 assert.equal(x.store.state.events.filter(e=>e.type==='review_decision').length,1);assert.equal(x.store.state.events.filter(e=>e.type==='task_attention').length,1);
});
test('restart restores a missing post-commit alert but does not repeat an acknowledged current alert',async t=>{
 const x=await review(t);failRename(t,x.store.file,n=>n>=2&&n<=5);
 x.desktop.submit(x.identity,{taskId:'T',attemptId:x.job.attemptId,result:{...x.result,verdict:'blocked',summary:'Missing prerequisite'}});
 t.mock.restoreAll();x.store.close();const store=new Store(x.store.root);t.after(()=>store.close());
 const d=new Dispatcher(store,{enableRealCalls:false},()=>assert.fail('model restart'));d.recover();
 assert.equal(store.state.projects.p.tasks.T.state,'blocked');assert.ok(store.state.projects.p.tasks.T.attention);
 store.change(s=>s.projects.p.tasks.T.attention.acknowledged=true);d.recover();
 assert.equal(store.state.events.filter(e=>e.type==='review_decision').length,1);assert.equal(store.state.events.filter(e=>e.type==='task_attention').length,1);
});
