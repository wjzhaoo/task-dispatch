'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {Store,atomic} = require('../runtime/core/storage.cjs');
const {Dispatcher} = require('../runtime/core/dispatcher.cjs');
const {Desktop} = require('../runtime/core/desktop.cjs');
const snapshots = require('../runtime/core/snapshot.cjs');
const maintenance = require('../runtime/core/maintenance.cjs');
const usage = require('../runtime/core/usage.cjs');
const {MimoWake} = require('../runtime/adapters/mimo-wake.cjs');
function fixture(t) {
  const temp=path.resolve(__dirname,'../tmp');fs.mkdirSync(temp,{recursive:true});
  const root=fs.mkdtempSync(path.join(temp,'features-')),workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace,'README.md'),'before');
  const store=new Store(path.join(root,'service'));t.after(()=>store.close());
  const d=new Dispatcher(store,{maxConcurrent:2});
  const desktop=new Desktop(d);desktop.attach({workspace,role:'worker',clientId:'worker123',token:'a'.repeat(64)});desktop.attach({workspace,role:'brain',clientId:'brain1234',token:'b'.repeat(64)});
  const worker=desktop.authenticate('a'.repeat(64)),brain=desktop.authenticate('b'.repeat(64)),projectId=worker.projectId;
  const reviewer=require('./stage-fixture.cjs').peers(desktop,projectId).reviewer;
  require('./stage-fixture.cjs').start(desktop,brain);
  const add=(id='T',extra={})=>d.addTask(projectId,{id,title:'Test',instructions:'Review actual files',acceptance:'Correct',allowedPaths:['README.md'],...extra});
  const step=async()=>{require('./stage-fixture.cjs').begin(d,projectId);d.tick();await Promise.all([...d.active.values()].map(x=>x.promise));};
  const task=(id='T')=>store.state.projects[projectId].tasks[id];
  function submit(identity,job,extra={}) {
    return desktop.submit(identity,{taskId:job.taskId,attemptId:job.attemptId,result:{projectId,taskId:job.taskId,attemptId:job.attemptId,role:identity.role,summary:'Actual checks',...(identity.role==='worker'?{status:'submitted',checks:[],unverified:[]}:{verdict:'pass',artifactId:job.artifactId,findings:[]}),...extra}});
  }
  return {root,workspace,store,d,desktop,worker,brain,reviewer,projectId,add,step,task,submit};
}
test('snapshot limits diagnose path; project exclusions and raised limits preserve code',t=>{
  const x=fixture(t);fs.mkdirSync(path.join(x.workspace,'data'));fs.writeFileSync(path.join(x.workspace,'data','asset.bin'),Buffer.alloc(80));
  assert.throws(()=>snapshots.manifest(x.workspace,{maxFileBytes:40,maxTotalBytes:100}),/data\/asset.bin.*file=80/);
  const config={exclude:['data/'],maxFileBytes:40,maxTotalBytes:100};
  const s=snapshots.snapshot(x.workspace,x.d.artifacts,config);
  // [AI-added] 2026-09-17 11:46
  assert.deepEqual(Object.keys(s.files),['README.md']);assert.deepEqual(s.policy.exclude,['.task-dispatch/runtime/','data/','tmp/']);assert.ok(s.policyHash);
  assert.ok(snapshots.manifest(x.workspace,{maxFileBytes:100,maxTotalBytes:100})['data/asset.bin']);
  assert.throws(()=>snapshots.policy({exclude:['../outside/']}));assert.throws(()=>snapshots.policy({exclude:['.dispatch-evidence/']}));
});
// [AI-added] 2026-09-14 19:48
test('snapshot ignores IDE project metadata while retaining task-dispatch authority files',t=>{
  const x=fixture(t);fs.mkdirSync(path.join(x.workspace,'.ide-cache','.codebase'),{recursive:true});
  fs.mkdirSync(path.join(x.workspace,'.task-dispatch'),{recursive:true});
  fs.writeFileSync(path.join(x.workspace,'.ide-cache','.codebase','file-index.db'),'volatile');
  fs.writeFileSync(path.join(x.workspace,'.task-dispatch','plan.md'),'authority');
  const files=require('../runtime/core/snapshot.cjs').manifest(x.workspace,{});
  assert.equal(files['.ide-cache/.codebase/file-index.db'],undefined);
  assert.ok(files['.task-dispatch/plan.md']);
  // [AI-added] 2026-09-14 20:03
  const snapshot=require('../runtime/core/snapshot.cjs');
  assert.equal(snapshot.ignored('.ide-cache/.codebase/file-index.db',{exclude:[]}),true);
  assert.equal(snapshot.ignored('.task-dispatch/plan.md',{exclude:[]}),false);
});
test('snapshot policy excludes root tmp and rejects version one',t=>{
  const x=fixture(t);fs.mkdirSync(path.join(x.workspace,'tmp'),{recursive:true});
  fs.writeFileSync(path.join(x.workspace,'tmp','volatile.json'),'changes constantly');
  fs.mkdirSync(path.join(x.workspace,'.task-dispatch'),{recursive:true});
  fs.writeFileSync(path.join(x.workspace,'.task-dispatch','plan.md'),'authority');
  const current=snapshots.manifest(x.workspace,{});assert.throws(()=>snapshots.manifest(x.workspace,{version:1,exclude:[]}),/Unsupported snapshot policy/);
  assert.equal(current['tmp/volatile.json'],undefined);assert.ok(current['.task-dispatch/plan.md']);
  assert.equal(snapshots.policy({}).version,2);
  assert.deepEqual(snapshots.excludedTaskPaths(['tmp/result.json','src/'],{}),['tmp/result.json']);
  assert.throws(()=>x.add('TMP',{allowedPaths:['tmp/result.json']}),/snapshot-excluded temporary paths/);
});
test('snapshot configuration refuses to hide unfinished deliverables',t=>{
 const x=fixture(t);x.add('ACTIVE',{allowedPaths:['build/result.json']});
 assert.throws(()=>x.d.configureSnapshot(x.projectId,{exclude:['build/']}),/ACTIVE:build\/result.json/);
});
test('pinned policy handles cache writes but still detects stale source and review edits',async t=>{
  const x=fixture(t);x.d.configureSnapshot(x.projectId,{exclude:['tmp/']});x.add();await x.step();
  assert.throws(()=>x.d.configureSnapshot(x.projectId,{}),/boundary|frozen/);
  const job=x.desktop.claim(x.worker);fs.mkdirSync(path.join(x.workspace,'tmp'));fs.writeFileSync(path.join(x.workspace,'tmp','cache'),'discard');
  x.submit(x.worker,job);await x.step();const review=x.desktop.claim(x.reviewer);assert.ok(review);
  fs.writeFileSync(path.join(review.cwd,'README.md'),'tampered');x.submit(x.reviewer,review);
  assert.equal(x.task().state,'blocked');assert.match(x.task().error,/Reviewer changed/);
});
test('unregistered imported candidates cannot bypass stage acceptance',async t=>{
 const x=fixture(t);x.add();assert.equal(x.d.prepareReview,undefined);assert.equal(x.d.configureRepair,undefined);assert.equal(x.d.reconcileReview,undefined);assert.equal(x.task().attempts.length,0);assert.equal(x.desktop.claim(x.brain),null);assert.notEqual(x.task().state,'accepted');
});

