'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { QoderWake, descriptorFile, pluginInstalled, readDescriptor, runtimeState } = require('../runtime/adapters/qoder-wake.cjs');
const { Store, alive } = require('../runtime/core/storage.cjs');
const { Dispatcher } = require('../runtime/core/dispatcher.cjs');
const { Desktop } = require('../runtime/core/desktop.cjs');
const { Wake } = require('../runtime/core/wake.cjs');
const { install } = require('../scripts/install.js');
const attempts = require('../runtime/core/attempts.cjs');
const exec = promisify(execFile);

const tempRoot = path.resolve('tmp');
function workdir(prefix) { fs.mkdirSync(tempRoot, { recursive: true }); return fs.mkdtempSync(path.join(tempRoot, prefix)); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

async function bridgeFixture(t, options = {}) {
  const root = workdir('qoder-direct-'), configDir = path.join(root, '.qoder-cn');
  const pluginRoot = path.join(root, 'plugin'), source = path.resolve('qoder-app-plugin/task-dispatch-bridge');
  fs.cpSync(source, pluginRoot, { recursive: true });
  const descriptorPath = descriptorFile(configDir);
  fs.writeFileSync(path.join(pluginRoot, 'bridge-config.json'), JSON.stringify({ version: 1, descriptorPath }));
  const sent = [], states = options.states || new Map();
  const chat = {
    observeTurn: async ({ sessionId }, callback) => {
      if (options.missing === sessionId) throw Error('APP_PLUGIN_SESSION_UNAVAILABLE');
      queueMicrotask(() => callback(states.get(sessionId) || { sessionId, runtimeState: 'ready', activeTurnId: null }));
      return { dispose() {} };
    },
    continueSession: async input => {
      if (options.busy) throw Error('APP_PLUGIN_TURN_REJECTED:BUSY');
      sent.push(input); return { runtimeState: 'opening' };
    }
  };
  const plugin = require(path.join(pluginRoot, 'dist/node/main.cjs'));
  await plugin.activate({ api: { chat }, subscriptions: [] });
  t.after(() => plugin.deactivate());
  // connect starts its fixture service detached; leaving it listening makes every suite run
  // accumulate live services on throwaway directories.
  const serviceRoot = path.join(root, 'data'), endpointFile = path.join(serviceRoot, 'endpoint.json');
  t.after(async () => {
    let pid; try { pid = JSON.parse(fs.readFileSync(endpointFile, 'utf8')).pid; } catch { return; }
    spawnSync(process.execPath, [path.resolve('runtime/cli.cjs'), 'stop', '--data', serviceRoot], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    for (let attempt = 0; attempt < 60 && alive(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 250));
    if (alive(pid)) throw Error('Fixture service still running: pid ' + pid);
  });
  return { root, configDir, descriptorPath, sent, adapter: new QoderWake({ descriptorPath }) };
}

test('Qoder bridge reads state and sends directly without a listener lease', async t => {
  const f = await bridgeFixture(t), workspace = path.join(f.root, 'work'); fs.mkdirSync(workspace);
  const binding = { threadId: 'qoder-session-1', workspace };
  const info = await f.adapter.read(binding);
  assert.equal(info.thread.id, binding.threadId); assert.equal(info.thread.cwd, workspace); assert.equal(info.thread.status.type, 'idle');
  assert.deepEqual(await f.adapter.send(binding, '[TASK-DISPATCH-WAKE:attempt-1] claim'), { delivered: true, runtimeState: 'opening' });
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].sessionId, binding.threadId); assert.equal(f.sent[0].requestId, 'TASK-DISPATCH-WAKE:attempt-1');
  assert.equal(fs.existsSync(path.join(f.root, 'data', 'qoder')), false);
});

