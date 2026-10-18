'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const { initialize, request } = require('../runtime/wizard.cjs');
const { serve } = require('./service-fixture.cjs');
const { Store, atomic } = require('../runtime/core/storage.cjs');
const { call } = require('../runtime/desktop-client.cjs');
const cli = path.resolve('runtime/desktop-client.cjs');

function directory(t) {
  fs.mkdirSync(path.resolve('tmp'),{recursive:true});
  const dir=fs.mkdtempSync(path.resolve('tmp/connect-regression-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50}));
  const workspace=path.join(dir,'中文 project'),root=path.join(dir,'service');fs.mkdirSync(workspace);initialize(root);
  return {dir,workspace,root};
}
function input(workspace,extra={}) { return {action:'connect',workspace,role:'worker',workerId:'default',provider:'codex',sessionId:crypto.randomUUID(),turnId:'real-fixture-turn',clientId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex'),...extra}; }
async function fixture(t, adapter) {
  const x=directory(t),service=await serve(x.root,{wakeAdapter:{forProvider:provider=>adapter(provider,x)}});
  t.after(()=>service.close());return {...x,service};
}

for(const provider of ['codex','mimo','qoder','opencode','codearts','dsh']) test(provider+' connect verifies once, uses two requests, commits once and reuses the binding without writes',async t=>{
  let verifies=0;
  const x=await fixture(t,(actual,{workspace})=>({verify:async b=>{assert.equal(actual,provider);verifies++;return {thread:{id:b.threadId,cwd:workspace,status:{type:'active'}},model:'fixture/model'};},read:()=>assert.fail('Connection must use the lean verifier')}));
  const trace=path.join(x.dir,'trace.jsonl'),preload=path.join(x.dir,'trace.cjs');
  fs.writeFileSync(preload,`const fs=require('node:fs');const log=process.env.CONNECT_TRACE;const fetchOriginal=global.fetch;global.fetch=(url,options)=>{fs.appendFileSync(log,JSON.stringify({url:String(url),action:options?.body?JSON.parse(options.body).action:null})+'\\n');return fetchOriginal(url,options);};const rename=fs.renameSync;fs.renameSync=function(a,b){fs.appendFileSync(log,JSON.stringify({write:b})+'\\n');return rename.call(this,a,b);};`);
  const session=provider==='opencode'?'ses_fixture':provider+'-session';
  const args=[cli,'connect','--provider',provider,'--role','worker','--session-id',session,'--turn-id','real-fixture-turn','--data',x.root];
  const env={...process.env,CONNECT_TRACE:trace,NODE_OPTIONS:(process.env.NODE_OPTIONS||'')+' --require "'+preload.replace(/\\/g,'/')+'"'};
  const run=async extra=>JSON.parse((await execFile(process.execPath,extra||args,{cwd:x.workspace,env,windowsHide:true})).stdout);
  const first=await run();assert.equal(first.parked,true);assert.equal(first.nextAction,'standby');assert.equal(verifies,1);assert.equal(x.service.store.state.revision,1);
  const events=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e=>e.url).length,2);assert.ok(events.find(e=>e.url?.includes('/ready?')));assert.equal(events.filter(e=>e.action==='connect').length,1);
  assert.equal(events.filter(e=>e.write===first.credential).length,1);assert.equal(events.filter(e=>e.write?.includes(path.sep+'connections'+path.sep)).length,1);
  const state=fs.readFileSync(path.join(x.root,'state.json')),credential=fs.readFileSync(first.credential),mtime=fs.statSync(first.credential).mtimeMs;
  fs.writeFileSync(trace,'');
  const second=await run([cli,'connect','--session-id',session,'--credential',first.credential]);
  assert.equal(second.credential,first.credential);assert.equal(second.parked,true);assert.equal(verifies,1);
  assert.deepEqual(fs.readFileSync(path.join(x.root,'state.json')),state);assert.deepEqual(fs.readFileSync(first.credential),credential);assert.equal(fs.statSync(first.credential).mtimeMs,mtime);
  const again=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);assert.equal(again.filter(e=>e.url).length,2);assert.equal(again.filter(e=>e.write).length,0);
  fs.writeFileSync(trace,'');
  assert.equal((await run([cli,'resume','--credential',first.credential])).parked,true);
  const resumed=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);assert.equal(resumed.filter(e=>e.url).length,1);assert.equal(resumed[0].action,'resume');
  assert.equal(verifies,1);assert.deepEqual(fs.readFileSync(path.join(x.root,'state.json')),state);
  await assert.rejects(run([cli,'connect','--provider',provider==='mimo'?'codex':'mimo','--role','worker','--session-id',session,'--credential',first.credential]),/Connected platform differs/);
  assert.deepEqual(fs.readFileSync(first.credential),credential);assert.deepEqual(fs.readFileSync(path.join(x.root,'state.json')),state);assert.equal(verifies,1);
  const descriptor=fs.readFileSync(path.join(x.root,'connections',JSON.parse(credential).clientId+'.json'),'utf8');assert.ok(!descriptor.includes(JSON.parse(credential).token));
});

