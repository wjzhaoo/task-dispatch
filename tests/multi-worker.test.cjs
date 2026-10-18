'use strict';
const {registerDesktop,bindWake}=require('./service-fixture.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {initialize,request}=require('../runtime/wizard.cjs');
const {serve,fakeWake}=require('./service-fixture.cjs');
// [AI-added] 2026-09-15 16:49
const {call}=require('../runtime/desktop-client.cjs');
// [AI-added] 2026-09-17 09:42
const {buildInvitation}=require('../runtime/core/invitations.cjs');
const execFile=require('node:util').promisify(require('node:child_process').execFile);
const cli=path.resolve(__dirname,'../runtime/desktop-client.cjs');
// [AI-added] 2026-09-15 16:49
test('all generated invitations preserve task-dispatch workflow isolation',()=>{
 // [AI-added] 2026-09-17 09:42
 const common={workspace:'C:\\work',dataRoot:'C:\\service',clientPath:__filename,referencePath:__filename};
 for(const text of [buildInvitation({...common,role:'worker',workerId:'worker',capability:'strong'}),buildInvitation({...common,role:'reviewer'}),buildInvitation({...common,role:'brain'})].map(x=>x.text)){
  assert.match(text,/显式使用 \$task-dispatch/);assert.match(text,/不要启动 flow-entry、flow-feature 或 flow-fix/);assert.match(text,/不要另建计划或再次等待用户输入 1/);
 }
});
test('named workers route by capability, serialize, revoke waits, rebind and survive restart',async()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'multi-worker-')),root=path.join(base,'service'),workspace=path.join(base,'work');fs.mkdirSync(workspace);initialize(root);
 let service=await serve(root,{wakeAdapter:fakeWake(workspace)});
 const attach=async(role,workerId,capabilities=[],sessionId=crypto.randomUUID())=>registerDesktop(root,{workspace,role,workerId,capabilities,sessionId,clientId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex')});
 const plan=(brain,id,workerId,requiredCapability)=>call(root,brain,{action:'plan',task:{id,title:id,instructions:'edit README',acceptance:'correct',allowedPaths:['README.md'],workerId,requiredCapability,dependsOn:id==='T2'?['T']:[]}});
 try {
  const brain=await attach('brain');const economy=await attach('worker','economy',['economy']);
  await require('./stage-fixture.cjs').startHttp(root,brain);
  await plan(brain,'T','strong','strong');
  assert.equal(service.store.state.projects[brain.projectId].tasks.T.state,'ready');
  assert.equal((await call(root,brain,{action:'status'})).tasks[0].waitingForWorker,true);
  assert.equal((await call(root,economy,{action:'claim'})).job,null);
  const weak=await attach('worker','strong',['economy']);
  assert.equal((await call(root,weak,{action:'claim'})).job,null);
  await call(root,brain,{action:'detach',workerId:'strong'});
  await assert.rejects(call(root,weak,{action:'status'}),/Invalid desktop token/);
  await request(root,{action:'pause',projectId:brain.projectId});
  const strong=await attach('worker','strong',['strong']);
  assert.equal((await call(root,brain,{action:'assign',reason:'test reassignment',taskId:'T',workerId:'economy'})).waitingForWorker,true);
  assert.equal((await call(root,brain,{action:'assign',reason:'test reassignment',taskId:'T',workerId:'strong'})).waitingForWorker,false);
  await request(root,{action:'resume',projectId:brain.projectId});
  const third=await attach('worker','tests',['tests']);
  await assert.rejects(plan(economy,'X','strong','strong'),/Only brain/);
  await plan(brain,'T2','tests','tests');await require('./stage-fixture.cjs').beginHttp(root,brain,['T','T2']);
  const job=(await call(root,strong,{action:'wait'})).job;assert.equal(job.workerId,'strong');
  assert.equal((await call(root,third,{action:'claim'})).job,null);
  await assert.rejects(call(root,strong,{action:'detach'}),/unfinished/);
  const result={projectId:job.projectId,taskId:job.taskId,attemptId:job.attemptId,role:'worker',status:'submitted',summary:'fixed',checks:[],unverified:[]};
  await assert.rejects(call(root,economy,{action:'submit',taskId:'T',attemptId:job.attemptId,result}),/identity/);
  await service.close();service=await serve(root,{wakeAdapter:fakeWake(workspace)});
  assert.equal((await call(root,strong,{action:'claim'})).job.attemptId,job.attemptId);
  fs.writeFileSync(path.join(workspace,'README.md'),'fixed');
  await call(root,strong,{action:'submit',taskId:'T',attemptId:job.attemptId,result});
  await require('./stage-fixture.cjs').preliminaryHttp(root,brain);assert.equal((await call(root,brain,{action:'claim'})).job,null);
  assert.equal((await call(root,third,{action:'wait'})).job.taskId,'T2');
  const waiting=assert.rejects(call(root,economy,{action:'wait'}),/revoked/);
  await new Promise(r=>setTimeout(r,100));await call(root,economy,{action:'detach'});await waiting;
  const file=path.join(root,'strong.json');fs.writeFileSync(file,JSON.stringify({...strong,workspace,data:root,sessionId:service.store.state.projects[brain.projectId].bindings['worker:strong'].sessionId,capabilities:['strong']}));
  const rebind=JSON.parse((await execFile(process.execPath,[cli,'rebind','--provider','codex','--credential',file,'--data',root,'--role','worker','--worker-id','strong','--session-id','replacement'],{cwd:workspace,windowsHide:true})).stdout);
  assert.equal(rebind.workerId,'strong');await assert.rejects(call(root,strong,{action:'status'}),/Invalid desktop token/);
  assert.equal(service.store.state.projects[brain.projectId].bindings['worker:strong'].sessionId,'replacement');
  const replacement=JSON.parse(fs.readFileSync(rebind.credential));await call(root,replacement,{action:'detach'});
  const next=JSON.parse((await execFile(process.execPath,[cli,'connect','--provider','codex','--credential',file,'--data',root,'--role','worker','--worker-id','strong','--session-id','third-session','--capability','strong'],{cwd:workspace,windowsHide:true})).stdout);
  assert.equal(next.workerId,'strong');await assert.rejects(call(root,replacement,{action:'status'}),/Invalid desktop token/);
 }finally{await service.close();}
});

