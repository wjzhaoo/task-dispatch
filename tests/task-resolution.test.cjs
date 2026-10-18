'use strict';
const {registerDesktop}=require('./service-fixture.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {Store}=require('../runtime/core/storage.cjs');
const {Dispatcher}=require('../runtime/core/dispatcher.cjs');
const {Desktop}=require('../runtime/core/desktop.cjs');
const {Monitor}=require('../runtime/core/monitor.cjs');
const {initialize,request}=require('../runtime/wizard.cjs');
const {serve}=require('./service-fixture.cjs');
const {call}=require('../runtime/desktop-client.cjs');

function temporary(t,prefix){
 const root=fs.mkdtempSync(path.resolve('tmp/'+prefix));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return root;
}

function runtime(t){
 const root=temporary(t,'task-resolution-'),workspace=path.join(root,'work');
 fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'README.md'),'base');
 const store=new Store(path.join(root,'data'));t.after(()=>store.close());
 const d=new Dispatcher(store,{maxConcurrent:2});
 d.addProject({id:'p',workspace,mode:'desktop'});store.change(s=>s.projects.p.startup={state:'started'});
 const step=async()=>{d.tick();await Promise.all([...d.active.values()].map(item=>item.promise));};
 return {root,workspace,store,d,step,project:()=>store.state.projects.p};
}

function blocked(d,id='OLD'){
 d.addTask('p',{id,title:'old',instructions:'old work',acceptance:'old accepted',allowedPaths:['README.md']});
 d.store.change(s=>{const task=s.projects.p.tasks[id];task.state='blocked';task.error='historic failure';task.blockKind='review';task.attempts=[{id:'settled-'+id,contractRevision:1,role:'brain',settled:true}];task.attention={id:'alert-'+id,message:'historic failure',kind:'blocked',acknowledged:false};});
}

test('brain attention deferral is explicit through the authenticated CLI and stays visible',async t=>{
 const dir=temporary(t,'brain-attention-http-'),workspace=path.join(dir,'work'),root=path.join(dir,'data');
 fs.mkdirSync(workspace);initialize(root);const s=await serve(root);t.after(()=>s.close());
 const brain=await registerDesktop(root,{workspace,role:'brain',clientId:'brain-client',token:'b'.repeat(64)});
 s.store.change(state=>{state.projects[brain.projectId].startup={state:'started'};});
 s.dispatcher.addTask(brain.projectId,{id:'T',title:'T',instructions:'i',acceptance:'a',allowedPaths:['README.md']});
 s.store.change(state=>{const p=state.projects[brain.projectId];p.startup={state:'started'};p.tasks.T.state='blocked';p.tasks.T.error='missing permission';});
 require('../runtime/core/brain-attention.cjs').raise(s.dispatcher,brain.projectId,'T','missing permission');
 const alertId=s.store.state.projects[brain.projectId].tasks.T.attention.id,file=path.join(root,'brain.json');
 fs.writeFileSync(file,JSON.stringify({...brain,data:root,workspace}));
 const exec=require('node:util').promisify(require('node:child_process').execFile);
 const args=[path.resolve('runtime/desktop-client.cjs'),'attention-ack','--task','T','--alert-id',alertId,'--credential',file,'--data',root];
 await assert.rejects(exec(process.execPath,args,{windowsHide:true}),/任务仍然阻塞/);
 assert.equal(JSON.parse((await exec(process.execPath,[...args,'--wait-reason','需要用户提供测试环境权限'],{windowsHide:true})).stdout).ok,true);
 const status=await call(root,brain,{action:'status'});
 assert.equal(status.tasks.find(task=>task.id==='T').attention.waitReason,'需要用户提供测试环境权限');
 assert.ok(s.monitor.snapshot().projects[0].alerts.some(alert=>alert.code==='waiting_user'));
});

test('accepted stage replacement resolves old blocks and subsequent stages can depend on them',async t=>{
 const x=await require('./stage-fixture.cjs').setup(t);blocked(x.d);x.task('FIX',{supersedes:['OLD'],supersedeReason:'FIX fully replaces OLD'});x.register(x.definition(['FIX']));require('../runtime/core/brain-attention.cjs').acknowledge(x.desktop,x.identities.brain,{taskId:'OLD',alertId:'alert-OLD'});assert.equal(x.p().tasks.OLD.attention.remediationTaskId,'FIX');await x.execute('FIX');x.final(await x.claim('brain'));assert.equal(x.p().tasks.OLD.state,'resolved');assert.equal(x.p().tasks.OLD.resolution.replacementTaskId,'FIX');
 x.task('NEXT',{dependsOn:['OLD']});x.register(x.definition(['NEXT'],'next-round','next-stage'));await x.execute('NEXT');x.final(await x.claim('brain'));assert.doesNotThrow(()=>x.d.finishProject('p'));
});