test('failed verification reports the concrete host cause and publishes no partial binding',async t=>{
  let calls=0;
  const x=await fixture(t,()=>({verify:async()=>{calls++;const cause=Object.assign(Error('bridge refused connection'),{code:'ECONNREFUSED'});throw Error('fetch failed',{cause});}}));
  const before=fs.readFileSync(path.join(x.root,'state.json'));
  await assert.rejects(request(x.root,input(x.workspace)),/codex: fetch failed; bridge refused connection; ECONNREFUSED/);
  assert.equal(calls,1);assert.deepEqual(fs.readFileSync(path.join(x.root,'state.json')),before);assert.deepEqual(x.service.store.state.projects,{});
  await assert.rejects(execFile(process.execPath,[cli,'connect','--provider','codex','--session-id','fixture-session','--turn-id','fixture-turn','--data',x.root],{cwd:x.workspace,windowsHide:true}),/bridge refused connection; ECONNREFUSED/);
  assert.equal(calls,2);assert.deepEqual(fs.readFileSync(path.join(x.root,'state.json')),before);
});

test('a foreign session or workspace cannot create a project and never probes another platform',async t=>{
  let actual;
  const x=await fixture(t,provider=>({verify:async b=>{actual=provider;return {thread:{id:b.threadId,cwd:x.dir}};}}));
  await assert.rejects(request(x.root,input(x.workspace,{provider:'qoder'})),/Session workspace mismatch/);
  assert.equal(actual,'qoder');assert.equal(x.service.store.state.revision,0);
  const wake=x.service.monitor.wake;wake.adapter={forProvider:()=>({verify:async()=>({thread:{id:'different-session',cwd:x.workspace}})})};
  await assert.rejects(request(x.root,input(x.workspace)),/Session identity mismatch/);assert.equal(x.service.store.state.revision,0);
});

test('host verification is bounded and a timeout leaves state unchanged',async t=>{
  const x=await fixture(t,()=>({verify:()=>new Promise(()=>{})}));x.service.monitor.wake.readTimeoutMs=30;
  await assert.rejects(request(x.root,input(x.workspace)),/Host verify.*timed out/i);assert.equal(x.service.store.state.revision,0);
});

test('binding changes during asynchronous verification cannot be overwritten',async t=>{
  let release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const x=await fixture(t,()=>({verify:b=>{started();return new Promise(resolve=>{release=()=>resolve({thread:{id:b.threadId,cwd:x.workspace}});});}}));
  const pending=request(x.root,input(x.workspace));await entered;
  const old=x.service.admin.desktop.attach({workspace:x.workspace,role:'worker',clientId:'owner-client',token:'b'.repeat(64),sessionId:'owner-session'});
  release();await assert.rejects(pending,/changed during host verification/);
  assert.equal(x.service.store.state.projects[old.projectId].bindings.worker.clientId,'owner-client');
});

test('connection commits are atomic when validation or durable storage fails',async t=>{
  const x=await fixture(t,()=>({verify:async b=>({thread:{id:b.threadId,cwd:x.workspace}})}));
  const file=path.join(x.root,'state.json'),before=fs.readFileSync(file);
  await assert.rejects(request(x.root,input(x.workspace,{provider:'mimo',model:'invalid-model'})),/provider\/model/);
  assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(x.service.store.state.projects,{});
  const rename=fs.renameSync;
  fs.renameSync=function(a,b){if(b===file)throw Object.assign(Error('state write denied'),{code:'EACCES'});return rename.call(this,a,b);};
  try {await assert.rejects(request(x.root,input(x.workspace)),/state write denied/);}finally{fs.renameSync=rename;}
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(x.service.store.state.revision,0);
  await request(x.root,input(x.workspace));assert.equal(x.service.store.state.revision,1);
});

