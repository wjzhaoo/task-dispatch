const {registerDesktop,bindWake}=require('./service-fixture.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {initialize,request}=require('../runtime/wizard.cjs');
const {serve}=require('./service-fixture.cjs');
const {call}=require('../runtime/desktop-client.cjs');
const {spawn}=require('node:child_process');
const {promisify}=require('node:util');
const execFile=promisify(require('node:child_process').execFile);
// [AI-added] 2026-09-22 09:20: Exercise the authenticated API and CLI without modifying candidate inputs.
test('preflight is read only, enforces ownership and reports protected paths; submit rechecks scope',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'preflight-http-')),workspace=path.join(root,'work'),data=path.join(root,'service');
 fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'README.md'),'before');initialize(data);const s=await serve(data);
 try{
  const attach=role=>registerDesktop(data,{workspace,role,clientId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex')});
  const brain=await attach('brain'),worker=await attach('worker');
  await require('./stage-fixture.cjs').startHttp(data,brain);
  await call(data,brain,{action:'plan',task:{id:'T',title:'edit',instructions:'edit',acceptance:'correct',allowedPaths:['README.md','docs/plans/']}});
  await require('./stage-fixture.cjs').beginHttp(data,brain,['T']);
  const {job}=await call(data,worker,{action:'claim'}),input={action:'preflight',taskId:'T',attemptId:job.attemptId};
  fs.writeFileSync(path.join(workspace,'README.md'),'after');const before=JSON.stringify(s.store.state);
  const clean=await call(data,worker,input);assert.equal(clean.ok,true);assert.equal(clean.counts.changes,1);assert.equal(JSON.stringify(s.store.state),before);
  await assert.rejects(call(data,brain,input),/identity|stage-submit/);await assert.rejects(call(data,worker,{...input,attemptId:'stale'}),/identity|stage-submit/);
  const credential=path.join(data,'preflight-worker.json');fs.writeFileSync(credential,JSON.stringify({...worker,data}));
  const cli=await execFile(process.execPath,[path.resolve('runtime/desktop-client.cjs'),'preflight','--credential',credential,'--data',data,'--task','T','--attempt',job.attemptId]);
  assert.equal(JSON.parse(cli.stdout).ok,true);assert.equal(JSON.stringify(s.store.state),before);
  for(const name of ['data/projects/test.json','docs/plans/plan.md','docs/worker-results/other/result.md','backend/.pytest_cache/nodeids']){const file=path.join(workspace,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'changed');}
  const dirty=await call(data,worker,input);assert.equal(dirty.ok,false);assert.equal(dirty.outOfScope.length,4);assert.equal(JSON.stringify(s.store.state),before);
  const result={projectId:job.projectId,taskId:'T',attemptId:job.attemptId,role:'worker',status:'submitted',summary:'changed',checks:[],unverified:[]};
  await call(data,worker,{action:'submit',taskId:'T',attemptId:job.attemptId,result});
  assert.equal(s.store.state.projects[worker.projectId].tasks.T.scopeReturns,1);
  assert.notEqual(s.store.state.projects[worker.projectId].tasks.T.state,'accepted');
 }finally{await s.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('review preflight and durable receipt retain added modified and deleted file diagnostics',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'preflight-review-')),workspace=path.join(root,'work'),data=path.join(root,'service');
 fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'README.md'),'before');fs.writeFileSync(path.join(workspace,'keep.txt'),'keep');initialize(data);const s=await serve(data);
 try{
  const attach=role=>registerDesktop(data,{workspace,role,clientId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex')});
  const brain=await attach('brain'),worker=await attach('worker');await require('./stage-fixture.cjs').startHttp(data,brain);
  await call(data,brain,{action:'plan',task:{id:'T',title:'edit',instructions:'edit',acceptance:'correct',allowedPaths:['README.md']}});
  await require('./stage-fixture.cjs').beginHttp(data,brain,['T']);
  const job=(await call(data,worker,{action:'claim'})).job;fs.writeFileSync(path.join(workspace,'README.md'),'after');
  await call(data,worker,{action:'submit',taskId:'T',attemptId:job.attemptId,result:{projectId:job.projectId,taskId:'T',attemptId:job.attemptId,role:'worker',status:'submitted',summary:'changed',checks:[],unverified:[]}});
  const reviewer={projectId:brain.projectId,role:'reviewer',clientId:'fixture-reviewer',token:'e'.repeat(64)};
  const review=(await call(data,reviewer,{action:'claim'})).job;
  fs.writeFileSync(path.join(review.cwd,'README.md'),'bad');fs.unlinkSync(path.join(review.cwd,'keep.txt'));fs.writeFileSync(path.join(review.cwd,'added.txt'),'bad');
  const before=JSON.stringify(s.store.state),check=await call(data,reviewer,{action:'preflight',taskId:'T',attemptId:review.attemptId});assert.equal(check.ok,false);assert.deepEqual(check.changes.map(c=>c.kind).sort(),['added','deleted','modified']);assert.equal(JSON.stringify(s.store.state),before);
  await call(data,reviewer,{action:'submit',taskId:'T',attemptId:review.attemptId,result:{projectId:review.projectId,taskId:'T',attemptId:review.attemptId,role:'reviewer',artifactId:review.artifactId,verdict:'pass',summary:'pass',findings:[]}});
  assert.match(s.store.state.projects[brain.projectId].tasks.T.error,/Reviewer changed.*README\.md/);
  const receipt=JSON.parse(fs.readFileSync(s.dispatcher.receiptPath(review.attemptId)));assert.equal(Object.hasOwn(receipt,'reviewChanged'),false);assert.equal(receipt.reviewChanges.length,3);
  assert.equal(fs.readFileSync(path.join(workspace,'README.md'),'utf8'),'after');
 }finally{await s.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('Windows reserved-name diagnostics do not mistake normal file names for devices',()=>{
 const {reservedNames}=require('../runtime/core/snapshot.cjs');
 assert.deepEqual(reservedNames({'nul':{},'src/COM1.txt':{},'src/LPT².log':{},'null.txt':{},'compile.js':{}}),['nul','src/COM1.txt','src/LPT².log']);
});

test('explicit project finish drains old waiters, new clients exit successfully, reopen permits new work',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-completion-')),workspace=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-completion-work-'));initialize(root);
 const s=await serve(root);
 try {
  const credential=await registerDesktop(root,{workspace,role:'worker',clientId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex')});
  await assert.rejects(request(root,{action:'finish-project',projectId:credential.projectId}),/nonempty/);
  const brain=await registerDesktop(root,{workspace,role:'brain',clientId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex')});
  await require('./stage-fixture.cjs').startHttp(root,brain);
  s.dispatcher.addTask(credential.projectId,{id:'T',title:'t',instructions:'i',acceptance:'a',allowedPaths:['README.md']});
  await assert.rejects(request(root,{action:'finish-project',projectId:credential.projectId}),/accepted/);
  s.store.change(state=>{state.projects[credential.projectId].tasks.T.state='accepted';});
  const file=path.join(root,'worker.json');fs.writeFileSync(file,JSON.stringify({...credential,data:root}));
  const completed=call(root,credential,{action:'wait'});
  const running=execFile(process.execPath,[path.resolve('runtime/desktop-client.cjs'),'wait','--credential',file,'--data',root,'--seconds','20']);
  await new Promise(r=>setTimeout(r,150));
  assert.equal((await call(root,brain,{action:'finish-project'})).completed,true);
  assert.equal((await completed).completed,true);const output=JSON.parse((await running).stdout);assert.equal(output.completed,true);assert.ok(!fs.existsSync(file+'.wait.lock'));
  assert.equal((await call(root,credential,{action:'park'})).completed,true);
  assert.equal((await call(root,credential,{action:'claim'})).completed,true);
  assert.throws(()=>s.dispatcher.addTask(credential.projectId,{id:'T2',title:'t',instructions:'i',acceptance:'a',allowedPaths:['README.md']}),/reopen/);
  await request(root,{action:'reopen-project',projectId:credential.projectId});assert.equal((await call(root,credential,{action:'claim'})).job,null);
 }finally{await s.close();}
});
test('HTTP wake binding, park and wait exclusion use the authenticated role',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-wake-http-')),workspace=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-wake-http-work-'));
 initialize(root);
 const s=await serve(root,{wakeAdapter:{read:async()=>({thread:{id:'thread',cwd:workspace,status:{type:'active'}}}),send:async()=>{throw Error('must not send');}}});
 try {
  const c=await registerDesktop(root,{workspace,role:'brain',clientId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex')});
  const file=path.join(root,'brain-wake.json');fs.writeFileSync(file,JSON.stringify({...c,data:root,workspace}));
  const cli=path.resolve('runtime/desktop-client.cjs');
  await assert.rejects(execFile(process.execPath,[cli,'wake-bind','--credential',file,'--data',root,'--thread-id','thread','--turn-id','turn']),/is removed/);
  await assert.rejects(execFile(process.execPath,[cli,'wake-bind','--provider','auto','--credential',file,'--data',root,'--thread-id','thread','--turn-id','turn']),/is removed/);
  assert.equal((await call(root,c,{action:'status'})).wakeEnabled,false);
  await bindWake(root,c,{provider:'codex',threadId:'thread',turnId:'turn'});
  assert.equal((await call(root,c,{action:'park'})).parked,true);
  await assert.rejects(call(root,c,{action:'wait'}),/claim\/park/);
  assert.equal((await call(root,c,{action:'claim'})).job,null);
  await assert.rejects(bindWake(root,c,{enabled:false}),/explicit provider/);
  assert.equal((await call(root,c,{action:'status'})).wakeEnabled,true);
 }finally{await s.close();}
});
test('desktop peers wait, hand off, survive restart and reject role spoofing',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-service-'));
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-project-'));
 fs.writeFileSync(path.join(workspace,'README.md'),'before');initialize(root);
 let s=await serve(root);
 const credential=role=>({role,workspace,clientId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex')});
  const brain=credential('brain'),worker=credential('worker');
 try {
  Object.assign(brain,await registerDesktop(root,{...brain}));
  Object.assign(worker,await registerDesktop(root,{...worker}));
  assert.equal(brain.projectId,worker.projectId);
  assert.match(brain.projectId,/^desktop-desktop-project-[a-z0-9-]*-[a-f0-9]{8}$/);
  await assert.rejects(registerDesktop(root,{...credential('worker')}),/already bound/);
  const task={id:'T',title:'edit',instructions:'edit readme',acceptance:'correct',allowedPaths:['README.md']};
  await assert.rejects(call(root,worker,{action:'plan',task}),/Only brain/);
  const waiting=call(root,worker,{action:'wait'});
  await require('./stage-fixture.cjs').startHttp(root,brain);
  await call(root,brain,{action:'plan',task});
  await require('./stage-fixture.cjs').beginHttp(root,brain,['T']);
  const {job}=await waiting;assert.equal(job.role,'worker');
  fs.writeFileSync(path.join(workspace,'README.md'),'after');
  await s.close();s=await serve(root);
  const again=(await call(root,worker,{action:'wait'})).job;assert.equal(again.attemptId,job.attemptId);
  const result={projectId:job.projectId,taskId:job.taskId,attemptId:job.attemptId,role:'worker',status:'submitted',summary:'changed',checks:[],unverified:[]};
  await assert.rejects(call(root,brain,{action:'submit',taskId:'T',attemptId:job.attemptId,result}),/identity|stage-submit/);
  await call(root,worker,{action:'submit',taskId:'T',attemptId:job.attemptId,result});
  assert.equal((await call(root,worker,{action:'submit',taskId:'T',attemptId:job.attemptId,result})).duplicate,true);
  await require('./stage-fixture.cjs').approveHttp(root,brain);
  assert.equal((await request(root)).projects[brain.projectId].tasks.T.state,'accepted');
  const planning=(await call(root,brain,{action:'claim'})).job;
  assert.equal(planning.kind,'planning');assert.deepEqual(planning.acceptedTaskIds,['T']);
  const closeoutFile=path.join(root,'closeout.json'),brainFile=path.join(root,'brain.json');
  fs.writeFileSync(brainFile,JSON.stringify({...brain,data:root}));
  fs.writeFileSync(closeoutFile,JSON.stringify({planningId:planning.planningId,outcome:'blocked',summary:'Await next scope',planEvidence:'T accepted in plan',reason:'No authorized next task'}));
  const closed=JSON.parse((await execFile(process.execPath,[path.resolve('runtime/desktop-client.cjs'),'closeout','--credential',brainFile,'--data',root,'--file',closeoutFile],{windowsHide:true})).stdout);
  assert.equal(closed.outcome,'blocked');assert.equal((await call(root,brain,{action:'status'})).planning.state,'blocked');
  const pending=call(root,worker,{action:'wait'});const rejected=assert.rejects(pending);await new Promise(r=>setTimeout(r,50));await s.close();await rejected;
 }finally{await s.close();}
});
test('real waiting client stays alive across service restart and returns a job',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-client-'));
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-client-work-'));
 initialize(root);let s=await serve(root);let child;
 const cli=path.resolve(__dirname,'../runtime/desktop-client.cjs');
 const file=path.join(root,'worker.json');
 try {
  const attached=await execFile(process.execPath,[cli,'connect','--provider','zcode','--role','worker','--workspace',workspace,'--credential',file,'--data',root],{windowsHide:true});
  assert.equal(JSON.parse(attached.stdout).attached,true);
  child=spawn(process.execPath,[cli,'wait','--credential',file,'--data',root,'--seconds','60'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',error='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);
  const exited=new Promise(resolve=>child.once('close',code=>resolve(code)));
  for(let i=0;i<50&&!fs.existsSync(file+'.wait.lock');i++)await new Promise(r=>setTimeout(r,20));
  assert.ok(fs.existsSync(file+'.wait.lock'));
  await s.close();s=await serve(root);
  const brain=await registerDesktop(root,{workspace,role:'brain',clientId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex')});
  await require('./stage-fixture.cjs').startHttp(root,brain);
  await call(root,brain,{action:'plan',task:{id:'T',title:'t',instructions:'i',acceptance:'a',allowedPaths:['README.md']}});
  await require('./stage-fixture.cjs').beginHttp(root,brain,['T']);
  assert.equal(await exited,0,error);assert.equal(JSON.parse(output).job.taskId,'T');assert.equal(fs.existsSync(file+'.wait.lock'),false);
 }finally{child?.kill();await s.close();}
});