test('replacement relationships reject unsafe or ambiguous resolution',t=>{
 const x=runtime(t);
 blocked(x.d);
 x.d.addTask('p',{id:'FIX',title:'replacement',instructions:'fix',acceptance:'fixed',allowedPaths:['README.md'],supersedes:['OLD'],supersedeReason:'replace old'});
 assert.throws(()=>x.d.addTask('p',{id:'FIX2',title:'other',instructions:'fix',acceptance:'fixed',allowedPaths:['README.md'],supersedes:['OLD'],supersedeReason:'also replace'}),/unfinished replacement/);
 assert.throws(()=>x.d.resolveTask('p','OLD','FIX','not accepted'),/must be accepted/);
 x.store.change(s=>{s.projects.p.tasks.FIX.state='accepted';});
 assert.equal(x.d.resolveTask('p','OLD','FIX','manual verified replacement').ok,true);
 assert.throws(()=>x.d.resolveTask('p','OLD','FIX','different reason'),/Conflicting/);
 blocked(x.d,'UNCERTAIN');
 x.store.change(s=>{s.projects.p.tasks.UNCERTAIN.state='uncertain';});
 assert.throws(()=>x.d.resolveTask('p','UNCERTAIN','FIX','unsafe'),/Only a blocked task/);
 x.d.addTask('p',{id:'FUTURE',title:'future',instructions:'future',acceptance:'future',allowedPaths:['README.md']});
 blocked(x.d,'CYCLE');x.store.change(s=>{s.projects.p.tasks.CYCLE.supersedes=['FUTURE'];});
 assert.throws(()=>x.d.reviseTask('p','FUTURE',{id:'FUTURE',title:'future',instructions:'future',acceptance:'future',allowedPaths:['README.md'],supersedes:['CYCLE'],supersedeReason:'invalid cycle'},'invalid cycle'),/would create a cycle/);
});

test('brain can revise unstarted contracts and use guarded recovery operations',t=>{
 const root=temporary(t,'brain-control-'),workspace=path.join(root,'work');fs.mkdirSync(workspace);
 const store=new Store(path.join(root,'data'));t.after(()=>store.close());
 const d=new Dispatcher(store,{maxConcurrent:2}),desktop=new Desktop(d);
 desktop.attach({workspace,role:'brain',clientId:'brain-client',token:'b'.repeat(64)});
 desktop.attach({workspace,role:'reviewer',clientId:'reviewer-client',token:'c'.repeat(64)});
 const brain=desktop.authenticate('b'.repeat(64)),other=desktop.authenticate('c'.repeat(64)),projectId=brain.projectId;
 store.change(s=>{s.projects[projectId].startup={state:'started'};});
 d.addTask(projectId,{id:'FUTURE',title:'future',instructions:'v1',acceptance:'a1',allowedPaths:['README.md']});
 const v2={id:'FUTURE',title:'future revised',instructions:'v2',acceptance:'a2',allowedPaths:['README.md'],dependsOn:[]};
 assert.throws(()=>desktop.reviseTask(other,{taskId:'FUTURE',task:v2,reason:'change'}),/Only brain/);
 assert.equal(desktop.reviseTask(brain,{taskId:'FUTURE',task:v2,reason:'new evidence'}).contractRevision,2);
 assert.equal(store.state.projects[projectId].tasks.FUTURE.instructionHistory[0].reason,'new evidence');
 store.change(s=>{s.projects[projectId].tasks.FUTURE.attempts.push({id:'done',contractRevision:2,role:'worker',settled:true});});
 assert.throws(()=>desktop.reviseTask(brain,{taskId:'FUTURE',task:v2,reason:'late change'}),/replacement task/);
 d.addTask(projectId,{id:'RETRY',title:'retry',instructions:'i',acceptance:'a',allowedPaths:['README.md']});
 store.change(s=>{const task=s.projects[projectId].tasks.RETRY;task.state='blocked';task.error='boom';task.resumePhase='worker';task.attention={id:'alert',message:'boom',kind:'blocked',acknowledged:false};});
 assert.throws(()=>desktop.retry(other,{taskId:'RETRY',reason:'worker cannot'}),/Only brain/);
 assert.equal(desktop.retry(brain,{taskId:'RETRY',reason:'precondition restored'}).state,'ready');
 assert.equal(store.state.projects[projectId].tasks.RETRY.attention.acknowledged,true);
});

