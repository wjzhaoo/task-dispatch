'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {configure} = require('../runtime/core/continuation.cjs');

function fixture(readers = {},role='reviewer') {
  const binding={sessionId:'session'}, identity={projectId:'p',role};
  const project={workspace:process.cwd(),bindings:{[role==='worker'?'worker':role]:binding}};
  const store={state:{projects:{p:project}},change:fn=>fn(store.state)};
  const desktop={store,assertBinding:()=>binding,nextStep:()=>({nextAction:project.completedAt?'stop':binding.wake?'park':'wait'})};
  const calls=[];
  const wake={desktop,forProvider:provider=>({read:async input=>{
    calls.push(provider);
    if(!readers[provider])throw Error('unavailable');
    return readers[provider](input);
  }}),bind:async (_,input)=>{binding.wake=input;}};
  return {wake,identity,binding,project,calls};
}
const info=()=>({thread:{id:'session',cwd:process.cwd()}});
test('unknown or unreachable host never silently falls back to wait',async()=>{
  const f=fixture();assert.equal((await configure(f.wake,f.identity)).nextAction,'attention');
  await assert.rejects(configure(f.wake,f.identity,{provider:'auto'}),/Provider auto is not allowed/);
  assert.equal(f.binding.wake,undefined);
});
test('explicit provider selects one supported host and binds before park',async()=>{
  const f=fixture({codearts:info},'worker');const result=await configure(f.wake,f.identity,{provider:'codearts'});
  assert.equal(result.provider,'codearts');assert.equal(result.nextAction,'park');
  assert.equal(f.binding.wake.threadId,'session');
});
// [AI-added] 2026-09-24 13:27: Connect reuses the verified host result, while direct binding still verifies.
test('connect verifies host once and direct wake-bind verifies independently',async()=>{
  const {Wake}=require('../runtime/core/wake.cjs');
  const binding={sessionId:'session'},project={id:'p',workspace:process.cwd(),bindings:{reviewer:binding}};
  const store={state:{projects:{p:project}},change:fn=>fn(store.state)};
  const desktop={store,assertBinding:()=>binding,nextStep:()=>({nextAction:binding.wake?'park':'wait'})};
  let verified=0,fullReads=0;
  const adapter={verify:async()=>{verified++;return info();},read:async()=>{fullReads++;return info();}};
  const wake=new Wake(desktop,{forProvider:()=>adapter}),identity={projectId:'p',role:'reviewer'};
  assert.equal((await configure(wake,identity,{provider:'qoder'})).nextAction,'park');
  assert.equal(verified,1);assert.equal(fullReads,0);
  delete binding.wake;
  await wake.bind(identity,{provider:'qoder',threadId:'session',experimentalAcknowledged:true});
  assert.equal(fullReads,1);
});
test('wrong directory does not bind and no other provider is probed',async()=>{
  const f=fixture({codearts:()=>({thread:{id:'session',cwd:require('node:path').dirname(process.cwd())}}),mimo:info},'worker');
  assert.equal((await configure(f.wake,f.identity,{provider:'codearts'})).nextAction,'attention');assert.equal(f.binding.wake,undefined);
  assert.deepEqual(f.calls,['codearts']);
});
test('Codex requires a real turn ID; explicit supported failure remains attention',async()=>{
  const f=fixture({codex:info});assert.equal((await configure(f.wake,f.identity,{provider:'codex'})).nextAction,'attention');
  assert.equal((await configure(f.wake,f.identity,{provider:'codex',turnId:'turn'})).nextAction,'park');
  const other=fixture();assert.equal((await configure(other.wake,other.identity,{provider:'mimo'})).nextAction,'attention');
});
test('MiMo uses the model returned by its adapter and never invents one',async()=>{
  const f=fixture({mimo:()=>({...info(),model:'provider/current'})});
  assert.equal((await configure(f.wake,f.identity,{provider:'mimo'})).nextAction,'park');assert.equal(f.binding.wake.model,'provider/current');
  const missing=fixture({mimo:info});assert.equal((await configure(missing.wake,missing.identity,{provider:'mimo'})).nextAction,'attention');
});
test('Qoder and QoderCN aliases use the shared explicit wake provider',async()=>{
  for(const provider of ['qoder','qodercn','qoder-cn']){
    const f=fixture({qoder:info});
    assert.equal((await configure(f.wake,f.identity,{provider})).nextAction,'park');
    assert.equal(f.binding.wake.provider,'qoder');
  }
  const waiting=fixture({qoder:info});
  await assert.rejects(configure(waiting.wake,waiting.identity,{provider:'qodercn',noWake:true}),/wait-only/);
  assert.equal(waiting.binding.wake,undefined);
});
test('explicit unsupported host persists wait; existing wake and completion take precedence',async()=>{
  const f=fixture({},'worker');assert.equal((await configure(f.wake,f.identity,{provider:'other-host'})).nextAction,'wait');
  assert.equal((await configure(f.wake,f.identity)).nextAction,'wait');assert.equal(f.calls.length,0);
  f.binding.wake={provider:'codearts'};assert.equal((await configure(f.wake,f.identity,{provider:'other-host'})).nextAction,'park');
  f.project.completedAt='now';assert.equal((await configure(f.wake,f.identity)).nextAction,'stop');
});
test('brain and reviewer reject worker-only providers before continuation is stored',async()=>{
  for(const role of ['brain','reviewer']){
    const f=fixture({},role);
    await assert.rejects(configure(f.wake,f.identity,{provider:'codearts'}),/only supports codex, mimo or qoder/);
    await assert.rejects(configure(f.wake,f.identity,{provider:'zcode'}),/only supports codex, mimo or qoder/);
    assert.equal(f.binding.continuation,undefined);
  }
});