test('Qoder bridge authenticates, validates sessions and exposes retryable busy', async t => {
  const f = await bridgeFixture(t, { missing: 'missing-session', busy: true });
  const workspace = path.join(f.root, 'work'); fs.mkdirSync(workspace);
  await assert.rejects(f.adapter.read({ threadId: 'bad id', workspace }), /session ID/);
  await assert.rejects(f.adapter.read({ threadId: 'missing-session', workspace }), /UNAVAILABLE/);
  await assert.rejects(f.adapter.send({ threadId: 'valid-session', workspace }, 'no marker'), /marker/);
  await assert.rejects(f.adapter.send({ threadId: 'valid-session', workspace }, '[TASK-DISPATCH-WAKE:x] wake'), error => error.safeToRetry === true);
  const descriptor = readDescriptor(f.descriptorPath); assert.ok(descriptor); assert.equal(descriptor.token.length, 64);
  assert.equal((await fetch(descriptor.baseUrl + '/v1/health')).status, 401);
});

test('Qoder prompt handshake captures one invitation and discovery validates it through the bridge', async t => {
  const f = await bridgeFixture(t), workspace = path.join(f.root, 'work'); fs.mkdirSync(workspace);
  const invitationId = crypto.randomUUID(), sessionId = 'qoder-first-connect';
  const hook = path.resolve('skills/task-dispatch/qoder-invitation-hook.cjs');
  const result = spawnSync(process.execPath, [hook, '--config-dir', f.configDir], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: workspace,
      prompt: `join [TASK-DISPATCH-INVITE:${invitationId}]` }), encoding: 'utf8', windowsHide: true
  });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), '{}');
  const adapter = new QoderWake({ configDir: f.configDir, descriptorPath: f.descriptorPath });
  assert.deepEqual(await adapter.discoverInvitation({ invitationId, workspace }), [{ id: sessionId, directory: workspace }]);
  assert.deepEqual(await adapter.discoverInvitation({ invitationId, workspace: path.dirname(workspace) }), []);
});

// [AI-added] 2026-09-21: A console rebind prompt is the only thing pasted into the new Qoder
// session, so it must carry the handshake marker the Hook reads or the rebind can never resolve.
test('managed rebind prompt carries the handshake marker the Qoder hook records', async t => {
  const f = await bridgeFixture(t), workspace = path.join(f.root, 'work'); fs.mkdirSync(workspace);
  const invitation = require('../runtime/core/invitations.cjs').buildRebindInvitation({ role: 'worker', workerId: 'qoder-rebind', workspace,
    dataRoot: path.join(f.root, 'data'), clientPath: path.resolve('runtime/desktop-client.cjs'),
    referencePath: path.resolve('skills/task-dispatch/references/connection.md'), invitationId: crypto.randomUUID(), preferredProvider: 'qoder' });
  assert.equal(invitation.provider, 'qoder');
  const hook = spawnSync(process.execPath, [path.resolve('skills/task-dispatch/qoder-invitation-hook.cjs'), '--config-dir', f.configDir], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'qoder-rebind-session', cwd: workspace, prompt: invitation.text }),
    encoding: 'utf8', windowsHide: true });
  assert.equal(hook.status, 0, hook.stderr);
  assert.deepEqual(await new QoderWake({ configDir: f.configDir, descriptorPath: f.descriptorPath })
    .discoverInvitation({ invitationId: invitation.invitationId, workspace }), [{ id: 'qoder-rebind-session', directory: workspace }]);
});

test('Qoder prompt handshake ignores ambiguous markers and expired records', async t => {
  const f = await bridgeFixture(t), workspace = path.join(f.root, 'work'); fs.mkdirSync(workspace);
  const first = crypto.randomUUID(), second = crypto.randomUUID(), hook = path.resolve('skills/task-dispatch/qoder-invitation-hook.cjs');
  spawnSync(process.execPath, [hook, '--config-dir', f.configDir], { input: JSON.stringify({ session_id:'qoder-session',cwd:workspace,
    prompt:`[TASK-DISPATCH-INVITE:${first}] [TASK-DISPATCH-INVITE:${second}]` }), encoding:'utf8',windowsHide:true });
  assert.equal(fs.existsSync(path.join(f.configDir,'task-dispatch-invitations',first+'.json')),false);
  const dir=path.join(f.configDir,'task-dispatch-invitations');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,first+'.json'),JSON.stringify({version:1,invitationId:first,sessionId:'qoder-session',workspace,createdAt:'2000-01-01T00:00:00.000Z'}));
  assert.deepEqual(await new QoderWake({configDir:f.configDir,descriptorPath:f.descriptorPath}).discoverInvitation({invitationId:first,workspace}),[]);
});