test('cleanup preview protects unfinished/shared refs, retains reports and rejects stale preview',t=>{
  const x=fixture(t);x.add('old');x.add('new');x.add('blocked');
  x.store.change(s=>{
    s.storagePolicy={automatic:true,retainDays:0,keepLatestAccepted:1,maxBytes:100000};
    for(const [id,when] of [['old','2020-01-01'],['new','2021-01-01']]) {const task=s.projects[x.projectId].tasks[id];task.state='accepted';task.completedAt=when;task.artifactId=id;task.attempts=[{id,contractRevision:1,role:'brain',settled:true,artifactId:id}];}
    const b=s.projects[x.projectId].tasks.blocked;b.state='blocked';b.artifactId='old';
  });
  for(const rel of ['artifacts/old','artifacts/new','reviews/old','reviews/new','validations/old/tree','validations/new/tree']) {const dir=path.join(x.store.root,rel);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'file'),'x');}
  atomic(path.join(x.store.root,'validations/old/report.json'),{passed:true});
  const preview=maintenance.plan(x.d);assert.ok(preview.entries.some(e=>e.relative==='reviews/old'));assert.ok(!preview.entries.some(e=>e.relative==='artifacts/old'));
  // Previous assertion kept the latest accepted task's full review tree.
  // [AI-added] 2026-09-24 11:05: Accepted candidates remain, but settled review copies are disposable.
  assert.ok(preview.entries.some(e=>e.relative==='reviews/new'));
  x.d.pause(x.projectId,true);assert.throws(()=>maintenance.apply(x.d,preview.previewId),/changed/);
  const p=maintenance.plan(x.d);maintenance.apply(x.d,p.previewId);
  assert.ok(fs.existsSync(path.join(x.store.root,'validations/old/report.json')));assert.ok(!fs.existsSync(path.join(x.store.root,'validations/old/tree')));
  assert.ok(fs.existsSync(path.join(x.store.root,'artifacts/old')));
  assert.throws(()=>maintenance.safeTarget(x.store.root,'artifacts/../outside'));
});
test('automatic cleanup reclaims settled caches beside running work while preserving evidence and retention',t=>{
  const x=fixture(t), now=Date.parse('2026-09-15T00:00:00Z');
  assert.equal(maintenance.policy().automatic,true);
  assert.equal(maintenance.policy({automatic:false}).automatic,false);
  const states={old:'accepted',boundary:'accepted',recent:'accepted',latest:'accepted',running:'running',uncertain:'uncertain',validating:'accepted'};
  for(const id of Object.keys(states))x.add(id);
  x.store.change(s=>{
    for(const [id,state] of Object.entries(states)) {
      const task=s.projects[x.projectId].tasks[id];task.state=state;task.artifactId=id;
      task.completedAt=id==='boundary'?'2026-09-08T00:00:00Z':id==='recent'?'2026-09-14T00:00:00Z':id==='latest'?'2026-09-15T00:00:00Z':'2020-01-01T00:00:00Z';
      task.attempts=[{id,contractRevision:1,role:'brain',settled:state==='accepted',artifactId:id,...(id==='validating'?{validationPid:process.pid}:{})}];
    }
    s.projects[x.projectId].tasks.running.scopeRecovery={originalBaselineId:'recovery',rejectedArtifactId:'rejected'};
    s.projects.other={id:'other',mode:'desktop',maxTurns:null,projectBudgetEnabled:false,turns:0,tasks:{shared:{id:'shared',state:'uncertain',...require('../runtime/core/attempts.cjs').taskFields(),artifactId:'old',attempts:[]}}};
  });
  for(const id of Object.keys(states))for(const rel of [`artifacts/${id}`,`reviews/${id}`,`validations/${id}/tree`]) {
    fs.mkdirSync(path.join(x.store.root,rel),{recursive:true});fs.writeFileSync(path.join(x.store.root,rel,'file'),'cache');
  }
  for(const id of ['recovery','rejected']){fs.mkdirSync(path.join(x.store.root,'artifacts',id));fs.writeFileSync(path.join(x.store.root,'artifacts',id,'file'),'evidence');}
  atomic(path.join(x.store.root,'validations/old/report.json'),{passed:true});
  const entries=()=>maintenance.plan(x.d,now).entries.map(e=>e.relative);
  const selected=entries();
  for(const rel of ['validations/old/tree','validations/latest/tree','reviews/old','reviews/boundary','artifacts/boundary'])assert.ok(selected.includes(rel),rel);
  // Previous assertion protected reviews/recent and reviews/latest with their accepted tasks.
  // [AI-added] 2026-09-24 11:05: Retain their final candidates, not historical review copies.
  for(const rel of ['artifacts/old','artifacts/recovery','artifacts/rejected','validations/running/tree','validations/uncertain/tree','validations/validating/tree'])assert.ok(!selected.includes(rel),rel);
  for(const rel of ['reviews/recent','reviews/latest'])assert.ok(selected.includes(rel),rel);
  x.d.active.set(x.projectId,{});assert.deepEqual(entries(),[]);x.d.active.delete(x.projectId);
  const preview=maintenance.plan(x.d,now);maintenance.apply(x.d,preview.previewId,now);
  assert.ok(fs.existsSync(path.join(x.store.root,'validations/old/report.json')));
  assert.ok(!fs.existsSync(path.join(x.store.root,'validations/old/tree')));
  assert.ok(fs.existsSync(path.join(x.workspace,'README.md')));
});
// [AI-added] 2026-09-24 11:05: A new settled attempt supersedes old diff copies while the
// current candidate and its worker baseline remain available for the next review.
test('rolling cleanup reclaims previous settled attempts without breaking the current diff',t=>{
  const x=fixture(t);x.add();
  x.store.change(s=>{
    const task=s.projects[x.projectId].tasks.T;
    task.state='review_ready';task.artifactId='candidate-new';
    task.attempts=[
      {id:'worker-old',contractRevision:1,role:'worker',settled:true,baselineId:'before-old',artifactId:'candidate-old'},
      {id:'review-old',contractRevision:1,role:'brain',settled:true,artifactId:'candidate-old',delivery:{cwd:'old-review'}},
      {id:'worker-new',contractRevision:1,role:'worker',settled:true,baselineId:'before-new',artifactId:'candidate-new'}
    ];
  });
  for(const rel of ['artifacts/before-old','artifacts/candidate-old','artifacts/before-new','artifacts/candidate-new','reviews/review-old','validations/worker-old/tree']){
    const dir=path.join(x.store.root,rel);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'file'),'snapshot');
  }
  atomic(path.join(x.store.root,'validations/worker-old/report.json'),{passed:true});
  const task=x.task();
  x.store.change(s=>{s.projects[x.projectId].tasks.T.scopeRecovery={originalBaselineId:'before-old',rejectedArtifactId:'candidate-old'};});
  assert.ok(!maintenance.plan(x.d).entries.some(entry=>entry.relative==='artifacts/before-old'));
  x.store.change(s=>{delete s.projects[x.projectId].tasks.T.scopeRecovery;});
  const preview=maintenance.plan(x.d),paths=preview.entries.map(entry=>entry.relative);
  for(const rel of ['artifacts/before-old','artifacts/candidate-old','reviews/review-old','validations/worker-old/tree'])assert.ok(paths.includes(rel),rel);
  for(const rel of ['artifacts/before-new','artifacts/candidate-new'])assert.ok(!paths.includes(rel),rel);
  maintenance.apply(x.d,preview.previewId);
  assert.ok(fs.existsSync(path.join(x.store.root,'artifacts/before-new')));
  assert.ok(fs.existsSync(path.join(x.store.root,'artifacts/candidate-new')));
  assert.ok(fs.existsSync(path.join(x.store.root,'validations/worker-old/report.json')));
  assert.equal(x.task().attempts[1].delivery,undefined);
  assert.equal(task.attempts.length,3);
  x.store.change(s=>{const current=s.projects[x.projectId].tasks.T;current.state='accepted';current.completedAt='2026-09-24T00:00:00Z';});
  assert.ok(maintenance.plan(x.d).entries.some(entry=>entry.relative==='artifacts/before-new'));
  assert.ok(!maintenance.plan(x.d).entries.some(entry=>entry.relative==='artifacts/candidate-new'));
});