test('named worker wake targets only assigned session',async()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'named-wake-')),root=path.join(base,'service'),workspace=path.join(base,'work');fs.mkdirSync(workspace);initialize(root);const sent=[];
 const service=await serve(root,{wakeAdapter:{read:async c=>({thread:{id:c.threadId,cwd:workspace,status:{type:'idle'}},turns:[]}),send:async(c,text)=>{sent.push(c.threadId);}}});
 try {
  const make=(role,workerId,sessionId)=>registerDesktop(root,{workspace,role,workerId,sessionId,clientId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex')});
  const brain=await make('brain',undefined,'brain');const a=await make('worker','a','a');const b=await make('worker','b','b');
  for(const [credential,threadId] of [[a,'a'],[b,'b']]){await bindWake(root,credential,{provider:'codex',threadId,turnId:'turn'});await call(root,credential,{action:'park'});}
  await require('./stage-fixture.cjs').startHttp(root,brain);
  await call(root,brain,{action:'plan',task:{id:'T',title:'t',instructions:'i',acceptance:'a',allowedPaths:['README.md'],workerId:'b'}});
  await require('./stage-fixture.cjs').beginHttp(root,brain,['T']);
  for(let i=0;i<40&&!sent.length;i++)await new Promise(r=>setTimeout(r,100));
  assert.deepEqual(sent,['b']);assert.equal((await call(root,a,{action:'claim'})).job,null);assert.equal((await call(root,b,{action:'claim'})).job.workerId,'b');
 }finally{await service.close();}
});

test('brain connect returns pasteable invite without secrets',async()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'invite-worker-')),root=path.join(base,'service'),workspace=path.join(base,'work');fs.mkdirSync(workspace);initialize(root);const s=await serve(root,{wakeAdapter:fakeWake(workspace)});
 try {
  const connect=JSON.parse((await execFile(process.execPath,[cli,'connect','--provider','codex','--data',root,'--session-id','brain-session'],{cwd:workspace,windowsHide:true})).stdout);
  // [AI-added] 2026-09-16 18:11
  assert.equal(connect.staffingRequired,true);assert.equal(connect.peerSetupRequired,true);assert.equal(connect.nextAction,'setup-peers');
  assert.equal(connect.workerInviteStatus,'pending-staffing');assert.deepEqual(connect.workerInvites,[]);
  // [AI-added] 2026-09-17 09:42
  assert.equal(connect.reviewerInvite.platformSelectionRequired,true);assert.equal(connect.reviewerInvite.platformSelectionOwner,'receiver');assert.match(connect.reviewerInvite.text,/发送邀请的大脑不得代问/);
  const invite=JSON.parse((await execFile(process.execPath,[cli,'invite','--data',root,'--credential',connect.credential,'--worker-id','strong','--capability','strong'],{cwd:workspace,windowsHide:true})).stdout);
  assert.ok(invite.commandTemplate.includes('--worker-id strong'));assert.ok(invite.commandTemplate.includes('--capability strong'));assert.equal(invite.platformSelectionOwner,'receiver');
  const secret=JSON.parse(fs.readFileSync(connect.credential)).token;assert.ok(!JSON.stringify(invite).includes(secret));
 }finally{await s.close();}
});