test('Qoder first connect resolves the invitation without a manual session ID', async t => {
  const f = await bridgeFixture(t), workspace = path.join(f.root, 'work'), dataRoot = path.join(f.root, 'data'); fs.mkdirSync(workspace);
  const invitationId = crypto.randomUUID(), sessionId = 'qoder-invited-worker';
  spawnSync(process.execPath, [path.resolve('skills/task-dispatch/qoder-invitation-hook.cjs'), '--config-dir', f.configDir], {
    input: JSON.stringify({ session_id:sessionId,cwd:workspace,prompt:`[TASK-DISPATCH-INVITE:${invitationId}]` }),encoding:'utf8',windowsHide:true
  });
  const {stdout}=await exec(process.execPath,[path.resolve('runtime/desktop-client.cjs'),'connect','--provider','qoder','--invitation-id',invitationId,
    '--role','worker','--worker-id','qoder-first','--workspace',workspace,'--data',dataRoot],{
    cwd:workspace,windowsHide:true,env:{...process.env,QODER_CONFIG_DIR:f.configDir}
  });
  const result=JSON.parse(stdout);assert.equal(result.attached,true);assert.equal(result.role,'worker');assert.equal(result.parked,true);
});

test('Qoder state mapping keeps active work from receiving a competing wake', () => {
  assert.equal(runtimeState('ready'), 'idle'); assert.equal(runtimeState('running'), 'active');
  assert.equal(runtimeState('needs_attention'), 'active'); assert.equal(runtimeState('new-state'), 'unknown');
});

test('installed bridge without a runtime descriptor asks for a Qoder restart', async () => {
  const root = workdir('qoder-not-loaded-'), configDir = path.join(root, '.qoder-cn');
  const pluginRoot = path.join(configDir, 'app', 'dev-extensions', 'task-dispatch-bridge');
  fs.mkdirSync(path.join(pluginRoot, '.qoder-app-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'dist', 'node'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.qoder-app-plugin', 'plugin.json'), '{}');
  fs.writeFileSync(path.join(pluginRoot, 'dist', 'node', 'main.cjs'), '');
  assert.equal(pluginInstalled(configDir), true);
  await assert.rejects(new QoderWake({ configDir, descriptorPath: descriptorFile(configDir), probeQoder: () => { throw Error('probe failed'); } }).bridge(), /installed but not running; start or restart Qoder/);
});

function qoderDownFixture(t, { qoderRunning, descriptor }) {
  const root = workdir('qoder-repair-'), configDir = path.join(root, '.qoder-cn');
  const pluginRoot = path.join(configDir, 'app', 'dev-extensions', 'task-dispatch-bridge');
  fs.mkdirSync(path.join(pluginRoot, '.qoder-app-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'dist', 'node'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.qoder-app-plugin', 'plugin.json'), '{}');
  fs.writeFileSync(path.join(pluginRoot, 'dist', 'node', 'main.cjs'), '');
  const descriptorPath = descriptorFile(configDir);
  if (descriptor) fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
  const restarts = [];
  let clock = 1000;
  const adapter = new QoderWake({
    configDir, descriptorPath, env: {},
    probeQoder: async () => qoderRunning ? [{ Id: 1, ProcessName: 'Qoder CN', Path: '' }] : [],
    restartApp: async opts => { restarts.push(opts); return { attempted: true, action: opts.kill ? 'restart' : 'launch', exe: 'C:\\Fake\\Qoder CN.exe', killed: opts.kill ? 2 : 0 }; },
    now: () => clock,
  });
  return { root, descriptorPath, adapter, restarts, advance: ms => clock += ms };
}

