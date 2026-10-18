// [AI-added] 2026-09-17 14:23
'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {serve,reuse}=require('../runtime/catalog-console.cjs');
const registry=require('../runtime/core/service-registry.cjs');
const {atomic}=require('../runtime/core/storage.cjs');
const projectFields={mode:'desktop',maxTurns:null,projectBudgetEnabled:false,turns:0};
const taskFields=require('../runtime/core/attempts.cjs').taskFields;

async function login(catalog){
  const url=`http://127.0.0.1:${catalog.server.address().port}`,ticket=new URL(catalog.createTicket()).hash.slice(8);
  const response=await fetch(url+'/catalog/login',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({ticket})});
  assert.equal(response.status,200);const value=await response.json();return {url,csrf:value.csrf,cookie:response.headers.get('set-cookie').split(';')[0]};
}
test('empty catalog web home stays available and observes projects and tasks added later',async t=>{
  const temp=fs.mkdtempSync(path.resolve('tmp/catalog-console-')),file=path.join(temp,'registry.json'),home=path.join(temp,'home');t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const catalog=await serve({registryOptions:{file,home}});t.after(()=>catalog.close());const session=await login(catalog),headers={Cookie:session.cookie};
  assert.equal((await fetch(session.url+'/catalog/')).status,200);
  const boardAsset=await fetch(session.url+'/catalog/task-board.mjs');assert.equal(boardAsset.status,200);assert.match(boardAsset.headers.get('content-type'),/javascript/);assert.match(await boardAsset.text(),/export function buildBoard/);
  const commandAsset=await fetch(session.url+'/catalog/command-policy.mjs');assert.equal(commandAsset.status,200);assert.match(commandAsset.headers.get('content-type'),/javascript/);assert.match(await commandAsset.text(),/export function buildCommand/);
  let view=await (await fetch(session.url+'/catalog/api/projects',{headers})).json();assert.deepEqual(view.projects,[]);
  const workspace=path.join(temp,'project'),root=path.join(temp,'service');fs.mkdirSync(workspace);fs.mkdirSync(root);atomic(path.join(root,'config.json'),{version:1});
  atomic(path.join(root,'state.json'),{version:2,revision:0,projects:{p:{id:'p',workspace,...projectFields,tasks:{}}},events:[]});registry.register(root,[workspace],{file});
  view=await (await fetch(session.url+'/catalog/api/projects',{headers})).json();assert.equal(view.projects.length,1);assert.equal(view.projects[0].taskCount,0);
  atomic(path.join(root,'state.json'),{version:2,revision:1,projects:{p:{id:'p',workspace,...projectFields,tasks:{T:{id:'T',state:'ready',...taskFields(),attempts:[]}}}},events:[]});
  view=await (await fetch(session.url+'/catalog/api/projects',{headers})).json();assert.equal(view.projects[0].taskCount,1);assert.equal(view.projects[0].activeTaskCount,1);
  atomic(path.join(root,'state.json'),{version:2,revision:2,projects:{p:{id:'p',workspace,...projectFields,tasks:{T:{id:'T',state:'resolved',...taskFields(),attempts:[]},U:{id:'U',state:'accepted',...taskFields(),attempts:[]},V:{id:'V',state:'blocked',...taskFields(),attempts:[]}}}},events:[]});
  view=await (await fetch(session.url+'/catalog/api/projects',{headers})).json();assert.equal(view.projects[0].taskCount,3);assert.equal(view.projects[0].activeTaskCount,1);
});

