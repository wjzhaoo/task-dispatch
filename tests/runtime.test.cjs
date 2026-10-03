// [AI-added] 2026-09-26 16:00: Runtime invariants exercised through the mandatory stage workflow.
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {setup,peers}=require('./stage-fixture.cjs');
const {Store,atomic}=require('../runtime/core/storage.cjs');
const {Dispatcher}=require('../runtime/core/dispatcher.cjs');
const {Desktop}=require('../runtime/core/desktop.cjs');
const stage=require('../runtime/core/stage-review.cjs');
test('legacy state and headless single-task projects are rejected without rewriting source data',async t=>{
 const x=await setup(t);assert.throws(()=>x.d.addProject({id:'old',workspace:x.workspace,brain:'a',worker:'a'}),/headless/);
 const oldRoot=path.join(x.dir,'old');atomic(path.join(oldRoot,'state.json'),{version:1,projects:{},events:[]});const before=fs.readFileSync(path.join(oldRoot,'state.json'));assert.throws(()=>new Store(oldRoot),/not migrated/);assert.deepEqual(fs.readFileSync(path.join(oldRoot,'state.json')),before);
});
test('worker identity spoofing blocks the candidate and cannot issue a verdict',async t=>{
 const x=await setup(t);x.task('A');x.register(x.definition(['A']));const j=await x.claim('worker');
 assert.throws(()=>x.desktop.submit(x.identities.worker,{taskId:'A',attemptId:j.attemptId,result:{projectId:'p',taskId:'A',attemptId:j.attemptId,role:'brain',verdict:'pass',summary:'spoof'}}),/identity/);assert.notEqual(x.p().tasks.A.state,'accepted');
});
test('stored candidate tampering blocks review rather than accepting an altered snapshot',async t=>{
 const x=await setup(t);x.task('A');x.register(x.definition(['A']));const j=await x.claim('worker');fs.writeFileSync(path.join(x.workspace,'A.txt'),'A');x.d.pause('p',true);await x.submit(j);
 fs.writeFileSync(path.join(x.d.artifacts,x.p().tasks.A.artifactId,'tree','A.txt'),'tampered');x.d.pause('p',false);await x.drain();assert.match(x.p().tasks.A.error,/integrity/);assert.equal(x.p().tasks.A.state,'blocked');
});
test('uncertain tasks preserve the workspace lock and require confirmed stopped recovery',async t=>{
 const x=await setup(t);x.task('A');x.task('B');x.register();const j=await x.claim('worker');await x.drain();x.d.block('p','A',j.attemptId,'uncertain','lost process');await x.drain();assert.equal(x.p().tasks.B.attempts.length,0);assert.throws(()=>x.d.retry('p','A',false),/Confirm/);x.d.retry('p','A',true);assert.equal(x.p().tasks.A.state,'ready');
});
test('durable worker receipt recovers the same attempt without running the worker again',async t=>{
 const x=await setup(t);x.task('A');x.register(x.definition(['A']));const j=await x.claim('worker');fs.writeFileSync(path.join(x.workspace,'A.txt'),'A');x.d.pause('p',true);const settle=x.d.settle;x.d.settle=()=>false;await x.submit(j);assert.equal(x.p().tasks.A.state,'running');x.d.settle=settle;x.d.recover();assert.equal(x.p().tasks.A.state,'review_ready');assert.equal(x.p().tasks.A.attempts.length,1);
});
test('service restart without durable delivery or receipt marks execution uncertain and preserves a live lock',async t=>{
 const x=await setup(t);x.task('A');x.register(x.definition(['A']));await x.claim('worker');x.store.change(s=>delete s.projects.p.tasks.A.attempts[0].delivery);x.d.recover();assert.equal(x.p().tasks.A.state,'uncertain');assert.throws(()=>Store.unlock(x.store.root),/alive/);assert.throws(()=>new Store(x.store.root),/lock/);
});
test('distinct projects progress concurrently while each workspace remains serial',async t=>{
 const x=await setup(t);x.task('A');x.task('B');x.register();await x.claim('worker');const workspace=path.join(x.dir,'second');fs.mkdirSync(workspace);x.d.addProject({id:'q',workspace,mode:'desktop'});
 const desktop=new Desktop(x.d),worker=desktop.attach({workspace,role:'worker',clientId:'second-worker',token:'f'.repeat(64)}),{brain}=peers(desktop,'q');require('../runtime/core/startup.cjs').start(desktop,brain,{confirmed:true});desktop.plan(brain,{id:'Q',title:'Q',instructions:'implement',acceptance:'correct',allowedPaths:['Q.txt']});stage.register(desktop,brain,{stageId:'q',roundId:'q1',milestone:'Q',acceptance:'correct',members:[{taskId:'Q'}]});await x.drain();assert.equal(desktop.claim(worker).taskId,'Q');assert.equal(x.p().tasks.B.attempts.length,0);assert.throws(()=>x.d.addProject({id:'overlap',workspace:x.workspace,mode:'desktop'}),/Overlapping/);
});
test('stage review blocks at project budget without resetting cumulative usage',async t=>{
 const x=await setup(t);x.task('A');x.register(x.definition(['A']));x.d.budget('p',2);await x.execute('A');assert.match(x.p().reviewStages.R1.error,/budget/);assert.equal(x.p().turns,2);x.d.budget('p',3);stage.resume(x.desktop,x.identities.brain,{roundId:'R1'});const j=await x.claim('brain');x.final(j);assert.equal(x.p().turns,3);assert.equal(x.p().tasks.A.state,'accepted');
});