test('Qoder repair starts the app when it is stopped', async t => {
  const f = qoderDownFixture(t, { qoderRunning: false });
  const error = await f.adapter.bridge().then(() => null, e => e);
  assert.equal(error.repairAction, 'launch');
  assert.match(error.message, /Qoder is not running; start Qoder/);
  const result = await f.adapter.repairBridge(error);
  assert.equal(result.action, 'launch');
  assert.equal(f.restarts.length, 1); assert.equal(f.restarts[0].kill, false);
  assert.ok(Array.isArray(f.restarts[0].candidates));
});

test('Qoder restarts a loaded-app-but-dead-bridge state and names the stale descriptor pid', async t => {
  const f = qoderDownFixture(t, { qoderRunning: true, descriptor: { version: 1, baseUrl: 'http://127.0.0.1:1', token: 'a'.repeat(64), pid: 999999 } });
  const error = await f.adapter.bridge().then(() => null, e => e);
  assert.equal(error.repairAction, 'restart');
  assert.match(error.message, /App Plugin bridge is not loaded \(previous bridge pid 999999 exited\)/);
  assert.equal((await f.adapter.repairBridge(error)).action, "restart");
  assert.equal(f.restarts[0].kill, true);
  // Rate limit: a second repair inside the interval declines; it resumes after 10 minutes.
  assert.equal((await f.adapter.repairBridge(error)).reason, 'rate-limited');
  f.advance(11 * 60_000);
  assert.equal((await f.adapter.repairBridge(error)).attempted, true);
  assert.equal(f.restarts.length, 2);
});

test('Qoder repair disables itself after repeated launch failures', async t => {
  const f = qoderDownFixture(t, { qoderRunning: false });
  f.adapter.restartApp = async () => ({ attempted: false, reason: 'executable-not-found' });
  const error = await f.adapter.bridge().then(() => null, e => e);
  for (let i = 0; i < 3; i++) {
    await f.adapter.repairBridge(error);
    f.advance(11 * 60_000);
  }
  assert.equal((await f.adapter.repairBridge(error)).reason, 'disabled-after-repeated-failures');
});

test('legacy Qoder bindings acquire their project workspace without resume', () => {
  const state = { projects: { p: { workspace: 'D:\\work', bindings: { reviewer: { wake: { provider: 'qoder', threadId: 'old-session' } } }, tasks: {} } } };
  attempts.migrate(state);
  assert.equal(state.projects.p.bindings.reviewer.wake.workspace, 'D:\\work');
});

