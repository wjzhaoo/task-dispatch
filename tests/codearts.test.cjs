// [AI-added] 2026-09-14 09:43
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CodeArtsWake } = require('../runtime/adapters/codearts-wake.cjs');
const { WakeProviders } = require('../runtime/adapters/mimo-wake.cjs');
const { install } = require('../scripts/install.js');
function fixture(t) {
  const root = path.resolve(__dirname, '../tmp'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'codearts-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true,maxRetries:10,retryDelay:50}));
  const file = path.join(dir, 'discovery.json');
  const config = { version: 1, sessionId: 'ses_test', directory: dir, url: 'http://127.0.0.1:1234', username: 'opencode', password: 'test-only' };
  const save = () => fs.writeFileSync(file, JSON.stringify(config)); save();
  return { dir, file, config, save };
}
test('CodeArts verifies identity with one GET and rejects foreign workspace before exposing credentials', async t => {
  const x=fixture(t), calls=[];
  const a=new CodeArtsWake({credentialFile:x.file,fetchImpl:async(url,options)=>{
    calls.push({url,options});return Response.json({id:'ses_test',directory:x.dir});
  }});
  const info=await a.verify({threadId:'ses_test',workspace:x.dir});
  assert.equal(info.thread.reachable,true);assert.equal(info.thread.status.type,'unknown');
  assert.equal(calls.length,1);assert.equal(new URL(calls[0].url).pathname,'/session/ses_test');
  await assert.rejects(a.verify({threadId:'ses_test',workspace:path.dirname(x.dir)}),/Invalid CodeArts discovery/);
  assert.equal(calls.length,1);
});

test('CodeArts worker connects through its bridge, persists across reload and resumes without re-verifying',async t=>{
  const x=fixture(t),{initialize,request}=require('../runtime/wizard.cjs');
  const {serve}=require('./service-fixture.cjs'),{call}=require('../runtime/desktop-client.cjs');
  const {Store}=require('../runtime/core/storage.cjs');
  const workspace=path.join(x.dir,'work');fs.mkdirSync(workspace);x.config.directory=workspace;x.save();
  const root=path.join(x.dir,'service');initialize(root);
  let gets=0;
  const providers=new WakeProviders({codearts:{credentialFile:x.file,fetchImpl:async(url)=>{
    assert.equal(new URL(url).pathname,'/session/ses_test');gets++;
    return Response.json({id:'ses_test',directory:workspace});
  }}});
  const service=await serve(root,{wakeAdapter:providers});t.after(()=>service.close());
  const connected=await request(root,{action:'connect',role:'worker',workspace,provider:'codeartsdoer',sessionId:'ses_test',clientId:'codearts-client',token:'a'.repeat(64)});
  assert.equal(connected.parked,true);assert.equal(connected.provider,'codearts');assert.equal(gets,1);
  const b=service.store.state.projects[connected.projectId].bindings.worker;
  assert.equal(b.wake.provider,'codearts');assert.equal(b.wake.workspace,workspace);assert.equal(b.wake.turnId,undefined);
  assert.equal((await call(root,connected.registration,{action:'resume'})).parked,true);assert.equal(gets,1);
  await service.close();
  const restored=new Store(root);
  try {assert.deepEqual(restored.state.projects[connected.projectId].bindings.worker.wake,b.wake);}
  finally {restored.close();}
});

test('CodeArts stops before POST if the pending binding changes during the read',async t=>{
  const x=fixture(t);let posts=0;
  const a=new CodeArtsWake({credentialFile:x.file,fetchImpl:async(url,options)=>{
    if(options.method==='POST'){posts++;return new Response(null,{status:204});}
    const route=new URL(url).pathname;
    if(route.endsWith('/status'))return Response.json({});
    if(route.endsWith('/message'))return Response.json([]);
    return Response.json({id:'ses_test',directory:x.dir});
  }});
  await assert.rejects(a.send({threadId:'ses_test',workspace:x.dir,canSend:()=>false},'wake'),e=>e.safeToRetry===true);
  assert.equal(posts,0);
});
test('CodeArts routes history/status/model and reloads discovery credentials', async t => {
  const x = fixture(t), calls = []; let busy = false, response = 204;
  const a = new CodeArtsWake({ credentialFile: x.file, fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    const route = new URL(url).pathname;
    if (route.endsWith('/prompt_async')) return new Response(null, { status: response });
    if (route.endsWith('/status')) return Response.json(busy ? { ses_test: { type: 'busy' } } : {});
    if (route.endsWith('/message')) return Response.json([{ info: { role: 'user' }, parts: [{ type: 'text', text: 'TASK-DISPATCH-WAKE:test' }] }]);
    return Response.json({ id: 'ses_test', directory: x.dir });
  } });
  const binding = { threadId: 'ses_test', model: 'provider/model' };
  const info = await a.read(binding);
  assert.equal(info.thread.status.type, 'idle'); assert.match(info.turns[0].items[0].content[0].text, /TASK-DISPATCH/);
  x.config.url = 'http://127.0.0.1:4321'; x.config.password = 'rotated'; x.save();
  assert.deepEqual(await a.send(binding, '中文通知'), { delivered: true });
  const last = calls.at(-1);
  assert.equal(last.url.port, '4321'); assert.equal(last.url.searchParams.get('directory'), x.dir);
  assert.equal(last.options.redirect, 'error');
  assert.equal(last.options.headers.Authorization, 'Basic ' + Buffer.from('opencode:rotated').toString('base64'));
  assert.deepEqual(JSON.parse(last.options.body), { parts: [{ type: 'text', text: '中文通知' }], model: { providerID: 'provider', modelID: 'model' } });
  busy = true; const before = calls.filter(c => c.options.method === 'POST').length;
  await assert.rejects(a.send(binding, 'busy'), e => e.safeToRetry === true);
  assert.equal(calls.filter(c => c.options.method === 'POST').length, before);
  busy = false; response = 200;
  await assert.rejects(a.send(binding, 'ambiguous'), e => !e.safeToRetry && /unconfirmed/.test(e.message));
});
test('CodeArts rejects remote discovery and mismatched session before sending credentials', async t => {
  const x = fixture(t); let calls = 0;
  const a = new CodeArtsWake({ credentialFile: x.file, fetchImpl: async t => { calls++; throw Error('unexpected'); } });
  x.config.url = 'http://example.com'; x.save();
  await assert.rejects(a.read({ threadId: 'ses_test' }), /Invalid/);
  x.config.url = 'http://127.0.0.1:1234'; x.save();
  await assert.rejects(a.read({ threadId: 'other' }), /Invalid/); assert.equal(calls, 0);
});
// [AI-added] 2026-09-14 20:10
test('CodeArts adapter routes V2 bridge requests with bearer token', async t => {
  // [AI-added] 2026-09-14 20:10
  const x=fixture(t),calls=[];Object.assign(x.config,{version:2,url:'http://127.0.0.1:6789',token:'a'.repeat(64)});delete x.config.username;delete x.config.password;x.save();
  const a=new CodeArtsWake({credentialFile:x.file,fetchImpl:async(url,options)=>{
    calls.push({url:new URL(url),options});const route=new URL(url).pathname;
    if(route==='/v1/status')return Response.json({});
    if(route.endsWith('/messages'))return Response.json([]);
    if(route.endsWith('/prompt'))return new Response(null,{status:204});
    return Response.json({id:'ses_test',directory:x.dir});
  }});
  await a.read({threadId:'ses_test'});await a.send({threadId:'ses_test'},'wake');
  assert.deepEqual(calls.map(c=>c.url.pathname),['/v1/session/ses_test','/v1/session/ses_test/messages','/v1/status','/v1/session/ses_test','/v1/session/ses_test/messages','/v1/status','/v1/session/ses_test/prompt']);
  assert.ok(calls.every(c=>c.options.headers.Authorization==='Bearer '+'a'.repeat(64)));
  assert.ok(calls.every(c=>c.url.search===''));
});