test('monitor and status expose resolved evidence without an active alert',t=>{
 const x=runtime(t),desktop=new Desktop(x.d);
 x.store.change(s=>{s.projects.p.mode='desktop';s.projects.p.startup={state:'started'};});
 desktop.attach({workspace:x.workspace,role:'brain',clientId:'brain-client',token:'b'.repeat(64)});
 const brain=desktop.authenticate('b'.repeat(64));
 blocked(x.d);x.d.addTask('p',{id:'FIX',title:'fix',instructions:'i',acceptance:'a',allowedPaths:['README.md']});
 x.store.change(s=>{s.projects.p.tasks.FIX.state='accepted';});desktop.resolveTask(brain,{taskId:'OLD',replacementTaskId:'FIX',reason:'accepted replacement'});
 const status=desktop.status(brain),task=status.tasks.find(item=>item.id==='OLD');
 assert.equal(task.state,'resolved');assert.equal(task.resolution.replacementTaskId,'FIX');assert.equal(task.contractRevision,1);
 const monitor=new Monitor(x.store,x.d,{error:null});t.after(()=>monitor.close());
 const project=monitor.snapshot().projects.find(item=>item.id==='p');
 assert.equal(project.tasks.find(item=>item.id==='OLD').state,'resolved');
 assert.ok(!project.alerts.some(alert=>alert.taskId==='OLD'&&['blocked','task_attention'].includes(alert.code)));
});

test('brain recovery actions work through the authenticated desktop HTTP routes',async t=>{
 const container=temporary(t,'brain-http-'),root=path.join(container,'data'),workspace=path.join(container,'work');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'README.md'),'base');initialize(root);
 const service=await serve(root);t.after(()=>service.close());
 const brain=await registerDesktop(root,{workspace,role:'brain',clientId:'brain-client',token:'b'.repeat(64)});
 const reviewer=await registerDesktop(root,{workspace,role:'reviewer',clientId:'reviewer-client',token:'c'.repeat(64)});
 await registerDesktop(root,{workspace,role:'worker',clientId:'worker-client',token:'d'.repeat(64)});
 await call(root,reviewer,{action:'heartbeat'});
 await call(root,brain,{action:'start-work',confirmed:true});
 service.store.change(s=>{s.projects[brain.projectId].paused=true;});
 service.dispatcher.addTask(brain.projectId,{id:'FUTURE',title:'future',instructions:'v1',acceptance:'a1',allowedPaths:['README.md']});
 const revised=await call(root,brain,{action:'revise-task',taskId:'FUTURE',task:{id:'FUTURE',title:'future v2',instructions:'v2',acceptance:'a2',allowedPaths:['README.md']},reason:'new plan evidence'});
 assert.equal(revised.contractRevision,2);
 await assert.rejects(call(root,reviewer,{action:'revise-task',taskId:'FUTURE',task:{id:'FUTURE',title:'x',instructions:'x',acceptance:'x',allowedPaths:['README.md']},reason:'unauthorized'}),/Only brain/);
 service.dispatcher.addTask(brain.projectId,{id:'OLD',title:'old',instructions:'old',acceptance:'old',allowedPaths:['README.md']});
 service.dispatcher.addTask(brain.projectId,{id:'FIX',title:'fix',instructions:'fix',acceptance:'fixed',allowedPaths:['README.md']});
 service.store.change(s=>{const tasks=s.projects[brain.projectId].tasks;tasks.OLD.state='blocked';tasks.OLD.error='historic';tasks.OLD.attempts=[{id:'old-attempt',contractRevision:1,role:'worker',settled:true}];tasks.FIX.state='accepted';});
 assert.equal((await call(root,brain,{action:'resolve-task',taskId:'OLD',replacementTaskId:'FIX',reason:'accepted replacement'})).ok,true);
 service.dispatcher.addTask(brain.projectId,{id:'RETRY',title:'retry',instructions:'retry',acceptance:'retried',allowedPaths:['README.md']});
 service.store.change(s=>{const task=s.projects[brain.projectId].tasks.RETRY;task.state='blocked';task.error='temporary';task.resumePhase='brain';});
 assert.equal((await call(root,brain,{action:'retry',taskId:'RETRY',reason:'precondition restored'})).state,'ready');
 assert.ok(service.store.state.events.some(event=>event.type==='task_resolved'&&event.taskId==='OLD'));
 assert.ok(service.store.state.events.some(event=>event.type==='task_revised'&&event.taskId==='FUTURE'));
});
