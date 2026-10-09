// [AI-added] 2026-09-16: Browser authorization, replay, operator ownership and observation truth.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { serve } = require('../runtime/server.cjs');
const { atomic } = require('../runtime/core/storage.cjs');
const { Monitor } = require('../runtime/core/monitor.cjs');
const lifecycle = require('../runtime/core/lifecycle.cjs');
async function fixture(t, options = {}) {
  const base = path.resolve('tmp/admin-console/tests'); fs.mkdirSync(base, { recursive: true });
  const temp = fs.mkdtempSync(path.join(base, 'case-')), root = path.join(temp, 'data'), workspace = path.join(temp, 'work');
  fs.mkdirSync(workspace); fs.mkdirSync(root);
  atomic(path.join(root, 'config.json'), { version: 1, enableRealCalls: false, maxConcurrent: 1, profiles: { codex: { adapter: 'codex', command: process.execPath, args: [] } } });
  const s = await serve(root, options); t.after(() => s.close());
  const url = 'http://127.0.0.1:' + s.server.address().port, token = fs.readFileSync(path.join(root, 'admin-token'), 'utf8');
  s.dispatcher.addProject({ id: 'project', workspace, mode: 'desktop' });
  const request = (route, opts) => fetch(url + route, opts);
  async function login() {
    const ticket = await (await request('/admin/ticket', { method: 'POST', headers: { Authorization: 'Bearer ' + token } })).json();
    const value = new URL(ticket.url).hash.slice(8);
    const response = await request('/admin/login', { method: 'POST', headers: { Origin: url }, body: JSON.stringify({ ticket: value }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0], { csrf } = await response.json();
    const headers = { Cookie: cookie, Origin: url, 'X-CSRF-Token': csrf };
    return { headers, value };
  }
  return { s, root, workspace, url, token, request, login };
}
function lifecycleCommand(f, extra) {
  return f.s.admin.command({commandId:crypto.randomUUID(),instanceId:f.s.monitor.instanceId,revision:f.s.store.state.revision,projectId:'project',confirmed:true,reason:'隔离功能验证',...extra});
}
test('service diagnostics include version, process identity and structured lifecycle logs',async t=>{
  const records=[],f=await fixture(t,{logger:value=>records.push(value)}),snapshot=f.s.monitor.snapshot();
  assert.equal(snapshot.runtimeVersion,require('../package.json').version);assert.equal(snapshot.pid,process.pid);assert.match(snapshot.instanceId,/^[a-f0-9-]{36}$/);
  const started=records.find(x=>x.event==='service_started');assert.equal(started.runtimeVersion,require('../package.json').version);assert.equal(started.instanceId,snapshot.instanceId);assert.equal(started.pid,process.pid);assert.ok(Number.isInteger(started.port));assert.equal(started.dataRoot,f.root);
  const event=f.s.monitor.recent.find(x=>x.type==='service_started');assert.equal(event.runtimeVersion,require('../package.json').version);assert.equal(event.nodeVersion,process.version);assert.equal(event.pid,process.pid);
  await f.s.close();assert.equal(records.at(-1).event,'service_stopping');assert.equal(records.at(-1).instanceId,snapshot.instanceId);
});
test('archive hides no data, blocks clients and dispatch, and restores paused',async t=>{
  const f=await fixture(t), desktop=f.s.admin.desktop;
  const client=desktop.attach({workspace:f.workspace,role:'worker',clientId:'worker-client',token:crypto.randomBytes(32).toString('hex')});
  const result=await lifecycleCommand(f,{action:'archive-project'});assert.equal(result.ok,true);
  assert.ok(f.s.monitor.snapshot().projects[0].archivedAt);assert.equal(f.s.store.state.projects.project.paused,true);
  assert.throws(()=>desktop.assertBinding(client),/archived/);
  assert.throws(()=>f.s.dispatcher.pause('project',false),/Restore/);
  assert.equal((await lifecycleCommand(f,{action:'restore-project'})).ok,true);
  assert.equal(f.s.store.state.projects.project.archivedAt,undefined);assert.equal(f.s.store.state.projects.project.paused,true);
  assert.doesNotThrow(()=>desktop.assertBinding(client));
});
test('delete revokes credentials, preserves source files and prevents stale auto-recreation',async t=>{
  const f=await fixture(t), desktop=f.s.admin.desktop, token=crypto.randomBytes(32).toString('hex');
  desktop.attach({workspace:f.workspace,role:'worker',clientId:'worker-client',token});
  fs.writeFileSync(path.join(f.workspace,'original.txt'),'keep');
  assert.equal((await lifecycleCommand(f,{action:'delete-project',confirmText:'wrong'})).ok,false);
  assert.ok(f.s.store.state.projects.project);
  assert.equal((await lifecycleCommand(f,{action:'delete-project',confirmText:'project'})).ok,true);
  assert.equal(f.s.store.state.projects.project,undefined);assert.throws(()=>desktop.authenticate(token),/Invalid/);
  assert.equal(fs.readFileSync(path.join(f.workspace,'original.txt'),'utf8'),'keep');
  assert.throws(()=>f.s.dispatcher.addProject({id:'project',workspace:f.workspace,mode:'desktop'}),/deleted/);
  assert.throws(()=>desktop.attach({workspace:f.workspace,role:'worker',clientId:'worker-client',token}),/deleted/);
  f.s.dispatcher.addProject({id:'project',workspace:f.workspace,mode:'desktop',recreateDeleted:true});
  assert.throws(()=>desktop.authenticate(token),/Invalid/);
});
test('reset clears runtime state, invalidates old submissions, preserves definition and audit',async t=>{
  const f=await fixture(t), desktop=f.s.admin.desktop;
  const client=desktop.attach({workspace:f.workspace,role:'worker',clientId:'worker-client',token:crypto.randomBytes(32).toString('hex')});
  f.s.store.change(s=>{const p=s.projects.project;p.startup={state:'started'};p.paused=true;p.completedAt='old';p.turns=9;
    p.tasks.T={id:'T',title:'Keep definition',instructions:'write x',acceptance:'correct',allowedPaths:['x.txt'],dependsOn:[],state:'accepted',attempts:[{id:'old-run',role:'worker',claimedBy:client.clientId,settled:true}],maxAttempts:90,repairs:2,sessions:{worker:{id:'old-session'}},artifactId:'old-artifact',preReview:{verdict:'pass'},scopeRecovery:{old:true},wakeNotice:{status:'sent'}};
    p.planning={id:'old-plan',state:'pending',acceptedTaskIds:['T']};p.planningHistory=[{id:'older',acceptedTaskIds:['T']}];});
  const result=await lifecycleCommand(f,{action:'reset-task',taskId:'T',confirmText:'T'});assert.equal(result.ok,true);
  const p=f.s.store.state.projects.project,task=p.tasks.T;
  assert.equal(task.state,'ready');assert.deepEqual(task.attempts,[]);assert.deepEqual(task.sessions,{});assert.equal(task.maxAttempts,30);assert.equal(task.repairs,0);
  for(const k of ['artifactId','preReview','scopeRecovery','wakeNotice'])assert.equal(task[k],undefined);
  assert.equal(task.title,'Keep definition');assert.equal(p.paused,true);assert.equal(p.completedAt,undefined);assert.equal(p.turns,9);assert.equal(p.planning,undefined);assert.deepEqual(p.planningHistory,[]);
  assert.throws(()=>desktop.submit(client,{taskId:'T',attemptId:'old-run',result:{}}),/identity mismatch/);
  const history=JSON.parse(fs.readFileSync(path.join(f.root,'task-resets',result.resetId+'.json'),'utf8'));assert.equal(history.tasks[0].attempts[0].id,'old-run');
});
test('reset requires explicit cascade for processed descendants and previews all affected tasks',async t=>{
  const f=await fixture(t);f.s.store.change(s=>{const p=s.projects.project;p.paused=true;for(const [id,dep]of [['A',[]],['B',['A']],['C',['B']],['Z',[]]])p.tasks[id]={id,title:id,instructions:'i',acceptance:'a',allowedPaths:['x'],dependsOn:dep,state:'accepted',attempts:[],maxAttempts:30};});
  const view=lifecycle.preview(f.s.store.state.projects.project,{action:'reset-task',taskId:'A'});assert.deepEqual(view.affectedTasks.map(t=>t.id),['A','B','C']);
  assert.equal((await lifecycleCommand(f,{action:'reset-task',taskId:'A',confirmText:'A'})).ok,false);
  assert.equal((await lifecycleCommand(f,{action:'reset-task',taskId:'A',confirmText:'A',resetDependents:true})).ok,true);
  for(const id of ['A','B','C'])assert.equal(f.s.store.state.projects.project.tasks[id].state,'ready');assert.equal(f.s.store.state.projects.project.tasks.Z.state,'accepted');
});
test('live processing and unconfirmed in-flight tasks cannot be deleted or reset',async t=>{
  const f=await fixture(t);f.s.store.change(s=>{s.projects.project.tasks.T={id:'T',title:'T',state:'running',attempts:[{id:'old',role:'worker',settled:false}],maxAttempts:30};});
  assert.equal((await lifecycleCommand(f,{action:'archive-project'})).ok,false);
  assert.equal((await lifecycleCommand(f,{action:'reset-task',taskId:'T',confirmText:'T'})).ok,false);
  f.s.dispatcher.active.set('project',{});
  assert.equal((await lifecycleCommand(f,{action:'delete-project',confirmText:'project',confirmedStopped:true})).ok,false);
  f.s.dispatcher.active.delete('project');
  assert.equal((await lifecycleCommand(f,{action:'reset-task',taskId:'T',confirmText:'T',confirmedStopped:true})).ok,true);
});
test('browser login is one-time, same-origin, CSRF protected and snapshot excludes credentials', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/admin/api/overview')).status, 401);
  assert.equal((await f.request('/admin/', { headers: { Origin: 'https://evil.example' } })).status, 403);
  const { headers, value } = await f.login();
  assert.equal((await f.request('/admin/login', { method: 'POST', headers: { Origin: f.url }, body: JSON.stringify({ ticket: value }) })).status, 401);
  f.s.store.change(state => { state.projects.project.bindings = { brain: { clientId: 'brain-client', tokenHash: 'never-export-this', sessionId: 'session1', wake: { provider: 'codex', token: 'never-export-this' } } }; });
  const r = await f.request('/admin/api/overview', { headers }); const text = await r.text();
  assert.equal(r.status, 200); assert.ok(!text.includes('never-export-this')); assert.ok(!text.includes(f.token));
  assert.equal((await f.request('/admin/api/commands', { method: 'POST', headers: { Cookie: headers.Cookie, Origin: f.url }, body: '{}' })).status, 403);
  assert.equal((await f.request('/status', { headers: { Authorization: 'Bearer ' + f.token, Origin: f.url } })).status, 403);
});
// [AI-added] 2026-09-17 13:54
test('web console opens a catalog project on its own service without workspace input', async t => {
  const f = await fixture(t), temp = fs.mkdtempSync(path.join(path.resolve('tmp/admin-console/tests'), 'target-')), root = path.join(temp, 'data'), workspace = path.join(temp, 'work');
  fs.mkdirSync(root); fs.mkdirSync(workspace); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  atomic(path.join(root, 'config.json'), { version: 1, enableRealCalls: false, maxConcurrent: 1, profiles: { codex: { adapter: 'codex', command: process.execPath, args: [] } } });
  const target = await serve(root); t.after(() => target.close()); target.dispatcher.addProject({ id: 'catalog-project', workspace, mode: 'desktop' });
  const original = f.s.admin.overview.bind(f.s.admin); f.s.admin.overview = () => ({ ...original(), projects: [{ id: 'catalog-project', workspace, service: { dataRoot: root, online: true } }] });
  const opened = await f.s.admin.openProject('catalog-project'); assert.equal(opened.current, false); assert.match(opened.url, new RegExp(`^http://127\\.0\\.0\\.1:${target.server.address().port}/admin/#ticket=`));
  const ticket = new URL(opened.url).hash.slice(8), targetUrl = `http://127.0.0.1:${target.server.address().port}`;
  const login = await fetch(targetUrl + '/admin/login', { method: 'POST', headers: { Origin: targetUrl }, body: JSON.stringify({ ticket }) }); assert.equal(login.status, 200);
});
test('command receipts prevent duplicate mutations and stale revisions cannot control projects', async t => {
  const f = await fixture(t), { headers } = await f.login();
  const v = { commandId: crypto.randomUUID(), instanceId: f.s.monitor.instanceId, revision: f.s.store.state.revision, projectId: 'project', action: 'pause' };
  const send = async body => (await f.request('/admin/api/commands', { method: 'POST', headers, body: JSON.stringify(body) })).json();
  assert.equal((await send(v)).ok, true); const revision = f.s.store.state.revision;
  assert.equal((await send(v)).duplicate, true); assert.equal(f.s.store.state.revision, revision);
  assert.match((await send({ ...v, commandId: crypto.randomUUID(), action: 'resume' })).error, /状态已变化/);
  assert.match((await send({ ...v, action: 'resume' })).error, /不同参数/);
  const persisted = JSON.parse(fs.readFileSync(path.join(f.root, 'monitor/commands.json'), 'utf8')); assert.equal(persisted[v.commandId].state, 'completed');
});
test('SSE replays missed events and resets expired or previous-instance cursors', async t => {
  const f = await fixture(t), { headers } = await f.login();
  const cursor = f.s.monitor.sequence;
  f.s.monitor.record('test_marker', { projectId: 'project', summary: 'after snapshot' });
  async function stream(query) {
    const controller = new AbortController();
    const r = await f.request('/admin/api/stream?' + query, { headers, signal: controller.signal });
    const reader = r.body.getReader(); const { value } = await reader.read(); const text = new TextDecoder().decode(value); controller.abort(); return text;
  }
  const replay = await stream(`cursor=${cursor}&instanceId=${f.s.monitor.instanceId}`);
  assert.match(replay, /test_marker/); assert.match(replay, /event: snapshot/);
  assert.match(await stream(`cursor=${cursor}&instanceId=previous`), /event: reset/);
});
test('Qoder armed is separate from direct bridge reachability and claim', async t => {
  const f = await fixture(t), sid = 'qoder-test-session';
  const binding = { clientId: 'qoder-client', sessionId: sid, armed: true, wake: { provider: 'qoder', threadId: sid, workspace: f.workspace }, tokenHash: 'private' };
  f.s.store.change(state => { state.projects.project.bindings = { reviewer: binding }; });
  const original = f.s.monitor.wake.forProvider.bind(f.s.monitor.wake);
  f.s.monitor.wake.forProvider = provider => provider === 'qoder' ? { read: async value => ({ thread: { id: value.threadId, cwd: value.workspace, reachable: true, status: { type: 'idle' } }, turns: [] }) } : original(provider);
  const p = f.s.store.state.projects.project;
  await f.s.monitor.probe(p, 'reviewer', binding);
  const c = f.s.monitor.snapshot().projects[0].connections[0];
  assert.equal(c.armed, true); assert.equal(c.communication, 'unknown'); assert.equal(c.observation.status, 'idle');
  assert.equal(c.observation.source, 'host-api'); assert.equal(c.active.length, 0);
  assert.equal(f.s.monitor.snapshot().projects[0].alerts.some(a => a.code === 'listener'), false);
});
test('a snapshot larger than the socket high-water mark keeps the event stream open', async t => {
  const f=await fixture(t),{headers}=await f.login();
  f.s.store.change(s=>{for(let i=0;i<80;i++)s.projects.project.tasks['T'+i]={id:'T'+i,title:'大型快照'.repeat(80),state:'accepted',attempts:[],maxAttempts:30};});
  const controller=new AbortController();t.after(()=>controller.abort());
  const r=await f.request(`/admin/api/stream?cursor=${f.s.monitor.sequence}&instanceId=${f.s.monitor.instanceId}`,{headers,signal:controller.signal});
  const reader=r.body.getReader(),decoder=new TextDecoder();let text='';
  while(!text.includes('\n\n')){const part=await reader.read();assert.equal(part.done,false);text+=decoder.decode(part.value,{stream:true});}
  assert.match(text,/event: snapshot/);assert.ok(text.length>16384);
  f.s.monitor.record('after_large_snapshot',{summary:'stream still alive'});text='';
  while(!text.includes('after_large_snapshot')){const part=await reader.read();assert.equal(part.done,false);text+=decoder.decode(part.value,{stream:true});}
});
test('late host results cannot contaminate a replaced connection', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const adapter = { read: () => waiting };
  const f = await fixture(t, { wakeAdapter: { forProvider: () => adapter } });
  const b = { clientId: 'old-client', wake: { provider: 'qoder', threadId: 'session-old' } };
  f.s.store.change(state => { state.projects.project.bindings = { worker: b }; });
  const pending = f.s.monitor.probe(f.s.store.state.projects.project, 'worker', b);
  f.s.store.change(state => { state.projects.project.bindings.worker = { clientId: 'new-client' }; });
  release({ thread: { id: 'session-old', cwd: f.workspace, status: { type: 'idle' } } }); await pending;
  assert.equal(f.s.monitor.snapshot().projects[0].connections[0].observation, null);
});
test('event journal rotates, paginates, and redacts secrets', async t => {
  const f = await fixture(t); f.s.monitor.maxBytes = 700; f.s.monitor.maxFiles = 3;
  for (let i = 0; i < 20; i++) f.s.monitor.record('rotation', { projectId: 'project', summary: `token=secret-${i} Bearer abcdef`, error: 'api_key=secret' });
  assert.ok(f.s.monitor.segments().length <= 3);
  const history = await f.s.monitor.history(new URLSearchParams({ limit: '2' }));
  assert.equal(history.events.length, 2); assert.ok(!JSON.stringify(history).includes('secret')); assert.ok(!JSON.stringify(history).includes('abcdef'));
  const older = await f.s.monitor.history(new URLSearchParams({ before: String(history.nextBefore), limit: '2' }));
  assert.ok(older.events.every(e => e.sequence < history.nextBefore));
});
test('desktop heartbeat updates observation without business-state writes or event flooding', async t => {
  const f = await fixture(t), token = crypto.randomBytes(32).toString('hex');
  const identity = f.s.admin.desktop.attach({ workspace: f.workspace, role: 'worker', clientId: 'worker-client', token });
  const revision = f.s.store.state.revision;
  for (let i = 0; i < 5; i++) assert.equal((await f.request('/desktop', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify({ action: 'heartbeat' }) })).status, 200);
  assert.equal(f.s.store.state.revision, revision);
  const c = f.s.monitor.snapshot().projects[0].connections[0]; assert.equal(c.communication, 'recent');
  assert.equal(f.s.monitor.recent.filter(e => e.type === 'desktop_request' && e.action === 'heartbeat').length, 1);
  assert.equal(identity.clientId, c.clientId);
});
test('operator detach preserves an unfinished worker and uncertain wake is never resent', async t => {
  let sends = 0;
  const f = await fixture(t, { wakeAdapter: { forProvider: () => ({ send: async () => { sends++; } }) } });
  f.s.store.change(s => { const p=s.projects.project; p.paused=true;p.bindings={worker:{clientId:'worker-client'}};
    p.tasks.T={id:'T',title:'test',state:'running',maxAttempts:30,attempts:[{id:'run',role:'worker',workerId:'default',settled:false,wakeNotice:{status:'uncertain'}}]}; });
  const command = extra => f.s.admin.command({commandId:crypto.randomUUID(),instanceId:f.s.monitor.instanceId,revision:f.s.store.state.revision,projectId:'project',confirmed:true,...extra});
  assert.match((await command({action:'detach',binding:'worker',clientId:'worker-client'})).error,/unfinished/);
  assert.ok(f.s.store.state.projects.project.bindings.worker);
  assert.match((await command({action:'wake-retry',taskId:'T',attemptId:'run'})).error,/不确定/);assert.equal(sends,0);
});
// [AI-added] 2026-09-17 18:47: Operator recovery may authorize one reminder without forging a claim.
test('operator reminder arms only the current unclaimed attempt and surfaces stalled evidence',async t=>{
 const f=await fixture(t,{wakeAdapter:{forProvider:()=>({read:async()=>({thread:{status:{type:'active'}},turns:[]}),send:async()=>{throw Error('must remain idle');}})}});
 f.s.store.change(s=>{const p=s.projects.project;p.bindings={worker:{clientId:'worker-client',wake:{provider:'codex',threadId:'thread',turnId:'turn'}}};p.tasks.T={id:'T',title:'T',state:'running',maxAttempts:30,attempts:[{id:'run',role:'worker',workerId:'default',settled:false,delivery:{cwd:f.workspace,prompt:'work'},wakeNotice:{status:'sent',at:new Date(Date.now()-120000).toISOString(),claimStatus:'stalled'}}]};});
 const result=await lifecycleCommand(f,{action:'wake-remind',taskId:'T',attemptId:'run',reason:'执行员未领取，人工复核后再次提醒'});assert.equal(result.ok,true);
 const p=f.s.store.state.projects.project,a=p.tasks.T.attempts[0];assert.equal(p.bindings.worker.armed,true);assert.equal(a.claimedBy,undefined);assert.equal(a.wakeNotice.manualReminder.status,'pending');assert.equal(a.wakeNotice.claimStatus,'manual_requested');
 const snap=f.s.monitor.snapshot().projects[0];assert.ok(snap.alerts.some(x=>x.taskId==='T'&&['unclaimed','claim_stalled'].includes(x.code)));
 const stale=await f.s.admin.command({commandId:crypto.randomUUID(),instanceId:f.s.monitor.instanceId,revision:f.s.store.state.revision,projectId:'project',action:'wake-remind',taskId:'T',attemptId:'old',confirmed:true,reason:'stale'});assert.equal(stale.ok,false);assert.match(stale.error,/变化/);
});

