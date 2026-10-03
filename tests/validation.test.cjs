const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {snapshot}=require('../runtime/core/snapshot.cjs');
const {prepare}=require('../runtime/core/validation.cjs');
// [AI-added] 2026-09-22 09:20: New evidence and isolation regression cases.
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'review-validation-')),workspace=path.join(root,'work');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({scripts:{check:'node check.cjs'}}));fs.writeFileSync(path.join(workspace,'package-lock.json'),'{}');fs.writeFileSync(path.join(workspace,'check.cjs'),'');fs.mkdirSync(path.join(workspace,'node_modules'));fs.writeFileSync(path.join(workspace,'node_modules','dependency'),'installed');const artifacts=path.join(root,'artifacts'),a=snapshot(workspace,artifacts);return {workspace,artifacts,artifactId:a.id,artifactHash:a.hash,root:path.join(root,'validation'),config:{dependencies:'copy-node-modules',checks:[['run','check']]}};}
test('dependencies copied independently; outputs permitted but source protected',async()=>{
 const x=fixture();const r=await prepare({...x,runner:async(args,cwd)=>{assert.equal(fs.readFileSync(path.join(cwd,'node_modules','dependency'),'utf8'),'installed');fs.writeFileSync(path.join(cwd,'tmp','test-result'),'ok');return {args,exitCode:0,output:'pass'};}});
 assert.equal(r.passed,true);assert.equal(fs.existsSync(path.join(x.workspace,'tmp')),false);
 const y=fixture();await assert.rejects(prepare({...y,runner:async(args,cwd)=>{fs.writeFileSync(path.join(cwd,'check.cjs'),'changed');return {args,exitCode:0};}}),/changed candidate/);
});
test('mismatched lock blocks before executing checks',async()=>{
 const x=fixture();fs.writeFileSync(path.join(x.workspace,'package-lock.json'),'changed');let called=false;await assert.rejects(prepare({...x,runner:async()=>{called=true;}}),/differs/);assert.equal(called,false);
});
test('failed checks stay explicit, no false passing report',async()=>{
 const x=fixture();const r=await prepare({...x,runner:async args=>({args,exitCode:1,output:'assertion failed'})});assert.equal(r.passed,false);
});
test('evidence gate validates structure, identity and command status',async()=>{
 const good={version:1,artifactId:'untrusted',checks:[{id:'ledger',passed:true,errors:[]}]};
 for(const [value,exitCode,passed] of [[good,0,true],[good,1,false],[null,0,false],[{version:2,checks:good.checks},0,false],[{version:1,checks:[]},0,false],[{version:1,checks:[{id:'ledger',passed:false,errors:[{path:'report',message:'mismatch'}]}]},0,false],[{version:1,checks:[...good.checks,...good.checks]},0,false]]){
  const x=fixture();x.config.evidenceResult='tmp/evidence.json';
  const r=await prepare({...x,runner:async(args,cwd)=>{if(value)fs.writeFileSync(path.join(cwd,'tmp/evidence.json'),JSON.stringify(value));return {args,exitCode};}});
  assert.equal(r.passed,passed);const report=JSON.parse(fs.readFileSync(r.reportPath));
  assert.equal(report.evidence.artifactId,x.artifactId);assert.equal(report.evidence.artifactHash,x.artifactHash);
  assert.equal(fs.existsSync(path.join(x.workspace,'tmp')),false);
  assert.equal(fs.existsSync(path.join(x.artifacts,x.artifactId,'tree/tmp/evidence.json')),false);
 }
 const policy=require('../runtime/core/validation.cjs').policy;
 for(const name of ['../result.json','/tmp/result.json','check.cjs','tmp/','tmp//result.json'])assert.throws(()=>policy({...fixture().config,evidenceResult:name}));
 const x=fixture();const r=await prepare({...x,runner:async args=>({args,exitCode:0})});assert.equal(JSON.parse(fs.readFileSync(r.reportPath)).evidence.status,'not_configured');
});
test('offline example rejects inconsistent totals, call partitions, state and missing material',()=>{
 const {generate,validate}=require('../examples/evidence-validation/check.cjs');
 const original=require('../examples/evidence-validation/fixture.json');
 assert.deepEqual(generate(original),original.report);assert.ok(validate(original).checks.every(c=>c.passed));
 for(const mutate of [d=>d.report.totalCalls++,d=>d.ledger[2].index=1,d=>d.ledger.pop(),d=>d.report.scenarios[0].status='failed',d=>d.anonymous[1].shots=[]]){
  const data=structuredClone(original);mutate(data);assert.ok(validate(data).checks.some(c=>!c.passed));
 }
});
test('source mutation persists complete paths while leaving original candidate intact',async()=>{
 const x=fixture();await assert.rejects(prepare({...x,runner:async(args,cwd)=>{fs.writeFileSync(path.join(cwd,'check.cjs'),'bad');return {args,exitCode:0};}}),/check\.cjs/);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.root,'report.json'))).changedPaths,['check.cjs']);
 assert.equal(fs.readFileSync(path.join(x.workspace,'check.cjs'),'utf8'),'');
 assert.equal(fs.readFileSync(path.join(x.artifacts,x.artifactId,'tree/check.cjs'),'utf8'),'');
});
test('configured failed evidence stops before a reviewer can receive the attempt',async t=>{
 const x=fixture(),{Store}=require('../runtime/core/storage.cjs'),{Dispatcher}=require('../runtime/core/dispatcher.cjs');
 const store=new Store(path.join(path.dirname(x.root),'state'));t.after(()=>store.close());
 const d=new Dispatcher(store,{enableRealCalls:false},()=>assert.fail('no model'));d.addProject({id:'p',workspace:x.workspace,mode:'desktop'});
 store.change(s=>s.projects.p.startup={state:'started'});d.addTask('p',{id:'T',title:'t',instructions:'i',acceptance:'a',allowedPaths:['check.cjs']});
 const a=snapshot(x.workspace,d.artifacts);store.change(s=>Object.assign(s.projects.p.tasks.T,{state:'review_ready',artifactId:a.id,artifactHash:a.hash,changedFiles:[],attempts:[{id:'worker',role:'worker',settled:true,baselineId:a.id}]}));
 d.configureValidation('p',{...x.config,evidenceResult:'tmp/absent.json'});
 require('./stage-fixture.cjs').peers(new (require('../runtime/core/desktop.cjs').Desktop)(d),'p');store.change(s=>{s.projects.p.tasks.T.roundId='fixture';});
 await d.execute('p','T');const task=store.state.projects.p.tasks.T;
 assert.equal(task.state,'blocked');assert.equal(task.blockKind,'evidence');assert.equal(task.attempts.at(-1).delivery,undefined);
 assert.equal(task.attempts.at(-1).validation.passed,false);
});
test('dispatcher preserves candidate on environment block and retries review only',async t=>{
 const x=fixture();const {Store}=require('../runtime/core/storage.cjs');const {Dispatcher}=require('../runtime/core/dispatcher.cjs');
 const store=new Store(path.join(path.dirname(x.root),'state'));t.after(()=>store.close());
 const d=new Dispatcher(store,{enableRealCalls:false},()=>{});d.addProject({id:'p',workspace:x.workspace,mode:'desktop'});store.change(s=>{s.projects.p.startup={state:'started'};});d.addTask('p',{id:'T',title:'t',instructions:'i',acceptance:'a',allowedPaths:['check.cjs']});
 const a=snapshot(x.workspace,d.artifacts);
 store.change(s=>{Object.assign(s.projects.p.tasks.T,{state:'review_ready',artifactId:a.id,artifactHash:a.hash,changedFiles:[],attempts:[{id:'worker',role:'worker',baselineId:a.id,settled:true}]});});
 d.configureValidation('p',x.config);fs.writeFileSync(path.join(x.workspace,'node_modules','dependency'),'installed');
 // Candidate package files must match live source for dependency reuse.
 fs.renameSync(path.join(x.workspace,'node_modules'),path.join(x.workspace,'saved-dependencies'));
 // Move saved dependencies outside the workspace to avoid a stale-source failure.
 fs.renameSync(path.join(x.workspace,'saved-dependencies'),path.join(path.dirname(x.root),'saved-dependencies'));
 require('./stage-fixture.cjs').peers(new (require('../runtime/core/desktop.cjs').Desktop)(d),'p');store.change(s=>{s.projects.p.tasks.T.roundId='fixture';});await d.execute('p','T');assert.equal(store.state.projects.p.tasks.T.blockKind,'environment');
 fs.renameSync(path.join(path.dirname(x.root),'saved-dependencies'),path.join(x.workspace,'node_modules'));
 d.retry('p','T',false);await d.execute('p','T');
 const task=store.state.projects.p.tasks.T;assert.equal(task.state,'reviewing');assert.equal(task.artifactId,a.id);assert.equal(task.attempts.filter(a=>a.role==='worker').length,1);assert.equal(task.attempts.at(-1).validation.passed,true);assert.match(task.attempts.at(-1).delivery.prompt,/validation/);
});
