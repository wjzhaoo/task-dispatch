'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {initialize,request}=require('../runtime/wizard.cjs');
const {serve}=require('../runtime/server.cjs');
const {call}=require('../runtime/desktop-client.cjs');
/* Previous implementation: async function setup(fn) { */
// [AI-added] 2026-09-15 14:13
async function setup(fn,options={}) {
  const base=fs.mkdtempSync(path.resolve('tmp/pre-review-')),root=path.join(base,'service'),workspace=path.join(base,'work');
  /* Previous implementation: fs.mkdirSync(workspace);initialize(root);const s=await serve(root); */
  // [AI-added] 2026-09-15 14:16
  fs.mkdirSync(workspace);initialize(root);const s=await serve(root,typeof options==='function'?options({workspace}):options);
  try {
    const attach=role=>request(root,{action:'attach-desktop',workspace,role,sessionId:crypto.randomUUID(),clientId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex')});
    const brain=await attach('brain'),worker=await attach('worker'),reviewer=await attach('reviewer');
    const task=()=>s.store.state.projects[brain.projectId].tasks.T;
    const claim=async c=>(await call(root,c,{action:'claim'})).job;
    const submit=(c,j,verdict='pass')=>j.kind==='stage_review'?call(root,c,{action:'stage-submit',roundId:j.roundId,attemptId:j.attemptId,result:require('./stage-fixture.cjs').finalResult(j,verdict)}):call(root,c,{action:'submit',taskId:j.taskId,attemptId:j.attemptId,result:{projectId:j.projectId,taskId:j.taskId,attemptId:j.attemptId,role:j.role,summary:'evidence',...(j.role==='worker'?{status:'submitted',checks:[],unverified:[]}:{artifactId:j.artifactId,verdict,findings:verdict==='needs_fix'?[{key:'bug',message:'README missing required content'}]:[]})}});
    await require('./stage-fixture.cjs').startHttp(root,brain,reviewer);
    await call(root,brain,{action:'plan',task:{id:'T',title:'T',instructions:'write README',acceptance:'correct',allowedPaths:['README.md']}});
  await require('./stage-fixture.cjs').beginHttp(root,brain,['T']);
    const first=await claim(worker);fs.writeFileSync(path.join(workspace,'README.md'),'candidate');
    await fn({s,root,workspace,brain,worker,reviewer,task,claim,submit,first});
  /* Previous implementation: } finally {await s.close();} */
  // [AI-added] 2026-09-15 14:17
  } finally {await s.close();fs.rmSync(base,{recursive:true,force:true});}
}
test('online reviewer gates acceptance, returns defects, and rechecks repaired candidate',()=>setup(async x=>{
  const {root,brain,worker,reviewer,claim,submit,task,first,workspace}=x;
  await call(root,reviewer,{action:'heartbeat'});await submit(worker,first);
  assert.equal((await call(root,brain,{action:'claim'})).job,null);
  let r=await claim(reviewer);assert.equal(r.role,'reviewer');
  await assert.rejects(call(root,reviewer,{action:'plan',task:{id:'X'}}),/Only brain/);
  await submit(reviewer,r,'needs_fix');
  const repair=await claim(worker);fs.writeFileSync(path.join(workspace,'README.md'),'repaired');await submit(worker,repair);
  r=await claim(reviewer);await submit(reviewer,r);
  assert.notEqual(task().state,'accepted');
  const b=await claim(brain);assert.equal(b.role,'brain');assert.match(b.prompt,/stage.json/);
  await submit(brain,b);assert.equal(task().state,'accepted');
  assert.equal(require('../runtime/core/attempts.cjs').counts(task()).total,5);
}));
test('claimed reviewer keeps ownership without heartbeat until explicit detach',()=>setup(async x=>{
  const {root,brain,worker,reviewer,submit,claim,first,task}=x;
  await call(root,reviewer,{action:'heartbeat'});await submit(worker,first);
  const r=await claim(reviewer);
  x.s.dispatcher.reviewerPresence.get(brain.projectId).at=0;
  assert.equal(await claim(brain),null);
  await call(root,reviewer,{action:'detach'});
  await assert.rejects(submit(reviewer,r),/settled|conflicting|Invalid desktop token/);
  const notice=await claim(brain);assert.equal(notice.kind,'stage_attention');const next=await request(root,{action:'attach-desktop',workspace:x.workspace,role:'reviewer',clientId:'replacement-reviewer',token:'f'.repeat(64)});await call(root,next,{action:'heartbeat'});await call(root,brain,{action:'stage-resume',roundId:notice.roundId});await submit(next,await claim(next));const b=await claim(brain);await submit(brain,b);assert.equal(task().state,'accepted');
}));
test('brain explicitly detaches a crashed reviewer, recovers review, and revokes the old token',()=>setup(async x=>{
  await call(x.root,x.reviewer,{action:'heartbeat'});await x.submit(x.worker,x.first);
  const review=await x.claim(x.reviewer);
  const brainFile=path.join(x.root,'brain-recovery.json');fs.writeFileSync(brainFile,JSON.stringify({...x.brain,data:x.root,workspace:x.workspace}));
  const exec=require('node:util').promisify(require('node:child_process').execFile);
  const detached=JSON.parse((await exec(process.execPath,[path.resolve('runtime/desktop-client.cjs'),'detach','--role','reviewer','--credential',brainFile,'--data',x.root],{windowsHide:true})).stdout);
  assert.deepEqual(detached,{detached:true,binding:'reviewer'});
  // [AI-added] 2026-09-16: The service timer may already prepare brain review before the CLI exits.
  assert.ok(['review_ready','reviewing'].includes(x.task().state));
  assert.equal(x.task().attempts.find(a=>a.id===review.attemptId).outcome,'reviewer_detached');
  assert.equal(x.task().state,'review_ready');
  await assert.rejects(x.submit(x.reviewer,review),/Invalid desktop token/);
  const notice=await x.claim(x.brain);assert.equal(notice.kind,'stage_attention');const next=await request(x.root,{action:'attach-desktop',workspace:x.workspace,role:'reviewer',clientId:'replacement-reviewer',token:'f'.repeat(64)});await call(x.root,next,{action:'heartbeat'});await call(x.root,x.brain,{action:'stage-resume',roundId:notice.roundId});await x.submit(next,await x.claim(next));await x.submit(x.brain,await x.claim(x.brain));assert.equal(x.task().state,'accepted');
  await assert.rejects(call(x.root,x.worker,{action:'detach',targetRole:'reviewer'}),/Only brain/);
}));
test('missing reviewer presence blocks rather than falling back to brain',()=>setup(async x=>{
 x.s.dispatcher.reviewerPresence.clear();await x.submit(x.worker,x.first);assert.equal((await x.claim(x.brain)).kind,'stage_attention');assert.equal(x.task().attempts.some(r=>r.role==='brain'),false);
}));
// [AI-added] 2026-09-17 18:49: Verify the real brain-needs-fix to parked-worker wake path.
test('preliminary rejection wakes the parked worker for the repair attempt',()=>{let sends=0;return setup(async x=>{
  const sessionId=x.s.store.state.projects[x.brain.projectId].bindings.worker.sessionId;
  await call(x.root,x.worker,{action:'wake-bind',provider:'codex',threadId:sessionId,turnId:'worker-turn',experimentalAcknowledged:true});
  await x.submit(x.worker,x.first);assert.equal((await call(x.root,x.worker,{action:'park'})).parked,true);
  const review=await x.claim(x.reviewer);assert.equal(review.role,'reviewer');await x.submit(x.reviewer,review,'needs_fix');
  await x.s.monitor.wake.run();assert.equal(sends,1);const repair=(await call(x.root,x.worker,{action:'claim'})).job;assert.equal(repair.role,'worker');assert.notEqual(repair.attemptId,x.first.attemptId);
 },({workspace})=>({wakeAdapter:{forProvider:()=>({read:async binding=>({thread:{id:binding.threadId,cwd:workspace,status:{type:'idle'}},turns:[]}),send:async()=>{sends++;return {delivered:true};}})}}));});
test('connect exposes spawn instructions and reviewer connects with independent credentials',()=>setup(async x=>{
  const exec=require('node:util').promisify(require('node:child_process').execFile);
  const connect=async c=>{
    const file=path.join(x.root,c.role+'.json'),sessionId=x.s.store.state.projects[c.projectId].bindings[c.role].sessionId;
    fs.writeFileSync(file,JSON.stringify({...c,data:x.root,workspace:x.workspace,sessionId}));
    return JSON.parse((await exec(process.execPath,[path.resolve('runtime/desktop-client.cjs'),'connect','--provider','codex','--role',c.role,'--credential',file,'--session-id',sessionId,'--data',x.root],{cwd:x.workspace,windowsHide:true})).stdout);
  };
  // [AI-added] 2026-09-17 09:42
  let b=await connect(x.brain);assert.equal(b.reviewerSpawnRequired,false);assert.equal(b.reviewerInvite.commandTemplate.startsWith('connect --provider <当前真实平台> --role reviewer'),true);
  const r=await connect(x.reviewer);assert.equal(r.role,'reviewer');assert.equal(r.reviewerOnline,true);
  b=await connect(x.brain);assert.equal(b.reviewerSpawnRequired,false);assert.equal(b.workers.length,1);
  assert.equal(b.connections.length,3);assert.ok(b.connections.every(c=>c.wakeEnabled===false));
  assert.match(b.reviewerInvite.text,/用户.*开始/);assert.match(b.reviewerInvite.text,/resume/);
  assert.match(b.reviewerInvite.text,/--provider <当前真实平台>/);
  // [AI-added] 2026-09-17 09:42
  assert.match(b.reviewerInvite.text,/发送邀请的大脑不得代问/);assert.equal(b.reviewerInvite.platformSelectionRequired,true);assert.equal(b.reviewerInvite.platformSelectionOwner,'receiver');
}));
test('reviewer cannot alter its candidate to obtain a pass',()=>setup(async x=>{
  await call(x.root,x.reviewer,{action:'heartbeat'});await x.submit(x.worker,x.first);
  const r=await x.claim(x.reviewer);fs.writeFileSync(path.join(r.cwd,'README.md'),'tampered');
  await x.submit(x.reviewer,r);assert.equal(x.task().state,'blocked');assert.match(x.task().error,/changed its input/);
}));
test('transient reviewer wake read failure does not revoke an in-flight review',()=>setup(async x=>{
  await call(x.root,x.reviewer,{action:'wake-bind',provider:'codex',threadId:x.s.store.state.projects[x.brain.projectId].bindings.reviewer.sessionId,turnId:'test-turn',experimentalAcknowledged:true});
  await x.submit(x.worker,x.first);
  let review=(await call(x.root,x.reviewer,{action:'claim'})).job;
  if(!review){await new Promise(resolve=>setImmediate(resolve));review=(await call(x.root,x.reviewer,{action:'claim'})).job;}
  assert.ok(review);
  x.s.dispatcher.tick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(x.task().state,'reviewing');assert.equal(x.task().attempts.at(-1).id,review.attemptId);
  await x.submit(x.reviewer,review);
},({workspace})=>{let reads=0;return {wakeAdapter:{read:async binding=>{if(reads++)throw Error('temporary adapter failure');return {thread:{id:binding.threadId,cwd:workspace,status:{type:'idle'}},turns:[]};},send:async()=>({delivered:true})}};}));
