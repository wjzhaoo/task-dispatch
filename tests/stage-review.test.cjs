// [AI-added] 2026-09-26 16:00: Real dispatcher integration for mandatory stage acceptance.
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Store}=require('../runtime/core/storage.cjs'),{Dispatcher}=require('../runtime/core/dispatcher.cjs'),{Desktop}=require('../runtime/core/desktop.cjs');
const stage=require('../runtime/core/stage-review.cjs');
const {setup}=require('./stage-fixture.cjs');
test('plans remain drafts until brain registers a full stage; reviewer cannot change plans',async t=>{
 const x=await setup(t);x.task('A');x.task('B');await x.drain();assert.equal(await x.claim('worker'),null);assert.equal(stage.summary(x.p()).mode,'stage');
 assert.throws(()=>x.desktop.plan(x.identities.reviewer,{id:'C'}),/Only brain/);assert.throws(()=>stage.register(x.desktop,x.identities.reviewer,x.definition()),/Only brain/);
 assert.throws(()=>require('../runtime/core/startup.cjs').start(x.desktop,x.identities.brain,{confirmed:true,withoutReviewer:true}),/requires a reviewer/);
 x.register();assert.equal(x.register().duplicate,true);assert.throws(()=>x.task('C'),/frozen/);assert.equal((await x.claim('worker')).taskId,'A');
});
test('dependent tasks can edit the same file and yield exactly one whole-stage brain review',async t=>{
 const x=await setup(t);x.task('A',{allowedPaths:['shared.txt']});x.task('B',{allowedPaths:['shared.txt'],dependsOn:['A']});x.register();
 await x.execute('A','shared.txt','A');assert.equal(x.p().tasks.A.state,'review_ready');assert.equal(x.p().tasks.A.stageHeld,true);assert.equal(await x.claim('brain'),null);
 await x.execute('B','shared.txt','AB');const j=await x.claim('brain');assert.equal(j.kind,'stage_review');assert.equal(fs.readFileSync(path.join(j.cwd,'shared.txt'),'utf8'),'AB');assert.equal(j.members.length,2);
 assert.equal(x.p().turns,5);assert.equal(x.final(j).ok,true);assert.equal(x.final(j).duplicate,true);assert.deepEqual(Object.values(x.p().tasks).map(v=>v.state),['accepted','accepted']);
 assert.equal(x.store.state.events.filter(e=>e.type==='stage_review_settled').length,1);assert.equal(x.desktop.finishProject(x.identities.brain).completed,true);
});
test('failed stages append linked repair tasks and re-review all original tasks over multiple rounds',async t=>{
 const x=await setup(t);x.task('A');x.register(x.definition(['A']));await x.execute('A');let j=await x.claim('brain');x.final(j,x.verdict(j,false));
 assert.equal(x.p().tasks.A.state,'review_ready');assert.equal(x.p().tasks.A.attempts.length,2);assert.throws(()=>x.desktop.finishProject(x.identities.brain),/accepted/);
 x.task('F1',{allowedPaths:['A.txt'],dependsOn:['A']});const r2=x.definition(['F1'],'R2');assert.throws(()=>x.register(r2),/link/);r2.members[0].repairKeys=['stage:integration'];x.register(r2);await x.execute('F1','A.txt','fixed once');
 j=await x.claim('brain');assert.deepEqual(j.members.map(m=>m.taskId),['A','F1']);let evidence=JSON.parse(fs.readFileSync(path.join(j.cwd,'.dispatch-evidence/stage.json')));assert.equal(evidence.history.length,1);assert.deepEqual(evidence.repairs[0].repairKeys,['stage:integration']);x.final(j,x.verdict(j,false));
 x.task('F2',{allowedPaths:['A.txt'],dependsOn:['F1']});const r3=x.definition(['F2'],'R3');r3.members[0].repairKeys=['stage:integration'];x.register(r3);await x.execute('F2','A.txt','fully fixed');j=await x.claim('brain');assert.equal(j.members.length,3);x.final(j);
 assert.deepEqual(Object.values(x.p().tasks).map(v=>v.state),['accepted','accepted','accepted']);assert.equal(x.p().tasks.A.attempts.length,2);assert.equal(x.p().tasks.A.stageReviewRefs.length,3);assert.equal(x.p().reviewStages.R3.verdict,'pass');
});
test('preliminary rejection repairs the original task without waking a normal brain review',async t=>{
 const x=await setup(t);x.task('A');x.register(x.definition(['A']));let w=await x.claim('worker');fs.writeFileSync(path.join(x.workspace,'A.txt'),'bad');await x.submit(w);await x.submit(await x.claim('reviewer'),'needs_fix');assert.equal(x.p().tasks.A.state,'running');assert.equal(await x.claim('brain'),null);
 w=await x.claim('worker');fs.writeFileSync(path.join(x.workspace,'A.txt'),'good');await x.submit(w);await x.submit(await x.claim('reviewer'));const j=await x.claim('brain');assert.equal(j.kind,'stage_review');x.final(j);assert.equal(x.p().tasks.A.state,'accepted');
});
test('final pass requires complete member verdicts and an overall pass without findings',async t=>{
 const x=await setup(t);x.task('A');x.register(x.definition(['A']));await x.execute('A');const j=await x.claim('brain'),v=x.verdict(j);
 assert.throws(()=>x.final(j,{...v,members:[]}),/Complete/);assert.throws(()=>x.final(j,{...v,findings:[{key:'bug',message:'actual bug'}]}),/requires all/);
 assert.throws(()=>x.final(j,{...v,verdict:'needs_fix'}),/concrete issues/);assert.throws(()=>x.final(j,{...v,roundId:'wrong'}),/identity/);
 assert.throws(()=>stage.submit(x.desktop,x.identities.reviewer,{roundId:j.roundId,attemptId:j.attemptId,result:v}),/Only brain/);x.final(j);
});
test('out-of-band edits between tasks are not laundered by the next task snapshot',async t=>{
 const x=await setup(t);x.task('A');x.task('B');x.register();const w=await x.claim('worker');fs.writeFileSync(path.join(x.workspace,'A.txt'),'A');await x.submit(w);const r=await x.claim('reviewer');x.d.pause('p',true);await x.submit(r);fs.writeFileSync(path.join(x.workspace,'A.txt'),'polluted');x.d.pause('p',false);await x.execute('B');const j=await x.claim('brain');assert.equal(j.kind,'stage_attention');assert.match(x.p().reviewStages.R1.error,/polluted/);
});
test('final review rejects changed input files and stale workspace',async t=>{
 const x=await setup(t);x.task('A');x.register(x.definition(['A']));await x.execute('A');const j=await x.claim('brain');fs.writeFileSync(path.join(j.cwd,'A.txt'),'bad');assert.throws(()=>x.final(j),/input files/);fs.writeFileSync(path.join(j.cwd,'A.txt'),'A');fs.writeFileSync(path.join(x.workspace,'A.txt'),'bad');assert.throws(()=>x.final(j),/polluted/);assert.notEqual(x.p().tasks.A.state,'accepted');
});
test('reviewer disconnect blocks the stage instead of falling back to individual brain review',async t=>{
 const x=await setup(t);x.task('A');x.register(x.definition(['A']));const w=await x.claim('worker');x.d.reviewerPresence.clear();fs.writeFileSync(path.join(x.workspace,'A.txt'),'A');await x.submit(w);assert.equal((await x.claim('brain')).kind,'stage_attention');assert.equal(x.p().tasks.A.attempts.length,1);
 require('../runtime/core/pre-review.cjs').touch(x.d,x.identities.reviewer);stage.resume(x.desktop,x.identities.brain,{roundId:'R1'});await x.submit(await x.claim('reviewer'));assert.equal((await x.claim('brain')).kind,'stage_review');
});
test('durable whole-stage receipt survives storage contention and restart exactly once',async t=>{
 const x=await setup(t);x.task('A');x.register(x.definition(['A']));await x.execute('A');const j=await x.claim('brain'),original=fs.renameSync;let failing=true;
 t.mock.method(fs,'renameSync',(from,to)=>{if(failing&&to===x.store.file)throw Object.assign(Error('busy'),{code:'EPERM'});return original(from,to);});
 assert.equal(x.final(j).settlementPending,true);assert.equal(x.desktop.claim(x.identities.brain),null);failing=false;x.store.close();
 const nextStore=new Store(x.store.root);t.after(()=>nextStore.close());const next=new Dispatcher(nextStore,{enableRealCalls:false},()=>assert.fail('No calls'));next.recover();next.recover();assert.equal(nextStore.state.projects.p.tasks.A.state,'accepted');assert.equal(nextStore.state.events.filter(e=>e.type==='stage_review_settled').length,1);
});
test('failed-stage provenance stays protected from cleanup until all repairs pass',async t=>{
 const x=await setup(t);x.task('A');x.register(x.definition(['A']));await x.execute('A');const j=await x.claim('brain');x.final(j,x.verdict(j,false));const before=x.p().tasks.A.attempts[0].baselineId;
 const preview=require('../runtime/core/maintenance.cjs').plan(x.d,Date.now()+30*86400000);assert.ok(!preview.entries.some(e=>e.relative.includes(before)||e.relative.includes(x.p().reviewStages.R1.baselineId)));
});
test('stage budget reserves all members including a single-task stage',async t=>{
 const x=await setup(t);x.task('A',{maxAttempts:2});assert.throws(()=>x.register(x.definition(['A'])),/budget/);x.d.taskBudget('p','A',1,'reserve terminal review');x.register(x.definition(['A']));await x.execute('A');const j=await x.claim('brain');assert.equal(require('../runtime/core/attempts.cjs').counts(x.p().tasks.A).total,3);x.final(j);
});

