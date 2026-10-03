'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {initialize,request}=require('../runtime/wizard.cjs');
const {serve}=require('../runtime/server.cjs');
const {call}=require('../runtime/desktop-client.cjs');
test('manual startup gates dispatch, checks peers, persists and resets only on completed reopen',async()=>{
 const base=fs.mkdtempSync(path.resolve('tmp/startup-')),root=path.join(base,'service'),workspace=path.join(base,'work');
 fs.mkdirSync(workspace);initialize(root);let s=await serve(root);
 try{
  const attach=role=>request(root,{action:'attach-desktop',workspace,role,clientId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex')});
  const brain=await attach('brain'),task={id:'T',title:'test',instructions:'write README',acceptance:'correct',allowedPaths:['README.md']};
  const start=(extra={})=>call(root,brain,{action:'start-work',confirmed:true,...extra});
  assert.equal((await call(root,brain,{action:'status'})).startup.state,'waiting');
  await assert.rejects(call(root,brain,{action:'plan',task}),/manual start/);
  await assert.rejects(request(root,{action:'add-task',projectId:brain.projectId,task}),/manual start/);
  await assert.rejects(start({confirmed:false}),/Explicit user/);
  await assert.rejects(start(),/worker/);
  const worker=await attach('worker');
  await assert.rejects(call(root,worker,{action:'start-work',confirmed:true}),/Only brain/);
  await assert.rejects(start(),/reviewer/);
  assert.equal((await call(root,worker,{action:'claim'})).job,null);
  assert.equal(s.store.state.projects[brain.projectId].turns,0);
  const reviewer=await attach('reviewer');await call(root,reviewer,{action:'heartbeat'});
  s.store.change(st=>{st.projects[brain.projectId].bindings.worker.wake={provider:'codex',threadId:'test'};});
  await assert.rejects(start(),/worker/);
  s.store.change(st=>{delete st.projects[brain.projectId].bindings.worker.wake;});
  assert.equal((await start()).startup.state,'started');
  assert.equal((await start()).duplicate,true);
  await s.close();s=await serve(root);
  assert.equal((await call(root,brain,{action:'status'})).startup.state,'started');
  await call(root,brain,{action:'plan',task});
  await call(root,reviewer,{action:'heartbeat'});await require('./stage-fixture.cjs').beginHttp(root,brain,['T']);
  const job=(await call(root,worker,{action:'claim'})).job;assert.equal(job.taskId,'T');
  await call(root,worker,{action:'submit',taskId:'T',attemptId:job.attemptId,result:{projectId:job.projectId,taskId:'T',attemptId:job.attemptId,role:'worker',status:'submitted',summary:'done',checks:[],unverified:[]}});
  await require('./stage-fixture.cjs').approveHttp(root,brain,reviewer);

  await request(root,{action:'finish-project',projectId:brain.projectId});
  await request(root,{action:'reopen-project',projectId:brain.projectId});
  assert.equal((await call(root,brain,{action:'status'})).startup.state,'waiting');
  await assert.rejects(call(root,brain,{action:'plan',task:{...task,id:'T2'}}),/manual start/);
  await assert.rejects(start({withoutReviewer:true}),/requires a reviewer/);assert.equal((await start()).startup.state,'started');
 }finally{await s.close();}
});