// [AI-added] 2026-09-17 18:47: The home page owns routine controls and the reviewer topology stage.
test('web console exposes contextual recovery controls and ordered reviewer topology',()=>{
 const html=fs.readFileSync(path.resolve('runtime/web/index.html'),'utf8'),app=fs.readFileSync(path.resolve('runtime/web/app.js'),'utf8');
 assert.match(html,/id="quick-controls"/);assert.match(html,/value="wake-remind"/);assert.match(app,/renderQuickControls/);assert.match(app,/brainNodes.*reviewerNodes.*workerNodes/);assert.match(app,/brainNodes,node\('span','⇄','arrow'\),reviewerNodes/);
});
// [AI-added] 2026-09-17 11:46
test('management rebind invitation atomically replaces a stopped session and is idempotent',async t=>{
 const f=await fixture(t),desktop=f.s.admin.desktop,oldToken=crypto.randomBytes(32).toString('hex');
 const old=desktop.attach({workspace:f.workspace,role:'brain',clientId:'brain-old',token:oldToken,sessionId:'session-old'});
 const invitation=await lifecycleCommand(f,{action:'rebind-invite',binding:'brain',clientId:old.clientId,confirmedStopped:true});
 assert.equal(invitation.ok,true);assert.equal(invitation.managedRebind,true);assert.match(invitation.text,/--managed-rebind/);
 assert.deepEqual(invitation.platforms.map(x=>x.provider),['codex','mimo','qoder','opencode','any']);assert.equal(invitation.provider,'any');
 const next={workspace:f.workspace,role:'brain',clientId:'brain-new',token:crypto.randomBytes(32).toString('hex'),sessionId:'session-new',replaceClientId:old.clientId,recover:true,confirmedStopped:true,managedRebind:true,rebindInvitationId:invitation.invitationId};
 const attached=desktop.attach(next);assert.equal(attached.recovered,true);assert.throws(()=>desktop.authenticate(oldToken),/Invalid/);
 assert.equal(f.s.store.state.projects.project.rebindInvitations[invitation.invitationId].status,'completed');
 assert.equal(desktop.attach({...next,replaceClientId:undefined}).clientId,'brain-new');
});
// [AI-added] 2026-09-17 11:46
test('confirmed managed worker rebind transfers attempt and scope-recovery ownership',async t=>{
 const f=await fixture(t),desktop=f.s.admin.desktop,token=crypto.randomBytes(32).toString('hex');
 const old=desktop.attach({workspace:f.workspace,role:'worker',workerId:'strong',capabilities:['strong'],clientId:'worker-old',token,sessionId:'worker-session-old'});
 f.s.store.change(s=>{s.projects.project.tasks.T={id:'T',title:'T',state:'running',attempts:[{id:'attempt',role:'worker',workerId:'strong',claimedBy:old.clientId,settled:false}],scopeRecovery:{workerId:'strong',clientId:old.clientId},maxAttempts:30};});
 const invitation=await lifecycleCommand(f,{action:'rebind-invite',binding:'worker:strong',clientId:old.clientId,confirmedStopped:true});
 const next=desktop.attach({workspace:f.workspace,role:'worker',workerId:'strong',capabilities:['strong'],clientId:'worker-new',token:crypto.randomBytes(32).toString('hex'),sessionId:'worker-session-new',replaceClientId:old.clientId,recover:true,confirmedStopped:true,managedRebind:true,rebindInvitationId:invitation.invitationId});
 assert.equal(next.recovered,true);const task=f.s.store.state.projects.project.tasks.T;assert.equal(task.attempts[0].claimedBy,'worker-new');assert.equal(task.scopeRecovery.clientId,'worker-new');assert.throws(()=>desktop.authenticate(token),/Invalid/);
});
// [AI-added] 2026-09-21: Each receiving host resolves its session differently, so the console
// must hand over a prompt whose command already fits that platform.
test('rebind invitation emits one adapted prompt per host and defaults to the bound platform',async t=>{
 const f=await fixture(t),desktop=f.s.admin.desktop;
 const old=desktop.attach({workspace:f.workspace,role:'worker',workerId:'mimo1',capabilities:['strong'],clientId:'worker-old',token:crypto.randomBytes(32).toString('hex'),sessionId:'session-old'});
 f.s.store.change(s=>{s.projects.project.bindings['worker:mimo1'].wake={provider:'mimo',threadId:'session-old'};});
 const invitation=await lifecycleCommand(f,{action:'rebind-invite',binding:'worker:mimo1',clientId:old.clientId});
 assert.equal(invitation.ok,true,JSON.stringify(invitation));
 assert.deepEqual(invitation.platforms.map(x=>x.provider),['codex','mimo','qoder','codearts','opencode','wait','any']);
 assert.equal(invitation.provider,'mimo');assert.equal(invitation.platformLabel,'MiMo');
 assert.match(invitation.commandTemplate,/--provider mimo --session-id <当前真实会话 ID> --role worker --worker-id mimo1 --capability strong/);
 assert.doesNotMatch(invitation.commandTemplate,/--recover/);
 const by=Object.fromEntries(invitation.platforms.map(x=>[x.provider,x]));
 assert.ok(by.opencode.sessionIdRequired);assert.match(by.opencode.commandTemplate,/--provider opencode --session-id <当前真实会话 ID>/);
 assert.match(by.opencode.text,/当前真实 ses_ 会话 ID/);
 assert.ok(by.codearts.sessionIdRequired);assert.match(by.codearts.commandTemplate,/--provider codearts --session-id <当前真实会话 ID>/);
 assert.ok(!by.qoder.sessionIdRequired);assert.doesNotMatch(by.qoder.commandTemplate,/session-id/);assert.match(by.qoder.commandTemplate,new RegExp('--invitation-id '+invitation.invitationId));
 assert.match(by.codex.text,/CODEX_THREAD_ID/);assert.doesNotMatch(by.codex.commandTemplate,/session-id/);
 assert.match(by.codearts.text,/discover-session --provider codearts/);assert.match(by.mimo.text,/discover-session --provider mimo/);
 assert.match(by.wait.commandTemplate,/--provider <真实平台名>/);assert.match(by.wait.text,/不要求 --session-id/);
 assert.match(by.mimo.text,/目标平台：MiMo/);assert.match(by.mimo.text,/\[TASK-DISPATCH-REBIND:/);
 assert.ok(invitation.platforms.every(x=>x.text.includes('[TASK-DISPATCH-INVITE:'+invitation.invitationId+']')),'every platform prompt must carry the handshake marker');
});
// [AI-added] 2026-09-21
test('wait-only host names its own provider instead of the generic placeholder',async t=>{
 const f=await fixture(t),desktop=f.s.admin.desktop;
 const old=desktop.attach({workspace:f.workspace,role:'worker',workerId:'z1',clientId:'worker-old',token:crypto.randomBytes(32).toString('hex')});
 f.s.store.change(s=>{s.projects.project.bindings['worker:z1'].continuation={mode:'wait',provider:'zcode'};});
 const invitation=await lifecycleCommand(f,{action:'rebind-invite',binding:'worker:z1',clientId:old.clientId});
 assert.equal(invitation.provider,'zcode');
 assert.deepEqual(invitation.platforms.map(x=>x.provider),['codex','mimo','qoder','codearts','opencode','zcode','any']);
 assert.match(invitation.commandTemplate,/--provider zcode --role worker/);assert.doesNotMatch(invitation.commandTemplate,/session-id/);
});
// [AI-added] 2026-09-21
test('unified console renders the selected platform prompt in the rebind dialog',()=>{
 const html=fs.readFileSync(path.resolve('runtime/console-web/index.html'),'utf8'),app=fs.readFileSync(path.resolve('runtime/console-web/app.js'),'utf8');
 assert.match(html,/id="invitation-platform"/);assert.match(html,/id="invitation-hint"/);
 assert.match(app,/function renderInvitationVariant/);assert.match(app,/\$\('invitation-platform'\)\.onchange = renderInvitationVariant/);
 assert.match(app,/result\.platforms\.map/);assert.match(app,/invitation-platform'\)\.value = result\.provider/);
});
test('management consoles render resolved tasks as non-blocking audited terminal work',()=>{
 const apps=['runtime/console-web/app.js','runtime/web/app.js'].map(file=>fs.readFileSync(path.resolve(file),'utf8'));
 for(const app of apps){
  assert.match(app,/resolved:'已由后续任务解决'/);
  assert.match(app,/\['accepted', 'resolved'\]/);
  assert.match(app,/resolution/);
 }
});
// [AI-added] 2026-09-17 11:46
test('cancelling a claimed safe rebind removes its pending handover without changing owner',async t=>{
 const f=await fixture(t),desktop=f.s.admin.desktop,token=crypto.randomBytes(32).toString('hex');const old=desktop.attach({workspace:f.workspace,role:'worker',clientId:'worker-old',token,sessionId:'old'});
 f.s.store.change(s=>{s.projects.project.tasks.T={id:'T',title:'T',state:'running',attempts:[{id:'attempt',role:'worker',claimedBy:old.clientId,settled:false}],maxAttempts:30};});
 const invitation=await lifecycleCommand(f,{action:'rebind-invite',binding:'worker',clientId:old.clientId});
 const pending=desktop.attach({workspace:f.workspace,role:'worker',clientId:'worker-new',token:crypto.randomBytes(32).toString('hex'),sessionId:'new',replaceClientId:old.clientId,managedRebind:true,rebindInvitationId:invitation.invitationId});assert.equal(pending.handoverPending,true);
 const cancelled=await lifecycleCommand(f,{action:'rebind-cancel',invitationId:invitation.invitationId});assert.equal(cancelled.cancelled,true);assert.equal(f.s.store.state.projects.project.handovers?.worker,undefined);assert.equal(f.s.store.state.projects.project.bindings.worker.clientId,old.clientId);
});
test('complete worker-reviewer-brain lifecycle is correlated in monitoring and closeout', async t => {
  const f=await fixture(t), desktop=f.s.admin.desktop;
  const clients={};
  for(const role of ['brain','worker','reviewer']) clients[role]=desktop.attach({workspace:f.workspace,role,clientId:role+'-client',token:crypto.randomBytes(32).toString('hex')});
  const call=async(role,data)=>{const r=await f.request('/desktop',{method:'POST',headers:{Authorization:'Bearer '+clients[role].token},body:JSON.stringify(data)});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;};
  await call('reviewer',{action:'heartbeat'});
  await call('brain',{action:'start-work',confirmed:true});
  await call('brain',{action:'plan',task:{id:'T',title:'Fixture lifecycle',instructions:'write result',acceptance:'correct',allowedPaths:['result.txt']}});
  await call('brain',{action:'stage-register',stageId:'fixture',roundId:'fixture-r1',milestone:'Fixture lifecycle',acceptance:'correct',members:[{taskId:'T'}]});
  const claim=async role=>{for(let i=0;i<100;i++){const r=await call(role,{action:'claim'});if(r.job)return r.job;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('No job for '+role);};
  const ids=[];
  for(const role of ['worker','reviewer','brain']){
    const j=await claim(role);ids.push(j.attemptId);assert.equal(j.role,role);
    if(role==='worker')fs.writeFileSync(path.join(f.workspace,'result.txt'),'monitor fixture complete');
    if(role!=='brain')await call(role,{action:'progress',taskId:'T',attemptId:j.attemptId,sequence:1,stage:'testing',summary:'隔离联调，无真实模型调用'});
    if(role==='brain')await call(role,{action:'stage-submit',roundId:j.roundId,attemptId:j.attemptId,result:require('./stage-fixture.cjs').finalResult(j)});
    else await call(role,{action:'submit',taskId:'T',attemptId:j.attemptId,result:{projectId:j.projectId,taskId:j.taskId,attemptId:j.attemptId,role,summary:'verified',...(role==='worker'?{status:'submitted',checks:[],unverified:[]}:{artifactId:j.artifactId,verdict:'pass',findings:[]})}});
  }
  const planning=await claim('brain');assert.equal(planning.kind,'planning');
  await call('brain',{action:'closeout',planningId:planning.planningId,outcome:'blocked',summary:'隔离验收结束',planEvidence:'test assertions',reason:'不登记额外任务'});
  await call('brain',{action:'finish-project'});
  const p=f.s.monitor.snapshot().projects[0];assert.equal(p.tasks[0].state,'accepted');assert.ok(p.completedAt);
  for(const id of ids){const transitions=f.s.monitor.recent.filter(e=>e.attemptId===id&&e.type==='attempt_state').map(e=>e.status);assert.ok(transitions.includes('claimed'));assert.ok(transitions.includes('settled'));}
  assert.ok(f.s.monitor.recent.some(e=>e.type==='planning_resolved'));
});

test('storage blocker and continuation failure reach overview and role status',async t=>{
  const f=await fixture(t);
  const {Desktop}=require('../runtime/core/desktop.cjs'), desktop=new Desktop(f.s.dispatcher);
  desktop.attach({workspace:f.workspace,role:'brain',clientId:'brain-test',token:'a'.repeat(64)});
  const identity=desktop.authenticate('a'.repeat(64));
  f.s.store.change(s=>{s.projects.project.bindings.brain.provider='codex';s.projects.project.bindings.brain.continuationError='缺少真实 turnId';});
  f.s.dispatcher.storageBlocked=true;
  f.s.dispatcher.storageStatus={blocked:true,totalBytes:2*1024**3,maxBytes:1024**3};
  const snap=f.s.monitor.snapshot(), p=snap.projects.find(p=>p.id==='project');
  assert.equal(snap.health.dispatch.blocked,true);assert.match(snap.health.dispatch.reason,/2.00 GiB/);
  assert.ok(p.alerts.some(a=>a.code==='dispatch_blocked'));assert.ok(p.alerts.some(a=>a.code==='continuation'));
  assert.equal(p.connections[0].provider,'codex');assert.equal(desktop.status(identity).dispatch.blocked,true);
});