// [AI-added] 2026-09-24 11:05: Batch baseline and composite snapshots stay pinned until
// the batch ends; completed batch validation trees use the same guarded cleanup path.
test('rolling cleanup protects active batch snapshots and releases ended batch copies',t=>{
  const x=fixture(t);x.add('A');x.add('B');
  x.store.change(s=>{s.projects[x.projectId].reviewStages={batch:{id:'batch',state:'ready',reviewTaskIds:['A','B'],members:[{taskId:'A'},{taskId:'B'}],baselineId:'batch-before',compositeArtifactId:'batch-after',attempt:{id:'batch-review',settled:false}}};});
  for(const rel of ['artifacts/batch-before','artifacts/batch-after','reviews/batch-review','validations/batch-review/A/tree']){
    const dir=path.join(x.store.root,rel);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'file'),'batch');
  }
  assert.ok(!maintenance.plan(x.d).entries.some(entry=>entry.relative==='artifacts/batch-before'));
  x.store.change(s=>{const batch=s.projects[x.projectId].reviewStages.batch;batch.state='completed';batch.verdict='pass';batch.attempt.settled=true;});
  const entries=maintenance.plan(x.d).entries.map(entry=>entry.relative);
  for(const rel of ['artifacts/batch-before','artifacts/batch-after','reviews/batch-review','validations/batch-review/A/tree'])assert.ok(entries.includes(rel),rel);
  maintenance.apply(x.d,maintenance.plan(x.d).previewId);
  assert.ok(!fs.existsSync(path.join(x.store.root,'validations/batch-review/A/tree')));
});