function restartedBridge(t, {failure, genericDirectory, explicit = false, includeGeneric = true} = {}) {
  const x = fixture(t), session = 'ses_test', workspace = path.join(x.dir, 'work');
  fs.mkdirSync(workspace);
  const pinned = path.join(x.dir, require('node:crypto').createHash('sha256').update(session).digest('hex') + '.json');
  const old = {version: 2, sessionId: session, directory: workspace, url: 'http://127.0.0.1:5007', token: 'a'.repeat(64)};
  const current = {version: 2, directory: genericDirectory || workspace, url: 'http://127.0.0.1:5008', token: 'b'.repeat(64)};
  fs.writeFileSync(pinned, JSON.stringify(old));
  if (includeGeneric) fs.writeFileSync(path.join(x.dir, 'bridge.json'), JSON.stringify(current));
  const calls = [];
  const adapter = new CodeArtsWake({discoveryDir: x.dir, ...(explicit ? {credentialFile: pinned} : {}), fetchImpl: async (url, options) => {
    calls.push({url, method: options.method || 'GET'});
    if (url.startsWith(old.url)) throw failure || new TypeError('fetch failed', {cause: Object.assign(Error('refused'), {code: 'ECONNREFUSED'})});
    assert.equal(options.headers.Authorization, 'Bearer ' + current.token);
    if (options.method === 'POST') return new Response(null, {status: 204});
    return Response.json(url.endsWith('/messages') ? [] : url.endsWith('/status') ? {} : {id: session, directory: workspace});
  }});
  return {...x, adapter, calls, binding: {provider: 'codearts', threadId: session, workspace}, old, current};
}

