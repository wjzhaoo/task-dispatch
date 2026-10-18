'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {initialize,request}=require('../runtime/wizard.cjs');
const {serve}=require('./service-fixture.cjs');
const {call}=require('../runtime/desktop-client.cjs');
const {Store,atomic}=require('../runtime/core/storage.cjs');
const invitations=require('../runtime/core/rebind-invitations.cjs');
const handover=require('../runtime/core/handover.cjs');
const cli=path.resolve('runtime/desktop-client.cjs');
const execFile=require('node:util').promisify(require('node:child_process').execFile);

async function fixture(t){
  fs.mkdirSync(path.resolve('tmp'),{recursive:true});
  const dir=fs.mkdtempSync(path.resolve('tmp/connection-lifecycle-')),root=path.join(dir,'data'),workspace=path.join(dir,'work');
  fs.mkdirSync(workspace);initialize(root);
  const calls=[],adapter={forProvider:provider=>({verify:async b=>{calls.push({provider,...b});return {thread:{id:b.threadId,cwd:workspace},model:'fixture/model'};},read:async b=>({thread:{id:b.threadId,cwd:workspace,status:{type:'active'}}})})};
  const service=await serve(root,{wakeAdapter:adapter});
  t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  return {dir,root,workspace,service,calls,adapter};
}
const input=(x,extra={})=>({action:'connect',workspace:x.workspace,role:'worker',workerId:'strong',capabilities:['strong'],provider:'qoder',sessionId:crypto.randomUUID(),clientId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex'),...extra});
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out waiting for subscription');}
function hold(x,projectId){x.service.dispatcher.active.set(projectId,{controller:new AbortController(),promise:Promise.resolve()});return()=>x.service.dispatcher.active.delete(projectId);}

test('pending connect retries reuse verified configuration; resume waits once and parks the named worker',async t=>{
  const x=await fixture(t),old=input(x),first=await request(x.root,old),release=hold(x,first.projectId);t.after(release);
  const invitation=invitations.create(x.service.store,x.root,{projectId:first.projectId,binding:'worker:strong',clientId:old.clientId});
  const next=input(x,{replaceClientId:old.clientId,managedRebind:true,rebindInvitationId:invitation.invitationId});
  const pending=await request(x.root,next);assert.equal(pending.handoverPending,true);assert.equal(pending.nextAction,'resume');
  const state=fs.readFileSync(path.join(x.root,'state.json')),revision=x.service.store.state.revision;
  assert.equal((await request(x.root,next)).handoverPending,true);assert.equal(x.calls.length,2);
  assert.deepEqual(fs.readFileSync(path.join(x.root,'state.json')),state);
  for(const action of ['status','claim','submit','wait'])await assert.rejects(call(x.root,next,{action}),/Invalid desktop token/);
  const idle=await call(x.root,next,{action:'resume',handoverTimeoutMs:0});assert.equal(idle.handoverPending,true);
  assert.equal(Object.hasOwn(idle,'projects'),false);assert.equal(JSON.stringify(idle).includes(old.token),false);
  await assert.rejects(call(x.root,next,{action:'resume',handoverTimeoutMs:20001}),/0\.\.20000/);
  const count=x.service.monitor.listenerCount('change'),waiting=call(x.root,next,{action:'resume',handoverTimeoutMs:5000});
  await until(()=>x.service.monitor.listenerCount('change')>count);
  assert.equal(x.service.store.state.revision,revision);
  await assert.rejects(call(x.root,next,{action:'resume',handoverTimeoutMs:0}),/已有本会话的 resume/);
  release();handover.finish(x.service.dispatcher,first.projectId);
  assert.equal(x.service.store.state.revision,revision+1,'binding and invitation finish in one commit');
  const resumed=await waiting;assert.equal(resumed.attached,true);assert.equal(resumed.parked,true);assert.equal(resumed.provider,'qoder');
  assert.equal(x.calls.length,2);assert.equal(x.service.monitor.listenerCount('change'),count);
  const p=x.service.store.state.projects[first.projectId],binding=p.bindings['worker:strong'];
  assert.equal(binding.wake.threadId,next.sessionId);assert.equal(binding.provider,'qoder');assert.equal(binding.armed,true);
  assert.equal(p.rebindInvitations[invitation.invitationId].status,'completed');
  assert.equal(p.tasks && Object.keys(p.tasks).length,0);await assert.rejects(call(x.root,old,{action:'status'}),/Invalid desktop token/);
});

test('pending configuration survives isolated service restart without a second host verification',async t=>{
  const x=await fixture(t),old=input(x),first=await request(x.root,old),release=hold(x,first.projectId);
  const next=input(x,{replaceClientId:old.clientId}),pending=await request(x.root,next);assert.equal(pending.handoverPending,true);
  const file=path.join(x.dir,'pending.json');atomic(file,{...next,projectId:first.projectId,data:x.root});
  release();await x.service.close();
  const restarted=await serve(x.root,{wakeAdapter:x.adapter});t.after(()=>restarted.close());
  const result=JSON.parse((await execFile(process.execPath,[cli,'resume','--credential',file,'--seconds','5'],{windowsHide:true})).stdout);
  assert.equal(result.parked,true);assert.equal(result.attached,true);assert.equal(x.calls.length,2);
  assert.equal(restarted.store.state.projects[first.projectId].bindings['worker:strong'].wake.threadId,next.sessionId);
  await restarted.close();
});

test('cancelling a pending rebind wakes its resume with a concrete error and revokes the pending token',async t=>{
  const x=await fixture(t),old=input(x),first=await request(x.root,old),release=hold(x,first.projectId);t.after(release);
  const invite=invitations.create(x.service.store,x.root,{projectId:first.projectId,binding:'worker:strong',clientId:old.clientId});
  const next=input(x,{replaceClientId:old.clientId,managedRebind:true,rebindInvitationId:invite.invitationId});await request(x.root,next);
  const count=x.service.monitor.listenerCount('change'),waiting=assert.rejects(call(x.root,next,{action:'resume',handoverTimeoutMs:5000}),/cancelled or replaced/);
  await until(()=>x.service.monitor.listenerCount('change')>count);
  invitations.cancel(x.service.store,first.projectId,invite.invitationId);await waiting;
  assert.equal(x.service.monitor.listenerCount('change'),count);assert.equal(x.service.store.state.projects[first.projectId].bindings['worker:strong'].clientId,old.clientId);
  await assert.rejects(call(x.root,next,{action:'resume',handoverTimeoutMs:0}),/Invalid desktop token/);
});

test('aborted handover resume removes listeners and leaves ownership and state untouched',async t=>{
  const x=await fixture(t),old=input(x),first=await request(x.root,old),release=hold(x,first.projectId);t.after(release);
  const next=input(x,{replaceClientId:old.clientId});await request(x.root,next);
  const before=fs.readFileSync(path.join(x.root,'state.json')),count=x.service.monitor.listenerCount('change'),controller=new AbortController();
  const waiting=assert.rejects(call(x.root,next,{action:'resume',handoverTimeoutMs:5000},controller.signal),/abort/i);
  await until(()=>x.service.monitor.listenerCount('change')>count);controller.abort();await waiting;
  await until(()=>x.service.monitor.listenerCount('change')===count);
  assert.deepEqual(fs.readFileSync(path.join(x.root,'state.json')),before);
});

test('resume configures and parks a bare current registration in a single durable commit',async t=>{
  const x=await fixture(t),identity=input(x),registration=x.service.admin.desktop.attach(identity),revision=x.service.store.state.revision;
  const result=await call(x.root,identity,{action:'resume',provider:'qoder'});
  assert.equal(result.parked,true);assert.equal(x.calls.length,1);assert.equal(x.service.store.state.revision,revision+1);
  const state=fs.readFileSync(path.join(x.root,'state.json'));
  const wrong=await call(x.root,identity,{action:'resume',provider:'mimo'});assert.equal(wrong.mode,'attention');assert.match(wrong.error,/Connected platform differs/);
  assert.equal(x.service.store.state.projects[registration.projectId].bindings['worker:strong'].provider,'qoder');assert.equal(x.calls.length,1);
  await call(x.root,identity,{action:'resume'});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.root,'state.json'))).projects,JSON.parse(state).projects);
});