test('the same host session cannot be reused for another project, and a rejected connection rolls back its project',async t=>{
  let cwd;
  const x=await fixture(t,()=>({verify:async b=>({thread:{id:b.threadId,cwd}})}));cwd=x.workspace;
  const first=await request(x.root,input(cwd,{sessionId:'shared-session'}));
  cwd=path.join(x.dir,'other');fs.mkdirSync(cwd);
  await assert.rejects(request(x.root,input(cwd,{sessionId:'shared-session'})),/already bound to another project/);
  assert.deepEqual(Object.keys(x.service.store.state.projects),[first.projectId]);assert.equal(x.service.store.state.revision,1);
});

test('parallel cold connects share initialization and a single service without model calls',async t=>{
  const x=directory(t);fs.unlinkSync(path.join(x.root,'config.json'));
  let servicePid;
  const run=id=>execFile(process.execPath,[cli,'connect','--provider','zcode','--role','worker','--worker-id',id,'--workspace',x.workspace,'--data',x.root],{cwd:x.workspace,windowsHide:true});
  try {
    const values=await Promise.all(['one','two','three'].map(async id=>JSON.parse((await run(id)).stdout)));
    assert.equal(new Set(values.map(v=>v.projectId)).size,1);assert.ok(values.every(v=>v.nextAction==='wait'));
    servicePid=JSON.parse(fs.readFileSync(path.join(x.root,'endpoint.json'))).pid;
    const state=await request(x.root);assert.equal(Object.keys(state.projects[values[0].projectId].bindings).length,3);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.root,'config.json'))),{version:1,maxConcurrent:2});assert.equal(fs.existsSync(path.join(x.root,'startup.lock')),false);
  } finally {
    if(fs.existsSync(path.join(x.root,'endpoint.json')))await request(x.root,{action:'stop'});
    for(let i=0;i<100&&fs.existsSync(path.join(x.root,'service.lock'));i++)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(fs.existsSync(path.join(x.root,'service.lock')),false);
    if(servicePid) {for(let i=0;i<100&&require('../runtime/core/storage.cjs').alive(servicePid);i++)await new Promise(resolve=>setTimeout(resolve,50));assert.equal(require('../runtime/core/storage.cjs').alive(servicePid),false);}
  }
});

test('retired client commands and service actions are rejected without mutating current data',async t=>{
  const x=await fixture(t,()=>assert.fail('Retired APIs must not reach a host'));
  for(const command of ['attach','wake-bind','wake-disable','configure-repair','reconcile-review','handover-wait'])await assert.rejects(execFile(process.execPath,[cli,command,'--data',x.root],{windowsHide:true}),/is removed/);
  for(const action of ['attach-desktop','prepare-review','configure-repair','reconcile-review'])await assert.rejects(request(x.root,{action}),/Unknown operator action/);
  assert.equal(x.service.store.state.revision,0);
  const old=path.join(x.dir,'old'),state=structuredClone(x.service.store.state);state.projects.p={id:'p',workspace:x.workspace,mode:'desktop',tasks:{},projectBudgetEnabled:false,turns:0,maxTurns:null,bindings:{brain:{wake:{threadId:'old',turnId:'old'}}}};
  atomic(path.join(old,'state.json'),state);const bytes=fs.readFileSync(path.join(old,'state.json'));assert.throws(()=>new Store(old),/explicit supported provider/);assert.deepEqual(fs.readFileSync(path.join(old,'state.json')),bytes);
  const connected=await request(x.root,input(x.workspace,{provider:'zcode'})),before=fs.readFileSync(path.join(x.root,'state.json'));
  for(const action of ['wake-bind','configure-continuation','configure-repair','reconcile-review'])await assert.rejects(call(x.root,connected.registration,{action}),/Unknown desktop action/);
  assert.deepEqual(fs.readFileSync(path.join(x.root,'state.json')),before);
});