test('cleanup refuses nested junctions instead of following them',t=>{
  const x=fixture(t),dir=path.join(x.store.root,'artifacts','linked');fs.mkdirSync(dir,{recursive:true});
  try {fs.symlinkSync(x.workspace,path.join(dir,'escape'),process.platform==='win32'?'junction':'dir');} catch(e) {if(e.code==='EPERM')return t.skip('Symlink privilege unavailable');throw e;}
  assert.throws(()=>maintenance.size(dir),/symlink\/junction/);assert.equal(fs.readFileSync(path.join(x.workspace,'README.md'),'utf8'),'before');
});
test('usage separates measured, partial and unknown; cached tokens are subsets; duplicates are idempotent',t=>{
  const x=fixture(t);x.add();x.store.change(s=>{s.projects[x.projectId].tasks.T.attempts=[{id:'a',contractRevision:1,role:'brain'},{id:'b',contractRevision:1,role:'worker'}];});
  const value={provider:'codex',model:'strong',source:'actual-platform-meter',scope:'attempt',inputTokens:100,cachedInputTokens:80,outputTokens:10,reasoningOutputTokens:3};
  usage.record(x.store,x.projectId,'T','a',value);usage.record(x.store,x.projectId,'T','a',value);
  assert.throws(()=>usage.record(x.store,x.projectId,'T','a',{...value,inputTokens:200}),/Conflicting/);
  const s=usage.summary(x.store.state);assert.equal(s.groups.find(g=>g.role==='brain').knownTokens.inputTokens,100);assert.equal(s.groups.find(g=>g.role==='worker').unknownAttempts,1);assert.equal(s.savings,null);
  assert.deepEqual(s.groups.find(g=>g.role==='worker').unknownReasons,{platform_not_reported:1});
  assert.throws(()=>usage.normalize({...value,cachedInputTokens:101}),/exceeds/);assert.throws(()=>usage.normalize({...value,scope:'session'}),/attempt/);
});
test('Codex collector uses deduplicated deltas in attempt windows, preserving mixed-model labels',async t=>{
  const x=fixture(t),id='11111111-1111-1111-1111-111111111111';x.add();
  const logs=path.join(x.root,'logs');fs.mkdirSync(logs);
  const event=(at,i,o)=>({timestamp:at,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:i,cached_input_tokens:i-10,output_tokens:o,reasoning_output_tokens:0}}}});
  const rows=[{type:'turn_context',payload:{model:'actual-model'}},event('2026-01-01T00:00:00Z',100,10),event('2026-01-01T00:00:01Z',200,20),event('2026-01-01T00:00:02Z',200,20),event('2026-01-01T00:00:04Z',300,30)];
  fs.writeFileSync(path.join(logs,'rollout-'+id+'.jsonl'),rows.map(JSON.stringify).join('\n'));
  x.store.change(s=>{s.projects[x.projectId].tasks.T.attempts=[{id:'a',contractRevision:1,role:'brain',usageBinding:{provider:'codex',threadId:id},startedAt:'2026-01-01T00:00:01Z',settledAt:'2026-01-01T00:00:03Z',settled:true}];});
  const {collect}=require('../runtime/core/codex-usage.cjs');await collect(x.d,{root:logs});await collect(x.d,{root:logs});
  const run=x.task().attempts[0],u=run.observedUsage;assert.equal(u.inputTokens,100);assert.equal(u.outputTokens,10);assert.equal(u.model,'actual-model');assert.equal(run.usageObservation.reason,'collected');assert.equal(usage.summary(x.store.state).groups[0].partialAttempts,1);
});
test('Codex usage diagnostics distinguish missing, ambiguous and unusable logs',async t=>{
  const x=fixture(t),id='22222222-2222-2222-2222-222222222222';x.add();
  const mod=require('../runtime/core/codex-usage.cjs'),missing=path.join(x.root,'missing');
  assert.equal(mod.locate(missing,id).reason,'log_root_missing');
  const logs=path.join(x.root,'logs');fs.mkdirSync(logs);assert.equal(mod.locate(logs,id).reason,'log_not_found');
  for(const dir of ['a','b']){fs.mkdirSync(path.join(logs,dir));fs.writeFileSync(path.join(logs,dir,'rollout-'+id+'.jsonl'),'{}\n');}
  assert.equal(mod.locate(logs,id).reason,'log_ambiguous');
  fs.rmSync(path.join(logs,'b'),{recursive:true});
  x.store.change(s=>{s.projects[x.projectId].tasks.T.attempts=[{id:'a',contractRevision:1,role:'brain',provider:'codex',usageBinding:{provider:'codex',threadId:id},startedAt:'2026-01-01T00:00:01Z',settledAt:'2026-01-01T00:00:03Z',settled:true}];});
  await mod.collect(x.d,{root:logs});const run=x.task().attempts[0];assert.equal(run.observedUsage,undefined);assert.equal(run.usageObservation.reason,'no_usable_token_deltas');
  assert.deepEqual(usage.summary(x.store.state).groups[0].unknownReasons,{no_usable_token_deltas:1});
});
test('MiMo discovers fresh token/port, normalizes history, uses explicit model and requires history confirmation for 202 delivery',async t=>{
  const x=fixture(t),file=path.join(x.root,'mimo.json'),calls=[];
  atomic(file,{api:1,port:1234,token:'a'.repeat(64)});
  let posted=null;
  const adapter=new MimoWake({credentialFile:file,fetchImpl:async(url,options)=>{
    calls.push({url,options});if(url.endsWith('/sessions'))return Response.json([{id:'ses_test',directory:x.workspace}]);
    if(new URL(url).pathname.endsWith('/messages')){assert.equal(new URL(url).searchParams.get('dir'),x.workspace);return Response.json([{info:{role:'user'},parts:[{text:posted?JSON.parse(posted).message:'TASK-DISPATCH-WAKE:test'}]}]);}
    if(new URL(url).pathname.endsWith('/events')){assert.equal(new URL(url).searchParams.get('dir'),x.workspace);return new Response('event: busy\ndata: {}\n\n');}
    if(new URL(url).pathname.endsWith('/turns'))posted=options.body;
    return Response.json({ok:true},{status:202});
  }});
  const info=await adapter.read({threadId:'ses_test'});assert.equal(info.thread.status.type,'active');assert.match(info.turns[0].items[0].content[0].text,/TASK-DISPATCH/);
  // [AI-added] 2026-09-24 13:27: Initial identity verification does not wait for a live event sample.
  const beforeVerify=calls.length,verified=await adapter.verify({threadId:'ses_test'});
  assert.equal(verified.thread.id,'ses_test');assert.equal(verified.thread.status.type,'unknown');
  assert.equal(calls.slice(beforeVerify).some(call=>new URL(call.url).pathname.endsWith('/events')),false);
  atomic(file,{api:1,port:5678,token:'b'.repeat(64)});
  atomic(path.join(x.root,'preferences.json'),{perm:'',permByConvo:{ses_test:'帮我审批'}});
  const result=await adapter.send({threadId:'ses_test',model:'xiaomi/mimo-x-pro-preview'},'Wake test');assert.deepEqual(result,{delivered:true});
  const last=calls.filter(c=>c.options&&c.options.method==='POST').at(-1);assert.match(last.url,/127.0.0.1:5678/);assert.equal(last.options.headers.Authorization,'Bearer '+'b'.repeat(64));assert.equal(JSON.parse(last.options.body).model,'xiaomi/mimo-x-pro-preview');assert.equal(JSON.parse(last.options.body).dir,x.workspace);
  assert.equal(JSON.parse(last.options.body).perm,'帮我审批');
  adapter.fetch=async url=>url.endsWith('/sessions')?Response.json([{id:'s',directory:x.workspace}]):Response.json({code:'busy'},{status:409});await assert.rejects(adapter.send({threadId:'s',model:'p/m'},'test'),e=>e.safeToRetry===true);
  adapter.fetch=async url=>url.endsWith('/sessions')?Response.json([{id:'s',directory:x.workspace}]):Response.json({ok:true});await assert.rejects(adapter.send({threadId:'s',model:'p/m'},'test'),/rejected/);
  // [AI-added] 2026-09-19: A 202 whose message never reaches the history is an unverified delivery.
  adapter.fetch=async url=>url.endsWith('/sessions')?Response.json([{id:'s',directory:x.workspace}]):url.includes('/messages')?Response.json([]):Response.json({ok:true},{status:202});
  await assert.rejects(adapter.send({threadId:'s',model:'p/m'},'[TASK-DISPATCH-WAKE:00000000-0000-0000-0000-000000000000] probe'),e=>e.unverified===true&&/never appeared/.test(e.message));
});
test('static validation permits documentation only and progress respects claimed identity',async t=>{
  const x=fixture(t);x.d.configureValidation(x.projectId,{mode:'static',reason:'Documentation-only review'},'docs');x.add('T',{validationProfile:'docs'});await x.step();
  const job=x.desktop.claim(x.worker),p={taskId:'T',attemptId:job.attemptId,sequence:1,stage:'reading',summary:'Read files'};
  x.desktop.progress(x.worker,p);assert.equal(x.desktop.progress(x.worker,p).duplicate,true);assert.throws(()=>x.desktop.progress(x.brain,p),/claimed/);assert.throws(()=>x.desktop.progress(x.worker,{...p,summary:'different'}),/conflicting/);
  x.submit(x.worker,job);await x.step();const review=x.desktop.claim(x.reviewer);assert.equal(x.task().attempts.at(-1).validation.checksRun,false);x.submit(x.reviewer,review);assert.equal(x.task().stageHeld,true);
});
test('disk budget blocks before creating a partial snapshot',async t=>{
  const x=fixture(t);x.store.change(s=>{s.storagePolicy={maxBytes:1};});x.add();await assert.rejects(x.step(),/Storage budget exceeded/);
  assert.equal(x.task().state,'ready');assert.deepEqual(fs.readdirSync(x.d.artifacts),[]);
});
test('static profile cannot approve code changes',async t=>{
  const x=fixture(t);x.d.configureValidation(x.projectId,{mode:'static',reason:'Docs'},'docs');x.add('T',{allowedPaths:['code.js'],validationProfile:'docs'});await x.step();
  const job=x.desktop.claim(x.worker);fs.writeFileSync(path.join(x.workspace,'code.js'),'module.exports = 1;');x.submit(x.worker,job);await x.step();
  assert.equal(x.task().state,'blocked');assert.match(x.task().error,/documentation/);
  // Since 0.7.1 the validation block raises task_attention; the brain is notified instead of nobody.
  assert.equal(x.desktop.claim(x.brain).kind,'task_attention');
});
test('MiMo wake routes without Codex turnId, retries definitive busy, reconciles uncertain delivery',async t=>{
  const x=fixture(t),{Wake}=require('../runtime/core/wake.cjs');let sent=0,found=false,busy=true;
  const adapter={read:async()=>({thread:{id:'ses_test',cwd:x.workspace,status:{type:'unknown'}},turns:found?[{items:[{type:'userMessage',content:[{text:'TASK-DISPATCH-WAKE:'+x.task().attempts.at(-1).id}]}]}]:[]}),send:async b=>{assert.equal(b.model,'xiaomi/mimo-x-pro-preview');sent++;const e=Error('test');if(busy)e.safeToRetry=true;throw e;}};
  const wake=new Wake(x.desktop,{forProvider:p=>{assert.equal(p,'mimo');return adapter;}});
  await assert.rejects(wake.bind(x.worker,{provider:'mimo',threadId:'ses_test'}),/model/);
  await wake.bind(x.worker,{provider:'mimo',threadId:'ses_test',model:'xiaomi/mimo-x-pro-preview'});
  wake.park(x.worker);x.add();await x.step();await wake.run();assert.equal(x.task().attempts.at(-1).wakeNotice.status,'pending');
  busy=false;await wake.run();assert.equal(sent,2);assert.equal(x.task().attempts.at(-1).wakeNotice.status,'uncertain');
  await wake.run();assert.equal(sent,2);found=true;await wake.run();assert.equal(x.task().attempts.at(-1).wakeNotice.status,'sent');assert.equal(sent,2);
});
