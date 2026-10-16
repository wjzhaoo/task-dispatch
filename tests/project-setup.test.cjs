'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { atomic } = require('../runtime/core/storage.cjs');
const { projectDataRoot } = require('../runtime/core/data-root.cjs');
const { request } = require('../runtime/wizard.cjs');
const { call } = require('../runtime/desktop-client.cjs');
const setup = require('../runtime/core/project-setup.cjs');
const client = path.resolve(__dirname, '../runtime/desktop-client.cjs');

async function fixture(t, { cold = false, workspaceName = '中文 project' } = {}) {
  fs.mkdirSync(path.resolve('tmp'), { recursive: true });
  const temp = fs.mkdtempSync(path.resolve('tmp/web-project-')), workspace = path.join(temp, workspaceName), root = projectDataRoot(workspace);
  fs.mkdirSync(workspace);
  let target, catalog, verifies = 0, sends = [];
  t.after(async () => {
    if (catalog) await catalog.close();
    if (target) await target.close();
    else if (fs.existsSync(path.join(root, 'endpoint.json'))) {
      await request(root, { action: 'stop' });
      const deadline = Date.now() + 8000;
      while (fs.existsSync(path.join(root, 'service.lock')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(fs.existsSync(path.join(root, 'service.lock')), false);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  if (!cold) {
    atomic(path.join(root, 'config.json'), { version: 1, enableRealCalls: false, maxConcurrent: 1, profiles: { codex: { adapter: 'codex', command: process.execPath, args: [] } } });
    const adapter = { resolveTurn: async () => 'real-test-turn',
      read: async binding => ({ thread: { id: binding.threadId, cwd: workspace, status: { type: 'idle' } }, turns: [] }),
      verify: async binding => { verifies++; return adapter.read(binding); },
      send: async (_binding, message) => { sends.push(message); return {}; } };
    target = await require('../runtime/server.cjs').serve(root, { wakeAdapter: { forProvider: () => adapter } });
  }
  catalog = await require('../runtime/catalog-console.cjs').serve({ registryOptions: { file: path.join(temp, 'registry.json'), home: path.join(temp, 'home') } });
  const url = `http://127.0.0.1:${catalog.port}`;
  const login = await fetch(url + '/catalog/login', { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(catalog.createTicket()).hash.slice(8) }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrf;
  const input = { commandId: crypto.randomUUID(), workspace, title: '制作存档功能', objective: '支持中文存档名称\n重启后仍可读取', workers: [
    { workerId: 'strong', capability: 'strong', responsibilities: '存档核心接口' },
    { workerId: 'economy', capability: 'economy', responsibilities: '界面与检查' } ] };
  const api = (route, payload, headers = {}) => fetch(url + '/catalog/api/' + route, { method: payload ? 'POST' : 'GET', headers: { Cookie: cookie, ...(payload ? { Origin: url, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } : {}), ...headers }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  async function create() { const response = await api('projects', input), value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; }
  return { temp, workspace, root, target, catalog, url, api, create, input, verifies: () => verifies, sends, cookie };
}

test('Web creation validates the entire form before writing and requires browser authentication/CSRF', async t => {
  const x = await fixture(t, { cold: true });
  assert.equal((await fetch(x.url + '/catalog/api/projects', { method: 'POST', body: JSON.stringify(x.input) })).status, 401);
  assert.equal((await x.api('projects', x.input, { 'X-CSRF-Token': 'wrong' })).status, 403);
  for (const change of [{ workspace: 'relative/path' }, { title: '' }, { objective: 'x'.repeat(12001) }, { workers: [] }, { workers: [x.input.workers[0], x.input.workers[0]] }, { workers: [{ ...x.input.workers[0], capability: 'bad label' }] }]) {
    assert.equal((await x.api('projects', { ...x.input, ...change })).status, 400);
    assert.equal(fs.existsSync(x.root), false);
  }
  const created = await x.create();
  const state = await request(x.root);
  assert.equal(state.projects[created.projectId].startup.state, 'waiting');
  assert.deepEqual(state.projects[created.projectId].tasks, {});
  assert.deepEqual(state.projects[created.projectId].staffing.workers, x.input.workers);
  assert.match(fs.readFileSync(path.join(x.workspace, '.task-dispatch/.gitignore'), 'utf8'), /runtime\//);
});

test('concurrent Web creation is durable and idempotent, while conflicting requests preserve the original', async t => {
  const x = await fixture(t);
  const started = performance.now();
  const values = await Promise.all([x.create(), x.create(), x.create()]);
  t.diagnostic(`三个并发创建请求共 ${(performance.now() - started).toFixed(0)} ms`);
  assert.equal(new Set(values.map(v => v.projectId)).size, 1);
  assert.equal(values.filter(v => v.duplicate).length, 2);
  const list = await (await x.api('projects')).json(); assert.equal(list.projects.length, 1); assert.equal(list.projects[0].title, path.basename(x.workspace));
  assert.equal(Object.keys(x.target.store.state.projects).length, 1);
  const before = structuredClone(x.target.store.state.projects[values[0].projectId]);
  assert.equal((await x.api('projects', { ...x.input, title: 'conflict' })).status, 400);
  assert.deepEqual(x.target.store.state.projects[values[0].projectId], before);
  assert.equal((await x.create()).duplicate, true);
  const added = await (await x.api('projects', { ...x.input, commandId: crypto.randomUUID(), title: '新增目标' })).json();
  assert.equal(added.projectId, values[0].projectId); assert.notEqual(added.goalId, values[0].goalId);
  assert.equal(Object.keys(x.target.store.state.projects[added.projectId].goals).length, 2);
  assert.deepEqual(x.target.store.state.projects[added.projectId].goals[values[0].goalId], before.goals[values[0].goalId]);
});

test('each member has stable platform-specific initial invitations; reads never expose role credentials', async t => {
  const x = await fixture(t), created = await x.create(), prefix = `p/${created.key}/`;
  const snapshot = await (await x.api(prefix + 'overview')).json(), p = snapshot.projects.find(p => p.id === created.projectId);
  assert.equal(p.team.total, 4); assert.equal(p.team.ready, 0); assert.equal(p.team.canStart, false);
  const ids = new Set();
  for (const member of p.team.members) {
    const route = prefix + 'join-invite?' + new URLSearchParams({ projectId: p.id, binding: member.binding });
    const invite = await (await x.api(route)).json(), again = await (await x.api(route)).json();
    assert.equal(invite.invitationId, again.invitationId); ids.add(invite.invitationId);
    assert.equal(invite.operation, 'connect'); assert.equal(invite.kind, 'join');
    assert.doesNotMatch(JSON.stringify(invite), /tokenHash|"token"|rebind --/);
    for (const variant of invite.platforms) {
      assert.match(variant.text, /node '.+desktop-client\.cjs' connect --provider/);
      assert.ok(variant.commandTemplate.includes(`--join-invitation ${invite.invitationId}`));
      assert.ok(variant.commandTemplate.includes(`--workspace '${x.workspace}'`));
      if (variant.provider === 'codex') assert.doesNotMatch(variant.commandTemplate, /--session-id|--invitation-id/);
      if (variant.provider === 'qoder') assert.match(variant.commandTemplate, /--invitation-id/);
      if (variant.provider === 'mimo') assert.match(variant.commandTemplate, /--session-id/);
    }
  }
  assert.equal(ids.size, 4);
  assert.equal((await x.api(prefix + 'join-invite?projectId=' + p.id + '&binding=absent')).status, 400);
  assert.equal((await fetch(x.url + '/catalog/api/' + prefix + 'join-invite?projectId=' + p.id + '&binding=brain')).status, 401);
  assert.equal(x.verifies(), 0); assert.equal(x.sends.length, 0);
});

test('chunked UTF-8 form submission preserves Chinese characters across network chunks', async t => {
  const x = await fixture(t), input = { ...x.input, objective: '中文目标和验收条件' }, bytes = Buffer.from(JSON.stringify(input));
  const cut = bytes.indexOf(Buffer.from(input.objective)) + 1;
  const result = await new Promise((resolve, reject) => {
    const req = require('node:http').request(x.url + '/catalog/api/projects', { method: 'POST', headers: { Cookie: x.cookie, Origin: x.url, 'X-CSRF-Token': 'unused', 'Content-Type': 'application/json' } });
    // Resolve the browser CSRF token through its authenticated session first.
    x.api('session').then(r => r.json()).then(session => {
      req.setHeader('X-CSRF-Token', session.csrf);
      req.on('error', reject); req.on('response', res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks)) })); });
      req.write(bytes.subarray(0, cut)); setTimeout(() => req.end(bytes.subarray(cut)), 20);
    }).catch(reject);
  });
  assert.equal(result.status, 200);
  assert.equal(x.target.store.state.projects[result.value.projectId].objective, input.objective);
});

test('a copied PowerShell invitation runs safely from paths containing apostrophes and dollar expressions', { skip: process.platform !== 'win32' }, async t => {
  const x = await fixture(t, { workspaceName: "中文 project's $()" }), created = await x.create();
  const p = x.target.store.state.projects[created.projectId];
  const invitation = setup.invitation(x.target.admin.desktop, p, x.root, 'brain');
  const command = invitation.platforms.find(v => v.provider === 'codex').text.split('\n').find(line => line.startsWith('node '));
  const output = JSON.parse((await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command + ' --session-id shell-test-session'], { cwd: x.workspace, windowsHide: true })).stdout);
  assert.equal(output.parked, true); assert.equal(output.projectId, created.projectId); assert.equal(x.verifies(), 1);
});

async function connectAll(x, created) {
  const p = x.target.store.state.projects[created.projectId];
  const specifications = setup.team(x.target.admin.desktop, p).members;
  const run = (member, session = member.binding, withoutInvitation = false) => execFile(process.execPath, [client, 'connect', '--provider', 'codex', '--role', member.role,
    '--session-id', session, '--workspace', x.workspace, '--data', x.root, ...(withoutInvitation ? [] : ['--join-invitation', p.webSetup.invitations[member.binding]]),
    ...(member.role === 'worker' ? ['--worker-id', member.workerId, '--capability', member.capability] : [])], { cwd: x.workspace, windowsHide: true });
  const started = performance.now(), outputs = await Promise.all(specifications.map(async member => JSON.parse((await run(member)).stdout)));
  return { specifications, outputs, run, elapsed: performance.now() - started };
}

test('members connect in parallel with one identity verification each, park automatically, and initial invites cannot replace an owner', async t => {
  const x = await fixture(t); x.input.startMode = 'manual';
  const created = await x.create(), peers = await connectAll(x, created);
  t.diagnostic(`四个成员并行 connect 共 ${peers.elapsed.toFixed(0)} ms；每个成员只核验一次宿主身份`);
  for (const output of peers.outputs) { assert.equal(output.parked, true); assert.equal(output.nextAction, 'standby'); assert.equal(output.peerSetupManagedBy, 'web'); }
  assert.deepEqual(peers.outputs[0].brief, { goalId: created.goalId, title: x.input.title, objective: x.input.objective });
  assert.equal(peers.outputs[0].reviewerInvite, undefined); assert.equal(peers.outputs[0].workerInvites, undefined);
  assert.equal(x.verifies(), 4); assert.equal(x.sends.length, 0);
  const desktop = x.target.admin.desktop, p = x.target.store.state.projects[created.projectId];
  assert.equal(setup.team(desktop, p).canStart, true); assert.equal(p.startup.state, 'waiting'); assert.deepEqual(p.tasks, {});
  const worker = peers.specifications[2], owner = p.bindings[worker.binding].clientId;
  await assert.rejects(peers.run(worker, 'other-worker-session'), /首次邀请不能替换/);
  await assert.rejects(peers.run(worker, 'another-direct-session', true), /rebind 或管理端改绑/);
  assert.equal(x.target.store.state.projects[p.id].bindings[worker.binding].clientId, owner);
  assert.equal(JSON.parse((await peers.run(worker)).stdout).parked, true);
  assert.equal(x.verifies(), 4);
});

test('a saved Web goal starts once with explicit authorization and survives service restart', async t => {
  const x = await fixture(t); x.input.startMode = 'manual';
  const created = await x.create(), prefix = `p/${created.key}/`, desktop = x.target.admin.desktop;
  async function start(extra = {}) {
    const overview = await (await x.api(prefix + 'overview')).json();
    return x.api(prefix + 'commands', { commandId: crypto.randomUUID(), instanceId: overview.instanceId, revision: overview.revision, projectId: created.projectId, goalId: created.goalId, action: 'start-goal', confirmed: true, ...extra });
  }
  assert.equal((await start({ confirmed: false })).status, 400);
  assert.equal(x.target.store.state.projects[created.projectId].startup.state, 'waiting');
  // CLI connection is covered above. Exercise startup through the real HTTP protocol here.
  const credentials = await Promise.all(setup.team(desktop, x.target.store.state.projects[created.projectId]).members.map(async member => {
    const credential = await request(x.root, { action: 'attach-desktop', workspace: x.workspace, role: member.role, workerId: member.workerId,
      capabilities: member.capability ? [member.capability] : [], clientId: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'), sessionId: member.binding,
      joinInvitationId: setup.joinId(x.target.store.state.projects[created.projectId], member.binding) });
    await call(x.root, credential, { action: 'configure-continuation', provider: 'codex' });
    await call(x.root, credential, { action: 'park' });
    return credential;
  }));
  assert.equal((await start({ confirmed: false })).status, 400);
  const overview = await (await x.api(prefix + 'overview')).json(), command = { commandId: crypto.randomUUID(), instanceId: overview.instanceId, revision: overview.revision, projectId: created.projectId, goalId: created.goalId, action: 'start-goal', confirmed: true };
  const result = await (await x.api(prefix + 'commands', command)).json(); assert.equal(result.ok, true);
  assert.equal((await (await x.api(prefix + 'commands', command)).json()).duplicate, true);
  const p = x.target.store.state.projects[created.projectId], planningId = p.planning.id;
  assert.equal(p.startup.state, 'started'); assert.equal(p.planning.kind, 'initial');
  await x.target.monitor.wake.run();
  assert.equal(x.sends.length, 1); assert.match(x.sends[0], /Web 管理端确认开始/);
  const credential = credentials[0];
  const job = (await call(x.root, credential, { action: 'claim' })).job;
  assert.equal(job.kind, 'planning'); assert.equal(job.planningId, planningId); assert.deepEqual(job.brief, { goalId: created.goalId, title: x.input.title, objective: x.input.objective }); assert.ok(job.prompt.includes(x.input.objective));
  assert.equal(setup.team(desktop, x.target.store.state.projects[p.id]).canStart, false);
  const queued = await (await x.api('projects', { ...x.input, commandId: crypto.randomUUID(), title: '重启后继续', startMode: 'auto' })).json();
  const draft = await (await x.api('projects', { ...x.input, commandId: crypto.randomUUID(), title: '重启后仍只保存' })).json();
  await x.target.close();
  const restarted = await require('../runtime/server.cjs').serve(x.root, { wakeAdapter: { forProvider: () => ({ read: async () => ({ thread: { status: { type: 'active' } } }) }) } });
  try {
    const restored = restarted.store.state.projects[p.id];
    assert.equal(restored.startup.state, 'started'); assert.equal(restored.planning.id, planningId);
    assert.equal(restored.activeGoalId, created.goalId); assert.deepEqual(restored.goalQueue, [queued.goalId]);
    assert.ok(restored.goals[queued.goalId].startAuthorizedAt); assert.equal(restored.goals[draft.goalId].state, 'draft'); assert.equal(restored.goals[draft.goalId].startAuthorizedAt, null);
  }
  finally { await restarted.close(); }
});

test('default three-member team starts an authorized goal once; appending and repeated starts never reconfigure or wake twice', async t => {
  const x = await fixture(t); delete x.input.workers;
  const created = await x.create(), p = () => x.target.store.state.projects[created.projectId], prefix = `p/${created.key}/`;
  assert.equal(setup.team(x.target.admin.desktop, p()).total, 3); assert.equal(p().goals[created.goalId].state, 'queued');
  await connectAll(x, created); x.target.dispatcher.tick();
  assert.equal(p().activeGoalId, created.goalId); assert.equal(p().planning.goalId, created.goalId);
  await x.target.monitor.wake.run();
  const planningId = p().planning.id, binds = structuredClone(p().bindings);
  for (let i = 0; i < 2; i++) {
    const snapshot = await (await x.api(prefix + 'overview')).json();
    const result = await (await x.api(prefix + 'commands', { commandId: crypto.randomUUID(), instanceId: snapshot.instanceId, revision: snapshot.revision, projectId: p().id, goalId: created.goalId, action: 'start-goal', confirmed: true })).json();
    assert.equal(result.duplicate, true);
  }
  assert.equal((await x.create()).goalId, created.goalId);
  const second = await (await x.api('projects', { ...x.input, commandId: crypto.randomUUID(), title: '稍后执行' })).json();
  assert.deepEqual(p().goalQueue, [second.goalId]); assert.equal(p().planning.id, planningId); assert.deepEqual(p().bindings, binds);
  await x.target.monitor.wake.run(); assert.equal(x.sends.length, 1); assert.equal(x.verifies(), 3);
  const snapshot = await (await x.api(prefix + 'overview')).json();
  const cancelled = await (await x.api(prefix + 'commands', { commandId: crypto.randomUUID(), instanceId: snapshot.instanceId, revision: snapshot.revision, projectId: p().id, goalId: second.goalId, action: 'cancel-goal' })).json();
  assert.equal(cancelled.ok, true); assert.equal(p().goals[second.goalId].state, 'cancelled'); assert.deepEqual(p().goalQueue, []);
});