test('an asynchronous resume cannot overwrite a binding changed while its host was verifying',async t=>{
  const x=await fixture(t),identity=input(x),registration=x.service.admin.desktop.attach(identity);
  let release,started;const entered=new Promise(resolve=>{started=resolve;});
  x.service.monitor.wake.adapter={forProvider:()=>({verify:b=>{started();return new Promise(resolve=>{release=()=>resolve({thread:{id:b.threadId,cwd:x.workspace}});});}})};
  const pending=assert.rejects(call(x.root,identity,{action:'resume',provider:'qoder'}),/changed during host verification/);
  await entered;x.service.store.change(s=>{s.projects[registration.projectId].bindings['worker:strong'].sessionId='new-session';});release();await pending;
  const b=x.service.store.state.projects[registration.projectId].bindings['worker:strong'];assert.equal(b.sessionId,'new-session');assert.equal(b.wake,undefined);assert.equal(b.provider,undefined);
});

test('managed recovery keeps the named worker identity and emits a single recovery receipt',async t=>{
  const x=await fixture(t),old=input(x),first=await request(x.root,old);
  const invite=invitations.create(x.service.store,x.root,{projectId:first.projectId,binding:'worker:strong',clientId:old.clientId,confirmedStopped:true,reason:'fixture stopped'});
  const next=input(x,{replaceClientId:old.clientId,managedRebind:true,rebindInvitationId:invite.invitationId,recover:true,confirmedStopped:true});
  const revision=x.service.store.state.revision,result=await request(x.root,next);assert.equal(result.registration.recovered,true);assert.equal(result.registration.workerId,'strong');assert.equal(result.parked,true);
  assert.equal(x.service.store.state.revision,revision+1);assert.equal(x.service.store.state.events.filter(e=>e.to===next.clientId&&e.type==='binding_recovery_confirmed').length,1);
  const before=fs.readFileSync(path.join(x.root,'state.json'));await request(x.root,next);assert.deepEqual(fs.readFileSync(path.join(x.root,'state.json')),before);
});

