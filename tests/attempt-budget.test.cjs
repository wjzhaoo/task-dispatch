// [AI-added] 2026-09-26 16:00: Attempt budgets across execution, preliminary review and stage repair rounds.
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs'),path=require('node:path');
const {setup}=require('./stage-fixture.cjs'),stage=require('../runtime/core/stage-review.cjs');
const {counts}=require('../runtime/core/attempts.cjs');
const {Store}=require('../runtime/core/storage.cjs'),{Dispatcher}=require('../runtime/core/dispatcher.cjs'),{Desktop}=require('../runtime/core/desktop.cjs');
test('claims and restart preserve the same attempt and accumulated project usage',async t=>{
 const x=await setup(t);x.store.change(s=>s.projects.p.turns=300);x.task('A');x.register(x.definition(['A']));const first=await x.claim('worker');assert.equal(x.p().turns,301);assert.equal(x.desktop.claim(x.identities.worker).attemptId,first.attemptId);x.store.close();const store=new Store(x.store.root);t.after(()=>store.close());const d=new Dispatcher(store,{maxConcurrent:2}),desktop=new Desktop(d);d.recover();assert.equal(desktop.claim(x.identities.worker).attemptId,first.attemptId);assert.deepEqual(counts(store.state.projects.p.tasks.A),{execution:1,review:0,total:1});
});
test('initial stage registration reserves execution, preliminary review and final review',async t=>{
 const x=await setup(t);x.task('A',{maxAttempts:2});assert.throws(()=>x.register(x.definition(['A'])),/budget/);assert.equal(counts(x.p().tasks.A).total,0);assert.throws(()=>x.desktop.taskBudget(x.identities.worker,{taskId:'A',additionalAttempts:2,reason:'more'}),/Only brain/);assert.throws(()=>x.d.taskBudget('p','A',2,''),/reason/i);x.desktop.taskBudget(x.identities.brain,{taskId:'A',additionalAttempts:1,reason:'reserve final review'});x.register(x.definition(['A']));await x.execute('A');x.final(await x.claim('brain'));assert.equal(counts(x.p().tasks.A).total,3);
});
test('failed preliminary review and repairs share the same allowance; explicit extension resumes',async t=>{
 const x=await setup(t);x.task('A',{maxAttempts:3});x.register(x.definition(['A']));let w=await x.claim('worker');await x.submit(w);await x.submit(await x.claim('reviewer'),'needs_fix');w=await x.claim('worker');await x.submit(w);assert.equal(counts(x.p().tasks.A).total,3);assert.equal(x.p().reviewStages.R1.state,'blocked');assert.equal(await x.claim('reviewer'),null);x.desktop.taskBudget(x.identities.brain,{taskId:'A',additionalAttempts:2,reason:'repair review and final acceptance'});stage.resume(x.desktop,x.identities.brain,{roundId:'R1'});await x.submit(await x.claim('reviewer'));x.final(await x.claim('brain'));assert.equal(counts(x.p().tasks.A).total,5);
});
test('worker upgrades remain on the selected task and do not change the next task plan',async t=>{
 const x=await setup(t);const strong=x.desktop.attach({workspace:x.workspace,role:'worker',workerId:'strong',clientId:'strong-worker',token:crypto.randomBytes(32).toString('hex')});x.task('A');x.task('B',{dependsOn:['A']});x.register();const a=await x.claim('worker');await x.drain();x.d.block('p','A',a.attemptId,'blocked','needs stronger worker');assert.throws(()=>x.desktop.assign(x.identities.brain,{taskId:'A',workerId:'strong'}),/reason/);x.desktop.assign(x.identities.brain,{taskId:'A',workerId:'strong',reason:'hard repair',retry:true});await x.drain();const upgraded=x.desktop.claim(strong);assert.equal(upgraded.taskId,'A');assert.equal(x.p().tasks.A.plannedWorkerId,'default');assert.equal(x.p().tasks.A.currentWorkerId,'strong');assert.equal(x.p().tasks.B.currentWorkerId,'default');assert.equal(x.p().tasks.A.maxAttempts,30);
});
test('project protection remains opt-in and extension retains cumulative attempts',async t=>{
 const x=await setup(t);x.task('A');x.register(x.definition(['A']));x.d.budget('p',1);const w=await x.claim('worker');await x.submit(w);assert.equal(x.p().paused,true);assert.equal(x.p().turns,1);x.d.budget('p',null);x.d.pause('p',false);await x.submit(await x.claim('reviewer'));x.final(await x.claim('brain'));assert.equal(x.p().turns,3);assert.equal(x.p().projectBudgetEnabled,false);
});
test('successive final reviews count once per participant and do not reset original budgets',async t=>{
 const x=await setup(t);x.task('A');x.register(x.definition(['A']));await x.execute('A');let j=await x.claim('brain');x.final(j,x.verdict(j,false));assert.equal(counts(x.p().tasks.A).total,3);x.task('F',{allowedPaths:['A.txt']});const r=x.definition(['F'],'R2');r.members[0].repairKeys=['stage:integration'];x.register(r);await x.execute('F','A.txt','fixed');j=await x.claim('brain');x.final(j);x.final(j);assert.equal(counts(x.p().tasks.A).total,4);assert.equal(counts(x.p().tasks.F).total,3);assert.equal(x.p().turns,6);
});