test('real CLI connect negotiates wait and resume routes wait/park without starting work',async()=>{
  const fs=require('node:fs'),path=require('node:path');
  const {initialize,request}=require('../runtime/wizard.cjs');
  const {serve}=require('../runtime/server.cjs');
  const {call}=require('../runtime/desktop-client.cjs');
  const execFile=require('node:util').promisify(require('node:child_process').execFile);
  const base=path.resolve('tmp');fs.mkdirSync(base,{recursive:true});
  const dir=fs.mkdtempSync(path.join(base,'continuation-')),root=path.join(dir,'data'),workspace=path.join(dir,'work');fs.mkdirSync(workspace);initialize(root);
  const server=await serve(root,{wakeAdapter:{read:async binding=>({thread:{id:binding.threadId,cwd:workspace}}),send:async()=>{throw Error('unexpected wake');}}});
  const cli=path.resolve('runtime/desktop-client.cjs');
  const run=async args=>JSON.parse((await execFile(process.execPath,[cli,...args,'--data',root],{env:{...process.env,CODEX_THREAD_ID:''}})).stdout);
  try {
    const connected=await run(['connect','--role','worker','--workspace',workspace,'--session-id','session','--provider','other-host']);
    assert.equal(connected.continuation.mode,'wait');assert.equal(connected.nextAction,'wait');
    const credential=JSON.parse(fs.readFileSync(connected.credential,'utf8'));
    assert.equal((await run(['resume','--credential',connected.credential,'--seconds','1'])).idle,true);
    const state=await request(root);assert.equal(Object.keys(state.projects[connected.projectId].tasks).length,0);
    await call(root,credential,{action:'wake-bind',provider:'codex',threadId:'session',turnId:'turn',experimentalAcknowledged:true});
    assert.equal((await run(['resume','--credential',connected.credential])).parked,true);
    fs.writeFileSync(connected.credential+'.wait.lock','test');
    await assert.rejects(run(['resume','--credential',connected.credential]),/wait/);
    fs.unlinkSync(connected.credential+'.wait.lock');
    // Complete a real task through both roles, then exercise the public resume
    // completion contract instead of relying on a mocked nextStep.
    const brain=await run(['connect','--role','brain','--workspace',workspace,'--session-id','brain','--provider','codex','--turn-id','brain-turn']);
    // [AI-added] 2026-09-16 18:11
    assert.equal(brain.parked,true);assert.equal(brain.nextAction,'setup-peers');assert.equal(brain.continuationNextAction,'standby');
    const bc=JSON.parse(fs.readFileSync(brain.credential,'utf8')); 
    await require('./stage-fixture.cjs').startHttp(root,bc);
    await call(root,bc,{action:'plan',task:{id:'T',title:'T',instructions:'write result',acceptance:'result exists',allowedPaths:['result.txt']}});
  await require('./stage-fixture.cjs').beginHttp(root,bc,['T']);
    const job=(await call(root,credential,{action:'claim'})).job;
    fs.writeFileSync(path.join(workspace,'result.txt'),'done');
    await call(root,credential,{action:'submit',taskId:job.taskId,attemptId:job.attemptId,result:{projectId:job.projectId,taskId:job.taskId,attemptId:job.attemptId,role:'worker',status:'submitted',summary:'done',checks:[],unverified:[]}});
    await require('./stage-fixture.cjs').approveHttp(root,bc);
    await request(root,{action:'finish-project',projectId:connected.projectId});
    const stopped=await run(['resume','--credential',connected.credential]);
    assert.equal(stopped.completed,true);assert.equal(stopped.nextAction,'stop');
    const final=await call(root,bc,{action:'status'});assert.equal(final.planning,null);
  } finally {await server.close();}
});

test('wait-only worker connects with a logical invitation identity and no host session',async()=>{
  const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
  const {initialize}=require('../runtime/wizard.cjs');
  const {serve}=require('../runtime/server.cjs');
  const execFile=require('node:util').promisify(require('node:child_process').execFile);
  const base=path.resolve('tmp');fs.mkdirSync(base,{recursive:true});
  const dir=fs.mkdtempSync(path.join(base,'logical-wait-')),root=path.join(dir,'data'),workspace=path.join(dir,'work');fs.mkdirSync(workspace);initialize(root);
  const server=await serve(root);const cli=path.resolve('runtime/desktop-client.cjs');
  try {
    const output=await execFile(process.execPath,[cli,'connect','--role','worker','--workspace',workspace,'--worker-id','waiter','--provider','zcode','--invitation-id',crypto.randomUUID(),'--data',root],{env:{...process.env,CODEX_THREAD_ID:''}});
    const connected=JSON.parse(output.stdout),credential=JSON.parse(fs.readFileSync(connected.credential,'utf8'));
    assert.equal(connected.nextAction,'wait');assert.equal(connected.provider,'zcode');
    assert.equal(credential.sessionId,undefined);
  } finally {await server.close();}
});

test('Codex resolves its exact host turn and preserves platform on setup failure',async()=>{
  const f=fixture({codex:info},'brain');
  const original=f.wake.forProvider;
  f.wake.forProvider=p=>({...original(p),resolveTurn:async(id,cwd)=>{assert.equal(id,'session');assert.equal(cwd,process.cwd());return 'host-turn';}});
  assert.equal((await configure(f.wake,f.identity,{provider:'codex'})).nextAction,'park');
  assert.equal(f.binding.wake.turnId,'host-turn');assert.equal(f.binding.provider,'codex');
  const failed=fixture({},'brain');
  assert.equal((await configure(failed.wake,failed.identity,{provider:'codex'})).nextAction,'attention');
  assert.equal(failed.binding.provider,'codex');assert.match(failed.binding.continuationError,/turnId/);
});