test('staffing retries return authoritative workspace and do not repeat state writes or assessment receipts',async t=>{
  const x=await fixture(t),identity=input(x,{role:'brain',workerId:undefined,capabilities:undefined}),connected=await request(x.root,identity);
  const staffing={rationale:'fixture scope',workers:[{workerId:'strong',capability:'strong',responsibilities:'implementation'}]};
  const first=await call(x.root,identity,{action:'staff',staffing});assert.equal(first.workspace,x.workspace);
  const before=fs.readFileSync(path.join(x.root,'state.json')),revision=x.service.store.state.revision;
  const again=await call(x.root,identity,{action:'staff',staffing});assert.equal(again.duplicate,true);assert.deepEqual(again.staffing,first.staffing);
  assert.deepEqual(fs.readFileSync(path.join(x.root,'state.json')),before);assert.equal(x.service.store.state.revision,revision);
  assert.equal(x.service.store.state.events.filter(e=>e.projectId===connected.projectId&&e.type==='staffing_assessed').length,1);
});

test('wait mode has one provider source; redundant saved metadata is ignored and never supplies a missing identity',async t=>{
  const x=await fixture(t),identity=input(x,{provider:'zcode',sessionId:undefined}),connected=await request(x.root,identity);
  const binding=()=>x.service.store.state.projects[connected.projectId].bindings['worker:strong'];
  assert.equal(binding().provider,'zcode');assert.equal(binding().continuation,undefined);assert.equal(x.calls.length,0);
  x.service.store.change(s=>{s.projects[connected.projectId].bindings['worker:strong'].continuation={mode:'wait',provider:'retired-metadata'};});
  const before=fs.readFileSync(path.join(x.root,'state.json')),result=await call(x.root,identity,{action:'resume'});
  assert.equal(result.provider,'zcode');assert.equal(result.nextAction,'wait');assert.deepEqual(fs.readFileSync(path.join(x.root,'state.json')),before);
  const old=structuredClone(x.service.store.state);delete old.projects[connected.projectId].bindings['worker:strong'].provider;
  const root=path.join(x.dir,'missing-provider'),file=path.join(root,'state.json');atomic(file,old);const bytes=fs.readFileSync(file);
  assert.throws(()=>new Store(root),/explicit provider/);assert.deepEqual(fs.readFileSync(file),bytes);
});