test('CodeArts restores the original session through a refreshed bridge after the old port closes', async t => {
  const f = restartedBridge(t);
  const info = await f.adapter.read(f.binding);
  assert.equal(info.thread.id, f.binding.threadId);
  assert.equal(info.thread.cwd, f.binding.workspace);
  assert.equal(info.thread.status.type, 'idle');
  assert.equal(f.calls.filter(call => call.url.startsWith(f.current.url)).length, 3);
  assert.deepEqual(await f.adapter.send(f.binding, '[TASK-DISPATCH-WAKE:restart] 领取任务'), {delivered: true});
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.url.startsWith(f.current.url)).length, 1);
});

test('CodeArts preserves explicit discovery and never retries ambiguous prompt delivery', async t => {
  for (const code of ['ECONNRESET', 'ETIMEDOUT']) {
    const failure = new TypeError('fetch failed', {cause: Object.assign(Error(code), {code})});
    const f = restartedBridge(t, {failure});
    await assert.rejects(f.adapter.request(f.binding, '/session/ses_test/prompt_async', {method: 'POST', body: '{}'}), error => error === failure);
    assert.equal(f.calls.length, 1);
  }
  const pinned = restartedBridge(t, {explicit: true});
  await assert.rejects(pinned.adapter.read(pinned.binding), /fetch failed/);
  assert.equal(pinned.calls.length, 1);
});

test('CodeArts rejects replacement bridges outside the verified workspace even without a workspace argument', async t => {
  for (const hasWorkspace of [true, false]) {
    const f = restartedBridge(t, {genericDirectory: path.resolve(__dirname, '../tmp/foreign-codearts')});
    const binding = {...f.binding}; if (!hasWorkspace) delete binding.workspace;
    await assert.rejects(f.adapter.read(binding), /Invalid CodeArts discovery/);
    assert.equal(f.calls.length, 1);
  }
});

test('CodeArts cannot retry a replacement bridge after the pending binding changes', async t => {
  const f = restartedBridge(t); let allowed = true;
  const fetchImpl = f.adapter.fetch;
  f.adapter.fetch = async (url, options) => {
    if (url.startsWith(f.old.url)) allowed = false;
    return fetchImpl(url, options);
  };
  await assert.rejects(f.adapter.request({...f.binding, canSend: () => allowed}, '/session/ses_test/prompt_async', {method: 'POST', body: '{}'}), error => error.safeToRetry === true);
  assert.equal(f.calls.length, 1);
});

test('CodeArts keeps a closed endpoint pending until a refreshed bridge appears', async t => {
  const f = restartedBridge(t, {includeGeneric: false});
  await assert.rejects(f.adapter.read(f.binding), /discovery file not found/);
  fs.writeFileSync(path.join(f.dir, 'bridge.json'), JSON.stringify(f.current));
  assert.equal((await f.adapter.read(f.binding)).thread.id, f.binding.threadId);
});

