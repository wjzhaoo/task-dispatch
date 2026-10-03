// [AI-added] 2026-09-26 16:00: Scope recovery retains business work inside stage execution.
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {setup}=require('./stage-fixture.cjs');
const scope=require('../runtime/core/scope-recovery.cjs');
async function fixture(t){const x=await setup(t);fs.mkdirSync(path.join(x.workspace,'docs/plans'),{recursive:true});fs.writeFileSync(path.join(x.workspace,'docs/plans/plan.md'),'brain plan');fs.writeFileSync(path.join(x.workspace,'code.txt'),'original');x.task('T',{allowedPaths:['code.txt','docs/plans/']});x.register(x.definition(['T']));return x;}
test('scope correction keeps business diff and restores only the exact protected original',async t=>{
 const x=await fixture(t),plan=path.join(x.workspace,'docs/plans/plan.md');let w=await x.claim('worker');fs.writeFileSync(path.join(x.workspace,'code.txt'),'fixed');fs.appendFileSync(plan,'bad');await x.submit(w);
 w=await x.claim('worker');assert.ok(x.p().tasks.T.scopeRecovery);assert.equal(fs.readFileSync(path.join(x.workspace,'code.txt'),'utf8'),'fixed');fs.writeFileSync(plan,'brain plan');await x.submit(w);const r=await x.claim('reviewer');assert.equal(fs.readFileSync(path.join(r.cwd,'.dispatch-evidence/before/code.txt'),'utf8'),'original');assert.ok(fs.existsSync(path.join(r.cwd,'.dispatch-evidence/scope-recovery.json')));await x.submit(r);const j=await x.claim('brain');x.final(j);assert.equal(x.p().tasks.T.state,'accepted');
});
test('brain control-file drift is allowed but changed business code is stale',async t=>{
 const x=await fixture(t);const w=await x.claim('worker');fs.writeFileSync(path.join(x.workspace,'code.txt'),'fixed');x.d.pause('p',true);await x.submit(w);fs.appendFileSync(path.join(x.workspace,'docs/plans/plan.md'),' brain update');x.d.pause('p',false);const r=await x.claim('reviewer');await x.submit(r);x.final(await x.claim('brain'));assert.equal(x.p().tasks.T.state,'accepted');
 const y=await fixture(t),wy=await y.claim('worker');fs.writeFileSync(path.join(y.workspace,'code.txt'),'fixed');y.d.pause('p',true);await y.submit(wy);fs.writeFileSync(path.join(y.workspace,'code.txt'),'external');y.d.pause('p',false);await y.drain();assert.match(y.p().tasks.T.error,/stale/);
});
test('plans and reviews are protected even when broadly allowed; task results stay task-specific',()=>{
 assert.equal(scope.writable('docs/worker-results/T/result.md',['docs/worker-results/'],'T'),true);assert.equal(scope.writable('docs/worker-results/T/result.md',['docs/worker-results/'],'OTHER'),false);
 for(const f of ['docs/plans/T.md','docs/reviews/T.md','DOCS/PLANS/x.md','.task-dispatch/tasks/T.md','contract.md'])assert.equal(scope.writable(f,[f],'T'),false);
});
test('protected-only task reports scope attention before spending a worker attempt',async t=>{
 const x=await setup(t);x.task('T',{allowedPaths:['docs/plans/T.md']});x.register(x.definition(['T']));await x.drain();assert.equal(x.p().tasks.T.state,'blocked');assert.equal(x.p().turns,0);assert.equal((await x.claim('brain')).kind,'scope_attention');
});
test('two failed scope corrections escalate and never accept or overwrite another edit',async t=>{
 const x=await fixture(t);let w=await x.claim('worker');const plan=path.join(x.workspace,'docs/plans/plan.md');fs.appendFileSync(plan,'bad');await x.submit(w);for(let i=0;i<2;i++){w=await x.claim('worker');await x.submit(w);}assert.equal(x.p().tasks.T.state,'blocked');assert.equal(x.p().tasks.T.scopeReturns,3);assert.ok(x.p().tasks.T.scopeAlert);
});
test('concurrent protected edits stop scope correction rather than overwriting other work',async t=>{
 const x=await fixture(t),w=await x.claim('worker'),plan=path.join(x.workspace,'docs/plans/plan.md');fs.appendFileSync(plan,'bad');x.d.pause('p',true);await x.submit(w);fs.appendFileSync(plan,' another writer');x.d.pause('p',false);await x.drain();assert.equal(x.p().tasks.T.state,'blocked');assert.ok(fs.readFileSync(plan,'utf8').endsWith('another writer'));
});