test('wait invitations distinguish replacement clients, preserve revoked credentials and retry managed handovers without writes',async t=>{
  const x=await fixture(t),run=async(command,invitationId,managed=false)=>JSON.parse((await execFile(process.execPath,[cli,command,'--provider','zcode','--role','worker','--worker-id','strong','--capability','strong','--invitation-id',invitationId,'--data',x.root,...(managed?['--managed-rebind']:[])],{cwd:x.workspace,windowsHide:true})).stdout);
  const first=await run('connect',crypto.randomUUID()),oldBytes=fs.readFileSync(first.credential),old=JSON.parse(oldBytes),secondId=crypto.randomUUID();
  const second=await run('connect',secondId);assert.notEqual(second.credential,first.credential);assert.equal(second.nextAction,'wait');assert.deepEqual(fs.readFileSync(first.credential),oldBytes);
  await assert.rejects(call(x.root,old,{action:'status'}),/Invalid desktop token/);
  let before=fs.readFileSync(path.join(x.root,'state.json'));assert.equal((await run('connect',secondId)).credential,second.credential);assert.deepEqual(fs.readFileSync(path.join(x.root,'state.json')),before);
  const release=hold(x,second.projectId);t.after(release);
  const current=JSON.parse(fs.readFileSync(second.credential)),invite=invitations.create(x.service.store,x.root,{projectId:second.projectId,binding:'worker:strong',clientId:current.clientId});
  const pending=await run('rebind',invite.invitationId,true);assert.equal(pending.handoverPending,true);assert.equal(pending.nextAction,'resume');assert.notEqual(pending.credential,second.credential);
  before=fs.readFileSync(path.join(x.root,'state.json'));assert.equal((await run('rebind',invite.invitationId,true)).credential,pending.credential);assert.deepEqual(fs.readFileSync(path.join(x.root,'state.json')),before);
  release();handover.finish(x.service.dispatcher,second.projectId);
  const replacement=JSON.parse(fs.readFileSync(pending.credential)),resumed=await call(x.root,replacement,{action:'resume'});assert.equal(resumed.nextAction,'wait');assert.equal(resumed.provider,'zcode');assert.equal(x.calls.length,0);
  await assert.rejects(call(x.root,current,{action:'status'}),/Invalid desktop token/);
  before=fs.readFileSync(path.join(x.root,'state.json'));assert.equal((await run('rebind',invite.invitationId,true)).credential,pending.credential);assert.deepEqual(fs.readFileSync(path.join(x.root,'state.json')),before);
});

test('incomplete persisted contracts, stage membership and connection identities are rejected without repair',async t=>{
  const x=await fixture(t),connected=await request(x.root,input(x));
  x.service.store.change(s=>{const p=s.projects[connected.projectId];p.tasks.T={id:'T',...require('../runtime/core/attempts.cjs').taskFields(),attempts:[{id:'run',contractRevision:1}]};p.reviewStages={R:{id:'R',members:[{taskId:'T'}],reviewTaskIds:['T']}};});
  for(const [index,mutate]of [p=>delete p.tasks.T.contractRevision,p=>delete p.tasks.T.attempts[0].contractRevision,p=>delete p.reviewStages.R.reviewTaskIds,p=>delete p.bindings['worker:strong'].provider,p=>delete p.bindings['worker:strong'].sessionId].entries()){
    const state=structuredClone(x.service.store.state);mutate(state.projects[connected.projectId]);
    const root=path.join(x.dir,'invalid-'+index),file=path.join(root,'state.json');atomic(file,state);const before=fs.readFileSync(file);
    assert.throws(()=>new Store(root),/Unsupported|differs/);assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(path.join(root,'service.lock')),false);
  }
});

test('repeat installation on all current hosts writes no files, including installation receipts',t=>{
  fs.mkdirSync(path.resolve('tmp'),{recursive:true});const dir=fs.mkdtempSync(path.resolve('tmp/install-idempotent-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50}));
  const {install}=require('../scripts/install.js');install({platforms:['all'],home:dir});
  const write=fs.writeFileSync;let writes=0;fs.writeFileSync=function(...args){writes++;return write.apply(this,args);};
  try {assert.ok(install({platforms:['all'],home:dir}).every(plan=>plan.writes.length===0&&plan.deletes.length===0));assert.equal(writes,0);}
  finally {fs.writeFileSync=write;}
});

test('empty state changes neither write nor notify observers; grouped changes commit once and failures roll back',t=>{
  fs.mkdirSync(path.resolve('tmp'),{recursive:true});const dir=fs.mkdtempSync(path.resolve('tmp/store-transaction-'));
  const store=new Store(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  const before=fs.readFileSync(store.file);let commits=0;store.onCommit=()=>commits++;
  const rename=fs.renameSync;let writes=0;t.mock.method(fs,'renameSync',(a,b)=>{if(b===store.file)writes++;return rename(a,b);});
  store.change(()=>{});store.transaction(()=>store.change(s=>{s.events=[];}));
  assert.deepEqual(fs.readFileSync(store.file),before);assert.equal(writes,0);assert.equal(commits,0);assert.equal(store.state.revision,0);
  assert.throws(()=>store.transaction(()=>{store.change(s=>store.event(s,'unpublished'));throw Error('failed');}),/failed/);
  assert.deepEqual(fs.readFileSync(store.file),before);assert.equal(commits,0);
  store.transaction(()=>{store.change(s=>store.event(s,'first'));store.change(s=>store.event(s,'second'));});
  assert.equal(writes,1);assert.equal(commits,1);assert.equal(store.state.revision,1);assert.deepEqual(store.state.events.map(e=>e.type),['first','second']);
});