test('invitation and Skill instructions reuse an explicitly selected platform',()=>{
  const {buildInvitation}=require('../runtime/core/invitations.cjs');
  const text=buildInvitation({role:'worker',workerId:'default',capability:'general',workspace:process.cwd(),dataRoot:path.resolve('tmp/service'),clientPath:cli,referencePath:path.resolve('skills/task-dispatch/references/connection.md')}).text;
  assert.match(text,/不重复询问/);assert.match(text,/仅缺少平台信息时/);assert.doesNotMatch(text,/必须询问|首次配置还要/);
  const skill=fs.readFileSync('skills/task-dispatch/SKILL.md','utf8');assert.doesNotMatch(skill,/必须先询问用户当前会话平台|attach\/wait|wake-bind\/park/);
});

test('parallel connects from the same session share credentials and verify only once',async t=>{
  let verifies=0;
  const x=await fixture(t,()=>({verify:async b=>{verifies++;await new Promise(resolve=>setTimeout(resolve,50));return {thread:{id:b.threadId,cwd:x.workspace}};}}));
  const run=()=>execFile(process.execPath,[cli,'connect','--provider','codex','--role','worker','--session-id','same-session','--turn-id','same-turn','--data',x.root],{cwd:x.workspace,windowsHide:true});
  const values=await Promise.all([run(),run()].map(async result=>JSON.parse((await result).stdout)));
  assert.equal(values[0].credential,values[1].credential);assert.equal(verifies,1);assert.equal(x.service.store.state.revision,1);
  assert.ok(fs.readdirSync(path.join(x.root,'clients')).every(name=>!name.endsWith('.lock')));
});

test('wait exclusion rejects connection before verification or registration',async t=>{
  const x=await fixture(t,()=>assert.fail('An existing wait must prevent host access'));
  await assert.rejects(request(x.root,input(x.workspace,{waitLocked:true})),/已有 wait 进程/);assert.equal(x.service.store.state.revision,0);
});

test('readiness reports protocol and authorization errors immediately without starting a replacement',async t=>{
  const http=require('node:http'),{start}=require('../runtime/wizard.cjs');
  for(const [status,body,expected] of [[404,{error:'Not found'},/GET \/ready 返回 404/],[401,{error:'fixture unauthorized'},/fixture unauthorized/],[200,{ready:true,connectionProtocol:1},/接口版本不匹配/],[200,{ready:true,connectionProtocol:99},/接口版本不匹配/]]){
    const x=directory(t),server=http.createServer((req,res)=>{assert.ok(req.url.startsWith('/ready'));res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    atomic(path.join(x.root,'endpoint.json'),{pid:process.pid,port:server.address().port});fs.writeFileSync(path.join(x.root,'admin-token'),'a'.repeat(64));
    try {await assert.rejects(start(x.root),expected);assert.equal(fs.existsSync(path.join(x.root,'startup.lock')),false);assert.equal(fs.existsSync(path.join(x.root,'service.log')),false);}
    finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
});

test('retired imported-review data is rejected without rewriting the current data version',t=>{
  const x=directory(t),state={version:2,revision:0,events:[],projects:{p:{id:'p',mode:'desktop',workspace:x.workspace,projectBudgetEnabled:false,maxTurns:null,turns:0,tasks:{T:{id:'T',attempts:[],...require('../runtime/core/attempts.cjs').taskFields(),reviewOnly:true}}}}};
  atomic(path.join(x.root,'state.json'),state);const before=fs.readFileSync(path.join(x.root,'state.json'));
  assert.throws(()=>new Store(x.root),/Unsupported imported review task/);assert.deepEqual(fs.readFileSync(path.join(x.root,'state.json')),before);assert.equal(fs.existsSync(path.join(x.root,'service.lock')),false);
});

test('reconnecting a detached member preserves revoked credentials and reuses the new descriptor',async t=>{
  const x=await fixture(t,()=>assert.fail('A wait-only member must not access a host'));
  const run=async()=>JSON.parse((await execFile(process.execPath,[cli,'connect','--provider','zcode','--role','worker','--data',x.root],{cwd:x.workspace,windowsHide:true})).stdout);
  const first=await run(),bytes=fs.readFileSync(first.credential),old=JSON.parse(bytes);
  await call(x.root,old,{action:'detach'});
  const second=await run();assert.notEqual(second.credential,first.credential);assert.deepEqual(fs.readFileSync(first.credential),bytes);
  await assert.rejects(call(x.root,old,{action:'status'}),/Invalid desktop token/);
  assert.equal((await run()).credential,second.credential);
});