test('integration checks rerun on the assembled stage and block false final passes',async t=>{
 const x=await setup(t);fs.mkdirSync(path.join(x.workspace,'node_modules'));fs.writeFileSync(path.join(x.workspace,'package.json'),JSON.stringify({scripts:{check:'node check.cjs'}}));fs.writeFileSync(path.join(x.workspace,'package-lock.json'),'{}');
 fs.writeFileSync(path.join(x.workspace,'check.cjs'),"const fs=require('fs');const passed=!(process.argv.includes('integrated')&&fs.existsSync('B.txt')&&fs.readFileSync('B.txt','utf8')==='bad');fs.writeFileSync('tmp/evidence.json',JSON.stringify({version:1,checks:[{id:'integration',passed,errors:passed?[]:[{path:'B.txt',message:'integration defect'}]}]}));");
 x.d.configureValidation('p',{dependencies:'copy-node-modules',checks:[['run','check','--','integrated']],evidenceResult:'tmp/evidence.json'},'integration');
 x.task('A',{validationProfile:'integration'});x.task('B');x.register();await x.execute('A');await x.execute('B','B.txt','bad');let j=await x.claim('brain');assert.equal(j.kind,'stage_review');assert.equal(x.p().reviewStages.R1.validationReports[0].passed,false);assert.throws(()=>x.final(j),/integration checks/);x.final(j,x.verdict(j,false));
 x.task('F',{allowedPaths:['B.txt']});const next=x.definition(['F'],'R2');next.members[0].repairKeys=['stage:integration'];x.register(next);await x.execute('F','B.txt','good');j=await x.claim('brain');assert.equal(x.p().reviewStages.R2.validationReports[0].passed,true);x.final(j);assert.equal(x.p().tasks.B.state,'accepted');
});