// [AI-added] 2026-09-19 00:40
// [AI-added] 2026-09-21 10:20: The header version badge loads before login.
test('catalog console reports its service version without a session',async t=>{
  const temp=fs.mkdtempSync(path.resolve('tmp/catalog-version-')),file=path.join(temp,'registry.json'),home=path.join(temp,'home');t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const catalog=await serve({registryOptions:{file,home}});t.after(()=>catalog.close());
  const response=await fetch(`http://127.0.0.1:${catalog.port}/catalog/api/version`);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{runtimeVersion:require('../package.json').version});
});
// [AI-added] 2026-09-19 00:40
async function fixture(t, prefix) {
  const temp = fs.mkdtempSync(path.resolve('tmp/' + prefix)), file = path.join(temp, 'registry.json'), home = path.join(temp, 'home'), workspace = path.join(temp, 'project'), root = path.join(temp, 'service');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.mkdirSync(workspace); fs.mkdirSync(root);
  atomic(path.join(root, 'config.json'), { version: 1, maxConcurrent: 1 });
  const target = await require('./service-fixture.cjs').serve(root); t.after(() => target.close());
  target.dispatcher.addProject({ id: 'p', workspace, mode: 'desktop' });
  registry.register(root, [workspace], { file });
  const catalog = await serve({ registryOptions: { file, home } }); t.after(() => catalog.close());
  const session = await login(catalog), headers = { Cookie: session.cookie };
  const list = await (await fetch(session.url + '/catalog/api/projects', { headers })).json();
  return { target, catalog, session, headers, key: list.projects[0].key };
}
// [AI-added] 2026-09-19 00:40
test('catalog gateway guards, ensures, forwards overview/events/commands and streams snapshot', async t => {
  const { session, headers, key } = await fixture(t, 'catalog-gateway-');
  // Session and CSRF guards.
  assert.equal((await fetch(session.url + `/catalog/api/p/${key}/overview`)).status, 401);
  assert.equal((await fetch(session.url + `/catalog/api/p/${key}/ensure`, { method: 'POST', headers: { Cookie: session.cookie, 'Content-Type': 'application/json' } })).status, 403);
  // The retired cross-port route no longer exists.
  assert.equal((await fetch(session.url + '/catalog/api/open', { method: 'POST', headers: { Cookie: session.cookie, Origin: session.url, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) })).status, 404);
  // ensure brings/uses the project service and establishes the server-side session.
  const ensured = await fetch(session.url + `/catalog/api/p/${key}/ensure`, { method: 'POST', headers: { Cookie: session.cookie, Origin: session.url, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(ensured.status, 200); assert.equal((await ensured.json()).online, true);
  // overview forwards the aggregate snapshot.
  const overview = await (await fetch(session.url + `/catalog/api/p/${key}/overview`, { headers })).json();
  assert.ok(overview.projects.some(p => p.id === 'p'));
  // commands forward with the server-side CSRF session.
  const command = await fetch(session.url + `/catalog/api/p/${key}/commands`, { method: 'POST', headers: { Cookie: session.cookie, Origin: session.url, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ commandId: 'cmd-gateway-test-1', instanceId: overview.instanceId, revision: overview.revision, action: 'cleanup-preview' }) });
  assert.equal(command.status, 200); const commandResult = await command.json(); assert.equal(commandResult.ok, true); assert.ok(commandResult.previewId);
  // events forward with query string.
  const events = await (await fetch(session.url + `/catalog/api/p/${key}/events?limit=10`, { headers })).json();
  assert.ok(Array.isArray(events.events));
  // stream forwards SSE frames; the first frame must be a snapshot.
  const streamResponse = await fetch(session.url + `/catalog/api/p/${key}/stream?cursor=0&instanceId=${encodeURIComponent(overview.instanceId)}`, { headers });
  assert.equal(streamResponse.status, 200);
  const reader = streamResponse.body.getReader();
  let text = '';
  while (!text.includes('event: snapshot')) { const { done, value } = await reader.read(); if (done) break; text += Buffer.from(value).toString('utf8'); }
  await reader.cancel();
  assert.ok(text.includes('event: snapshot'));
});
// [AI-added] 2026-09-19 00:40
test('catalog gateway re-establishes the server-side session after the project service restarts', async t => {
  const { target, session, headers, key } = await fixture(t, 'catalog-gateway-restart-');
  await fetch(session.url + `/catalog/api/p/${key}/ensure`, { method: 'POST', headers: { Cookie: session.cookie, Origin: session.url, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' }, body: '{}' });
  const before = await (await fetch(session.url + `/catalog/api/p/${key}/overview`, { headers })).json();
  assert.ok(before.projects.some(p => p.id === 'p'));
  // Restart the project service on a new port; the cached gateway session points at a dead origin.
  const root = target.monitor.directory.replace(/[\\/]monitor$/, '');
  await target.close();
  const restarted = await require('./service-fixture.cjs').serve(root); t.after(() => restarted.close());
  const after = await (await fetch(session.url + `/catalog/api/p/${key}/overview`, { headers })).json();
  assert.ok(after.projects.some(p => p.id === 'p'));
  assert.notEqual(after.instanceId, before.instanceId);
});
// [AI-added] 2026-09-17 19:20
test('a second launch reuses the running catalog console instead of failing on a busy port',async t=>{
  const temp=fs.mkdtempSync(path.resolve('tmp/catalog-reuse-')),file=path.join(temp,'registry.json'),home=path.join(temp,'home'),stateFile=path.join(temp,'console.json');t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  assert.equal(await reuse({stateFile}),null);
  const first=await serve({registryOptions:{file,home},stateFile});t.after(()=>first.close());
  const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));assert.equal(state.port,first.port);assert.equal(state.pid,process.pid);
  const url=await reuse({stateFile});assert.equal(new URL(url).port,String(first.port));
  const base=`http://127.0.0.1:${first.port}`,response=await fetch(base+'/catalog/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({ticket:new URL(url).hash.slice(8)})});
  assert.equal(response.status,200);
  assert.equal(await reuse({stateFile:path.join(temp,'other.json')}),null);
  const second=await serve({port:first.port,registryOptions:{file,home}});t.after(()=>second.close());
  assert.ok(second.port>first.port&&second.port<=first.port+19,'expected the console to move to a free port, got '+second.port);
  assert.equal((await fetch(`http://127.0.0.1:${second.port}/catalog/`)).status,200);
  const third=await fetch(`http://127.0.0.1:${first.port}/catalog/ticket`,{method:'POST'});assert.equal(third.status,401);
});
test('console reuse only discovers the home record even with a live legacy AppData console',async t=>{
  const mod=require('../runtime/catalog-console.cjs');
  const temp=fs.mkdtempSync(path.resolve('tmp/catalog-home-')),home=path.join(temp,'home'),cacheRoot=path.join(home,'AppData','Local');
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const oldFile=path.join(cacheRoot,'task-dispatch','console.json'),currentFile=mod.consoleFile(home);
  assert.equal(currentFile,path.join(home,'.task-dispatch-service','console.json'));
  const old=await serve({stateFile:oldFile});t.after(()=>old.close());
  assert.equal(await reuse({home,cacheRoot}),null);
  const current=await serve({stateFile:currentFile});
  try {assert.equal(new URL(await reuse({home,cacheRoot})).port,String(current.port));}
  finally {await current.close();}
  assert.equal(await reuse({home,cacheRoot}),null);
});
// [AI-added] 2026-09-21: the home page controls each project's own service process.
test('catalog home reports service version and guards start, stop and restart', async t => {
  const { target, session, key } = await fixture(t, 'catalog-service-control-');
  const root = target.monitor.directory.replace(/[\\/]monitor$/, '');
  // start spawns the service detached. A failed assertion must not leave it running, and by
  // teardown the fixture directory may already be gone, so fall back to killing the pid.
  const { spawnSync } = require('node:child_process'), { alive } = require('../runtime/core/storage.cjs');
  const spawned = [];
  const track = () => { try { const pid = JSON.parse(fs.readFileSync(path.join(root, 'endpoint.json'), 'utf8')).pid; if (Number.isInteger(pid)) spawned.push(pid); } catch { /* already removed */ } };
  t.after(async () => {
    for (const pid of spawned) {
      if (!alive(pid)) continue;
      spawnSync(process.execPath, [path.resolve('runtime/cli.cjs'), 'stop', '--data', root], { windowsHide: true, timeout: 20000 });
      for (let attempt = 0; attempt < 40 && alive(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 250));
      if (alive(pid)) process.kill(pid);
    }
  });
  const post = value => fetch(session.url + '/catalog/api/service', { method: 'POST', headers: { Cookie: session.cookie, Origin: session.url, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const view = async () => (await (await fetch(session.url + '/catalog/api/projects', { headers: { Cookie: session.cookie } })).json()).projects[0];
  assert.equal((await fetch(session.url + '/catalog/api/service', { method: 'POST', headers: { Cookie: session.cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await post({ key, action: 'pause' })).status, 400);
  assert.equal((await post({ key, action: 'stop' })).status, 400);
  assert.equal((await view()).serviceVersion, require('../package.json').version);
  target.store.change(s => { s.projects.p.tasks.T = { id: 'T', title: 'T', state: 'running', ...taskFields(), attempts: [{ id: 'a', contractRevision:1, role: 'worker', claimedBy: 'client', settled: false }] }; });
  const facts = await view(); assert.equal(facts.inFlight, 1); assert.equal(facts.unclaimed, 1);
  const stopped = await post({ key, action: 'stop', confirmed: true }), stopResult = await stopped.json();
  assert.equal(stopped.status, 200, JSON.stringify(stopResult));
  assert.equal(stopResult.online, false); assert.equal(stopResult.unclaimed, 1);
  assert.equal((await view()).serviceVersion, undefined);
  // Restart on a stopped service brings it back up.
  const restartResult = await (await post({ key, action: 'restart', confirmed: true })).json();
  assert.equal(restartResult.online, true); assert.equal(restartResult.serviceVersion, require('../package.json').version);
  track();
  assert.equal((await post({ key, action: 'start' })).status, 200);
  assert.equal((await view()).online, true);
  track();
});
// [AI-added] 2026-09-19
test('catalog cleanup route removes stale index entries behind the CSRF guard',async t=>{
  const temp=fs.mkdtempSync(path.resolve('tmp/catalog-cleanup-')),file=path.join(temp,'registry.json'),home=path.join(temp,'home');t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  // Pure index residue: the per-project data root lives inside the vanished workspace.
  const dead=path.join(temp,'dead-project'),deadRoot=path.join(dead,'service-data');fs.mkdirSync(deadRoot,{recursive:true});
  registry.register(deadRoot,[dead],{file});fs.rmSync(dead,{recursive:true,force:true});
  const catalog=await serve({registryOptions:{file,home}});t.after(()=>catalog.close());const session=await login(catalog);
  assert.equal((await fetch(session.url+'/catalog/api/cleanup-invalid',{method:'POST',headers:{Cookie:session.cookie,'Content-Type':'application/json'}})).status,403);
  const response=await fetch(session.url+'/catalog/api/cleanup-invalid',{method:'POST',headers:{Cookie:session.cookie,Origin:session.url,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.deepEqual(result.removed.map(entry=>path.resolve(entry.workspace)),[path.resolve(dead)]);
  assert.deepEqual((await (await fetch(session.url+'/catalog/api/projects',{headers:{Cookie:session.cookie}})).json()).projects,[]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).projects,{});
  const again=await (await fetch(session.url+'/catalog/api/cleanup-invalid',{method:'POST',headers:{Cookie:session.cookie,Origin:session.url,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'},body:'{}'})).json();
  assert.deepEqual(again.removed,[]);
});