test('CodeArts dispatcher recovers a pending task after IDE restart and reconciles its original marker', async t => {
  const f = restartedBridge(t), {Store} = require('../runtime/core/storage.cjs');
  const {Dispatcher} = require('../runtime/core/dispatcher.cjs'), {Desktop} = require('../runtime/core/desktop.cjs'), {Wake} = require('../runtime/core/wake.cjs');
  const store = new Store(path.join(f.dir, 'data')); t.after(() => store.close());
  const d = new Dispatcher(store, {maxConcurrent: 2}), desktop = new Desktop(d);
  desktop.attach({workspace: f.binding.workspace, role: 'worker', clientId: 'codearts-worker', token: 'a'.repeat(64), sessionId: f.binding.threadId});
  store.change(s => {for (const p of Object.values(s.projects)) p.startup = {state: 'started'};});
  const identity = desktop.authenticate('a'.repeat(64));
  const providers = {forProvider: provider => {assert.equal(provider, 'codearts'); return f.adapter;}};
  const wake = new Wake(desktop, providers);
  await wake.bind(identity, f.binding); wake.park(identity);
  d.addTask(identity.projectId, {id: 'T', title: 'T', instructions: 'i', acceptance: 'a', allowedPaths: ['result.txt']});
  require('./stage-fixture.cjs').begin(d); d.tick();
  fs.unlinkSync(path.join(f.dir, 'bridge.json'));
  await wake.run();
  const attempt = () => store.state.projects[identity.projectId].tasks.T.attempts.at(-1);
  assert.notEqual(attempt().wakeNotice.status, 'sent');
  assert.match(attempt().wakeNotice.error, /discovery file not found/);
  fs.writeFileSync(path.join(f.dir, 'bridge.json'), JSON.stringify(f.current));
  await wake.run();
  assert.equal(attempt().wakeNotice.status, 'sent');
  const posts = () => f.calls.filter(call => call.method === 'POST' && call.url.startsWith(f.current.url)).length;
  assert.equal(posts(), 1);
  const marker = attempt().wakeNotice.marker, fetchImpl = f.adapter.fetch;
  f.adapter.fetch = (url, options) => url.startsWith(f.current.url) && url.endsWith('/messages')
    ? Promise.resolve(Response.json([{info: {role: 'user'}, parts: [{type: 'text', text: `[${marker}] 领取任务`}]}])) : fetchImpl(url, options);
  store.change(s => {s.projects[identity.projectId].tasks.T.attempts.at(-1).wakeNotice.status = 'sending';});
  const restarted = new Wake(desktop, providers); await restarted.run();
  assert.equal(attempt().wakeNotice.status, 'sent'); assert.equal(posts(), 1);
  assert.equal(desktop.claim(identity).taskId, 'T');
  assert.deepEqual(store.state.projects[identity.projectId].bindings.worker.wake, f.binding);
  await Promise.all([...d.active.values()].map(entry => entry.promise));
});
test('all connected wake providers are registered and CodeArts aliases share one adapter', () => {
  const providers = new WakeProviders();
  for (const id of ['codex', 'mimo', 'codearts']) assert.equal(typeof providers.forProvider(id).send, 'function');
  assert.equal(providers.forProvider('codearts'), providers.forProvider('codeartsdoer'));
  assert.throws(() => providers.forProvider('missing'), /not connected/);
});
test('CodeArts remains a runtime worker adapter but is not a brain-platform install target', t => {
  const x = fixture(t), home = path.join(x.dir, 'home');
  assert.throws(() => install({ platforms: ['codearts'], home, dryRun: true }), /valid platforms/);
  assert.throws(() => install({ platforms: ['codeartsdoer'], home, dryRun: true }), /valid platforms/);
  assert.equal(fs.existsSync(home), false);
});
test('CodeArts hook publishes V2 discovery and serves authenticated SDK bridge', async t => {
  const x = fixture(t);
  const { spawnSync } = require('node:child_process');
  const { pathToFileURL } = require('node:url');
  const hook = pathToFileURL(path.resolve(__dirname, '../skills/task-dispatch/codearts-hook.mjs')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const {TaskDispatch}=await import(${JSON.stringify(hook)});
    const fs=await import('node:fs');const path=await import('node:path');const crypto=await import('node:crypto');const calls=[];
    const session={
      list:async()=>({data:[{id:'ses_one',directory:process.cwd()},{id:'other',directory:'elsewhere'}]}),
      get:async o=>({data:{id:o.path.id,directory:process.cwd()}}),messages:async()=>({data:[]}),status:async()=>({data:{}}),
      promptAsync:async o=>{calls.push(o);return {data:null};}
    };
    const h=await TaskDispatch({directory:process.cwd(),client:{session}});
    await h.event({event:{type:'session.idle',properties:{sessionID:'ses_two'}}});
    const root=path.join(process.env.USERPROFILE,'.codeartsdoer','task-dispatch');
    // [AI-added] 2026-09-14 20:28
    const file=path.join(root,'bridge.json');const c=JSON.parse(fs.readFileSync(file));
    const headers={Authorization:'Bearer '+c.token};
    const got=await fetch(c.url+'/v1/session/ses_one',{headers}).then(r=>r.json());
    // [AI-added] 2026-09-14 20:18
    const sessions=await fetch(c.url+'/v1/sessions',{headers}).then(r=>r.json());
    const sent=await fetch(c.url+'/v1/session/ses_one/prompt',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'wake'}]})});
    await h.dispose();console.log(JSON.stringify({version:c.version,got,sessions,sent:sent.status,calls,files:fs.readdirSync(root).length}));
  `], { cwd: x.dir, encoding: 'utf8', env: { ...process.env, HOME: x.dir, USERPROFILE: x.dir, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: 'test-only' } });
  assert.equal(result.status, 0, result.stderr);
  const value=JSON.parse(result.stdout.trim());assert.equal(value.version,2);assert.equal(value.got.id,'ses_one');assert.equal(value.sessions.length,2);assert.equal(value.sent,204);assert.equal(value.files,2);
  assert.equal(value.calls[0].path.id,'ses_one');assert.equal(value.calls[0].body.parts[0].text,'wake');
});