// [AI-added] 2026-09-16 16:43
test('legacy Qoder hook refuses to guess a workspace when no data root is explicit', () => {
  const root = workdir('qoder-hook-root-'), skill = path.join(root, 'skill');
  fs.mkdirSync(skill);
  fs.copyFileSync(path.resolve('skills/task-dispatch/qoder-hook.cjs'), path.join(skill, 'qoder-hook.cjs'));
  fs.writeFileSync(path.join(skill, 'runtime-link.json'), JSON.stringify({
    version: 2,
    client: path.resolve('runtime/desktop-client.cjs'),
    dataMode: 'workspace-sibling-v1'
  }));
  const result = spawnSync(process.execPath, [path.join(skill, 'qoder-hook.cjs'), 'stop'], {
    cwd: root,
    input: JSON.stringify({ hook_event_name: 'Stop' }),
    encoding: 'utf8',
    env: { ...process.env, TASK_DISPATCH_DATA: '' },
    windowsHide: true
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /workspace is missing; provide host workspace metadata or --data/);
  assert.equal(fs.readdirSync(root).some(entry => entry.endsWith('.task-dispatch-service')), false);
});

test('task dispatch delivers to Qoder after park without hook state', async t => {
  const f = await bridgeFixture(t), workspace = path.join(f.root, 'work'); fs.mkdirSync(workspace);
  const dataRoot = path.join(f.root, 'data'), store = new Store(dataRoot); t.after(() => store.close());
  const dispatcher = new Dispatcher(store, { enableRealCalls: false }, () => { throw Error('no model'); });
  const desktop = new Desktop(dispatcher), sessionId = 'qoder-session-worker';
  desktop.attach({ workspace, role: 'worker', clientId: 'worker-client', token: 'a'.repeat(64), sessionId });
  store.change(state => { for (const project of Object.values(state.projects)) project.startup = { state: 'started' }; });
  const identity = desktop.authenticate('a'.repeat(64));
  const wake = new Wake(desktop, { forProvider: provider => { assert.equal(provider, 'qoder'); return f.adapter; } });
  await wake.bind(identity, { provider: 'qoder', threadId: sessionId, experimentalAcknowledged: true });
  assert.equal(wake.park(identity).parked, true);
  dispatcher.addTask(identity.projectId, { id: 'T', title: 't', instructions: 'i', acceptance: 'a', allowedPaths: ['README.md'] });
  require('./stage-fixture.cjs').begin(dispatcher);
  dispatcher.tick(); await wake.run();
  const attempt = store.state.projects[identity.projectId].tasks.T.attempts.at(-1);
  assert.equal(attempt.wakeNotice.status, 'sent'); assert.equal(f.sent.length, 1); assert.match(f.sent[0].prompt, new RegExp(attempt.id));
});

test('Qoder installer writes direct bridge and removes recorded legacy hooks', () => {
  const root = workdir('qoder-install-'), home = path.join(root, 'home'), configDir = path.join(home, '.qoder');
  const skill = path.join(configDir, 'skills/task-dispatch'), hookFile = path.join(skill, 'qoder-hook.cjs');
  fs.mkdirSync(skill, { recursive: true });
  const hook = Buffer.from('legacy hook'); fs.writeFileSync(hookFile, hook);
  const handler = { type: 'command', command: 'node', args: [hookFile, 'stop'], name: 'task-dispatch-qoder-stop', timeout: 660, asyncRewake: true };
  const settingsFile = path.join(configDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [handler] }] } }, null, 2) + '\n');
  fs.writeFileSync(path.join(skill, '.task-dispatch-install.json'), JSON.stringify({ name: 'task-dispatch', version: '0.6.0', hashes: { 'qoder-hook.cjs': digest(hook) }, hooks: { file: settingsFile, entries: { [handler.name]: digest(JSON.stringify(handler)) } } }));
  install({ platforms: ['qoder'], home });
  assert.equal(fs.existsSync(hookFile), false);
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(settings.theme, 'dark'); assert.equal(settings.hooks.Stop, undefined);
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].name, 'task-dispatch-qoder-invitation');
  const bridge = path.join(configDir, 'app/dev-extensions/task-dispatch-bridge');
  assert.ok(fs.existsSync(path.join(bridge, '.qoder-app-plugin/plugin.json'))); assert.ok(fs.existsSync(path.join(bridge, 'dist/node/main.cjs')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(bridge, 'bridge-config.json'), 'utf8')).descriptorPath, descriptorFile(configDir));
  assert.ok(install({ platforms: ['qoder'], home }).every(plan => plan.writes.length === 0 && plan.deletes.length === 0));
});

test('Qoder installer preserves foreign hooks and installs CN bridge separately', () => {
  const root = workdir('qoder-cn-install-'), home = path.join(root, 'home'), settingsDir = path.join(home, '.qoder-cn');
  fs.mkdirSync(settingsDir, { recursive: true });
  const foreign = { type: 'command', command: 'node', args: ['mine.cjs'], name: 'mine' };
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [foreign] }] } }));
  install({ platforms: ['qodercn'], home });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8')).hooks.Stop[0].hooks, [foreign]);
  assert.ok(fs.existsSync(path.join(settingsDir, 'app/dev-extensions/task-dispatch-bridge/dist/node/main.cjs')));
  assert.equal(fs.existsSync(path.join(settingsDir, 'skills/task-dispatch/qoder-hook.cjs')), false);
});