test('only brain can revise an unstarted stage contract at a paused idle boundary',async t=>{
 const x=await setup(t);x.task('A');x.task('B');x.d.pause('p',true);x.register();const task={...x.p().tasks.B,instructions:'updated internal work'};
 assert.throws(()=>x.desktop.reviseTask(x.identities.reviewer,{taskId:'B',task,reason:'unapproved'}),/Only brain/);
 const before=x.p().reviewStages.R1.contractHash;x.desktop.reviseTask(x.identities.brain,{taskId:'B',task,reason:'clarified scope'});assert.notEqual(x.p().reviewStages.R1.contractHash,before);assert.equal(x.p().reviewStages.R1.amendments[0].reason,'clarified scope');
 x.d.pause('p',false);await x.execute('A');await x.execute('B');const j=await x.claim('brain');assert.equal(j.kind,'stage_review');x.final(j);
 assert.throws(()=>x.desktop.reviseTask(x.identities.brain,{taskId:'B',task,reason:'rewrite history'}),/idle boundary/);
});

test('repair rounds must cover all issues and cannot switch stages while the old stage failed',async t=>{
 const x=await setup(t);x.task('A');x.register(x.definition(['A']));await x.execute('A');const j=await x.claim('brain'),v=x.verdict(j,false);v.findings.push({key:'regression',message:'Existing behavior regressed'});x.final(j,v);x.task('F');
 assert.throws(()=>x.register(x.definition(['F'],'R2','other-stage')),/unresolved/);const next=x.definition(['F'],'R2');next.members[0].repairKeys=['stage:integration'];assert.throws(()=>x.register(next),/every unresolved/);next.members[0].repairKeys.push('stage:regression');x.register(next);await x.execute('F');const final=await x.claim('brain');assert.equal(final.members.length,2);x.final(final);
});
const lifecycle=require('../runtime/core/lifecycle.cjs');
test('reset invalidates a claimed stage receipt and includes every original and repair task',async t=>{
 const x=await setup(t);x.task('A');x.register(x.definition(['A']));await x.execute('A');let j=await x.claim('brain');x.final(j,x.verdict(j,false));x.task('F',{allowedPaths:['A.txt']});const next=x.definition(['F'],'R2');next.members[0].repairKeys=['stage:integration'];x.register(next);await x.execute('F','A.txt','fixed');j=await x.claim('brain');
 const admin={d:x.d,monitor:{wake:{busy:false}}};x.d.pause('p',true);const input={action:'reset-task',projectId:'p',taskId:'A',reason:'restart whole stage',confirmed:true,confirmedStopped:true,confirmText:'A'};
 assert.throws(()=>lifecycle.apply(admin,input),/every original/);const result=lifecycle.apply(admin,{...input,resetDependents:true});assert.deepEqual(result.affectedTasks,['A','F']);assert.equal(x.p().reviewStages.R2.state,'reset');assert.throws(()=>x.final(j),/identity/);assert.deepEqual(Object.values(x.p().tasks).map(t=>t.state),['ready','ready']);
});
test('cascade reset expands downstream stage peers until the dependency graph is closed',()=>{
 const p={tasks:{A:{id:'A'},B:{id:'B',dependsOn:['A']},C:{id:'C'},D:{id:'D',dependsOn:['C']},E:{id:'E'}},reviewStages:{later:{reviewTaskIds:['D','E']},earlier:{reviewTaskIds:['B','C']}}};
 assert.deepEqual(new Set(lifecycle.descendants(p,'A')),new Set(['A','B','C','D','E']));
});
