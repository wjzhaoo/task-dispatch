'use strict';
const {registerDesktop}=require('./service-fixture.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const execFile=require('node:util').promisify(require('node:child_process').execFile);
const {initialize,request}=require('../runtime/wizard.cjs');
const {serve}=require('./service-fixture.cjs');
const {call}=require('../runtime/desktop-client.cjs');
const cli=path.resolve(__dirname,'../runtime/desktop-client.cjs');
function fixture(){const dir=path.resolve(__dirname,'../tmp');fs.mkdirSync(dir,{recursive:true});const base=fs.mkdtempSync(path.join(dir,'handover-')),root=path.join(base,'service'),workspace=path.join(base,'work');fs.mkdirSync(workspace);initialize(root);return {root,workspace};}
async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out');}
test('worker invitation auto replaces idle session, preserves old credential, and staffing emits typed invites',async()=>{
 const {root,workspace}=fixture(),service=await serve(root,{wakeAdapter:{resolveTurn:async()=> 'fixture-turn',read:async b=>({thread:{id:b.threadId,cwd:workspace,status:{type:'active'}}})}});
 const run=async(...args)=>JSON.parse((await execFile(process.execPath,[cli,...args,'--data',root],{cwd:workspace,windowsHide:true})).stdout);
 try {
  const brain=await run('connect','--provider','codex','--session-id','brain');
  await run('connect','--provider','codex','--role','worker','--session-id','initial-worker');
  await require('./stage-fixture.cjs').startHttp(root,JSON.parse(fs.readFileSync(brain.credential)));
  const staffFile=path.join(path.dirname(root),'staff.json');fs.writeFileSync(staffFile,JSON.stringify({rationale:'复杂存储完整交强模型，测试数据交经济模型',workers:[{workerId:'strong-1',capability:'strong',responsibilities:'存储实现'},{workerId:'economy-1',capability:'economy',responsibilities:'测试数据'}],concurrencyRequested:true}));
  const staff=await run('staff','--credential',brain.credential,'--file',staffFile);
  assert.equal(staff.workerInvites.length,2);assert.equal(staff.staffing.executionMode,'serial-shared-workspace');
 assert.match(staff.workerInvites[0].text,/--worker-id strong-1 --capability strong/);
  // [AI-added] 2026-09-17 09:42
  assert.ok(staff.workerInvites.every(x=>x.platformSelectionOwner==='receiver'));
  assert.ok(staff.workerInvites.every(x=>/发送邀请的大脑不得代问/.test(x.text)));
  const task={id:'typed',title:'typed',instructions:'implement',acceptance:'checked',allowedPaths:['code.txt'],workerId:'strong-1'};
  const bc=JSON.parse(fs.readFileSync(brain.credential));
  await assert.rejects(call(root,bc,{action:'plan',task}),/requiredCapability/);
  await request(root,{action:'pause',projectId:brain.projectId});
  await call(root,bc,{action:'plan',task:{...task,requiredCapability:'strong'}});
  await require('./stage-fixture.cjs').beginHttp(root,bc,['typed']);
  const a=await run('connect','--provider','codex','--role','worker','--worker-id','strong-1','--capability','strong','--session-id','first');
  const saved=fs.readFileSync(a.credential),old=JSON.parse(saved);
  const b=await run('connect','--provider','codex','--role','worker','--worker-id','strong-1','--capability','strong','--session-id','second');
  assert.notEqual(a.credential,b.credential);assert.ok(fs.readFileSync(a.credential).equals(saved));
  await assert.rejects(call(root,old,{action:'status'}),/Invalid desktop token/);
  assert.equal((await run('connect','--provider','codex','--role','worker','--worker-id','strong-1','--capability','strong','--session-id','second')).credential,b.credential);
  // [AI-added] 2026-09-17 09:42
  const invite=await run('handoff-invite','--credential',brain.credential);assert.equal(invite.commandTemplate.startsWith('rebind --provider <当前真实平台> --role brain'),true);
  const newBrain=await run('rebind','--provider','codex','--role','brain','--session-id','brain-new');
  assert.deepEqual(newBrain.workerInvites.map(w=>w.workerId),['economy-1']);assert.equal(newBrain.wakeEnabled,true);
  await assert.rejects(call(root,JSON.parse(fs.readFileSync(brain.credential)),{action:'status'}),/Invalid desktop token/);
  await assert.rejects(call(root,JSON.parse(fs.readFileSync(b.credential)),{action:'staff',staffing:{}}),/Only brain/);
 }finally{await service.close();}
});
test('handover waits for receipt, rejects competing replacement, survives restart and preserves attempt ownership',async()=>{
 const {root,workspace}=fixture();let service=await serve(root);
 const make=(role,sessionId,workerId)=>({workspace,role,sessionId,...(workerId?{workerId}:{}),capabilities:role==='worker'?['strong']:[],clientId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex')});
 const b=make('brain','brain'),w=make('worker','old','strong');
 try {
  Object.assign(b,await registerDesktop(root,{...b}));Object.assign(w,await registerDesktop(root,{...w}));
  await require('./stage-fixture.cjs').startHttp(root,b);
  await call(root,b,{action:'plan',task:{id:'T',title:'T',instructions:'implement',acceptance:'correct',allowedPaths:['code.txt'],workerId:'strong',requiredCapability:'strong'}});
  await require('./stage-fixture.cjs').beginHttp(root,b,['T']);
  const job=(await call(root,w,{action:'wait'})).job;
  const n=make('worker','new','strong');
  const attach=()=>registerDesktop(root,{...n,replaceClientId:w.clientId});
  assert.equal((await attach()).handoverPending,true);assert.equal((await attach()).handoverPending,true);
  await assert.rejects(registerDesktop(root,{...make('worker','third','strong'),replaceClientId:w.clientId}),/already waiting/);
  await assert.rejects(registerDesktop(root,{...make('brain','new'),replaceClientId:b.clientId}),/waiting for another/);
  await assert.rejects(call(root,n,{action:'claim'}),/Invalid desktop token/);
  assert.equal((await call(root,w,{action:'claim'})).job.attemptId,job.attemptId);
  await service.close();service=await serve(root);assert.equal((await attach()).handoverPending,true);
  const pendingFile=path.join(root,'pending.json');fs.writeFileSync(pendingFile,JSON.stringify({...n,projectId:b.projectId,data:root}));
  const waiting=execFile(process.execPath,[cli,'resume','--credential',pendingFile,'--data',root,'--seconds','10'],{windowsHide:true});
  fs.writeFileSync(path.join(workspace,'code.txt'),'done');
  await call(root,w,{action:'submit',taskId:'T',attemptId:job.attemptId,result:{projectId:b.projectId,taskId:'T',attemptId:job.attemptId,role:'worker',status:'submitted',summary:'done',checks:[],unverified:[]}});
  await until(()=>service.store.state.projects[b.projectId].bindings['worker:strong'].clientId===n.clientId);
  assert.equal(JSON.parse((await waiting).stdout).attached,true);
  await assert.rejects(call(root,w,{action:'status'}),/Invalid desktop token/);
  const p=service.store.state.projects[b.projectId];assert.equal(p.tasks.T.attempts[0].claimedBy,w.clientId);assert.equal(p.tasks.T.attempts[0].settled,true);
  assert.equal((await call(root,n,{action:'claim'})).job,null);
 }finally{await service.close();}
});

// [AI-added] 2026-09-16 21:34
test('confirmed brain recovery supersedes stale handover and resumes the same review attempt',async()=>{
 const {root,workspace}=fixture(),service=await serve(root,{wakeAdapter:{resolveTurn:async()=> 'fixture-turn',read:async b=>({thread:{id:b.threadId,cwd:workspace,status:{type:'active'}}})}});
 const run=async(...args)=>JSON.parse((await execFile(process.execPath,[cli,...args,'--data',root],{cwd:workspace,windowsHide:true})).stdout);
 try {
  const brain=await run('connect','--provider','codex','--session-id','brain-old');
  const worker=await run('connect','--provider','codex','--role','worker','--session-id','worker');
  const oldBrain=JSON.parse(fs.readFileSync(brain.credential)),workerCredential=JSON.parse(fs.readFileSync(worker.credential));
  await require('./stage-fixture.cjs').startHttp(root,oldBrain);
  await call(root,oldBrain,{action:'plan',task:{id:'review',title:'review',instructions:'write code',acceptance:'correct',allowedPaths:['code.txt']}});
  await require('./stage-fixture.cjs').beginHttp(root,oldBrain,['review']);
  const implementation=(await call(root,workerCredential,{action:'claim'})).job;
  fs.writeFileSync(path.join(workspace,'code.txt'),'done');
  await call(root,workerCredential,{action:'submit',taskId:implementation.taskId,attemptId:implementation.attemptId,result:{projectId:implementation.projectId,taskId:implementation.taskId,attemptId:implementation.attemptId,role:'worker',status:'submitted',summary:'done',checks:[],unverified:[]}});
  await require('./stage-fixture.cjs').preliminaryHttp(root,oldBrain);
  const review=(await call(root,oldBrain,{action:'claim'})).job;
  const stale=await run('rebind','--provider','codex','--role','brain','--session-id','brain-stale');
  assert.equal(stale.handoverPending,true);assert.equal(stale.attached,false);
  const recovered=await run('rebind','--provider','codex','--role','brain','--session-id','brain-new','--recover','--confirmed-stopped');
  assert.equal(recovered.attached,true);assert.equal(recovered.recovered,true);assert.deepEqual(recovered.recoveredAttempts,[review.attemptId]);
  const newBrain=JSON.parse(fs.readFileSync(recovered.credential));
  await assert.rejects(call(root,oldBrain,{action:'status'}),/Invalid desktop token/);
  await assert.rejects(call(root,JSON.parse(fs.readFileSync(stale.credential)),{action:'status'}),/Invalid desktop token/);
  const resumed=(await call(root,newBrain,{action:'claim'})).job;
  assert.equal(resumed.attemptId,review.attemptId);assert.equal(service.store.state.projects[brain.projectId].tasks.review.attempts.length,2);
  await call(root,newBrain,{action:'stage-submit',roundId:resumed.roundId,attemptId:resumed.attemptId,result:require('./stage-fixture.cjs').finalResult(resumed)});
  assert.equal(service.store.state.projects[brain.projectId].tasks.review.state,'accepted');
  assert.ok(service.store.state.events.some(event=>event.type==='binding_recovery_confirmed'&&event.binding==='brain'&&event.to===newBrain.clientId));
 }finally{await service.close();}
});
