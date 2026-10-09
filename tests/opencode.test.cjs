'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {OpenCodeWake, findOpenCodeCli, runOpenCodeCli} = require('../runtime/adapters/opencode-wake.cjs');

function fixture(t) {
  const base = path.resolve(__dirname, '../tmp'); fs.mkdirSync(base, {recursive: true});
  const root = fs.mkdtempSync(path.join(base, 'opencode-')), dbPath = path.join(root, 'opencode.db');
  const workspace = path.join(root, 'work'); fs.mkdirSync(workspace);
  const threadId = 'ses_fixture0001';
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, agent TEXT, time_archived INTEGER, time_idle INTEGER, idle_outcome TEXT);
    CREATE TABLE session_message (session_id TEXT, seq INTEGER, type TEXT, data TEXT);
    CREATE TABLE session_inbox (session_id TEXT, payload TEXT);
    CREATE TABLE session_pending (session_id TEXT, data TEXT);
    CREATE TABLE session (id TEXT, directory TEXT);`);
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, NULL, 1, ?)').run(threadId, workspace, 'build', 'succeeded');
  db.prepare('INSERT INTO session VALUES (?, ?)').run(threadId, 'wrong-legacy-workspace');
  db.prepare('INSERT INTO session_message VALUES (?, 1, ?, ?)').run(threadId, 'idle', '{}');
  db.close();
  const mutate = callback => {const writer = new DatabaseSync(dbPath); try {callback(writer);} finally {writer.close();}};
  const add = (type, data = {}, id = threadId) => mutate(writer => {
    const seq = writer.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_message WHERE session_id = ?').get(id).seq;
    writer.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?)').run(id, seq, type, JSON.stringify(data));
  });
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const binding = {provider: 'opencode', threadId, workspace};
  const adapter = new OpenCodeWake({dbPath, cliPath: process.execPath, env: {}, pollMs: 1, confirmTimeoutMs: 25});
  return {root, dbPath, workspace, threadId, mutate, add, binding, adapter};
}
const marker = 'TASK-DISPATCH-WAKE:fixture-attempt';
const message = `[${marker}] 请领取本角色任务。`;

test('OpenCode verifies the exact v2 session read-only, rejecting missing, archived and legacy sessions', async t => {
  const f = fixture(t), before = fs.readFileSync(f.dbPath);
  const info = await f.adapter.verify(f.binding);
  assert.equal(info.thread.id, f.threadId); assert.equal(info.thread.cwd, f.workspace);
  assert.equal(info.thread.status.type, 'idle');
  assert.deepEqual(fs.readFileSync(f.dbPath), before);
  await assert.rejects(f.adapter.read({...f.binding, threadId: 'ses_missing0001'}), /does not exist/);
  await assert.rejects(f.adapter.read({...f.binding, threadId: 'wrong'}), /real ses_/);
  f.mutate(db => db.prepare('UPDATE session_v2 SET time_archived = 10 WHERE id = ?').run(f.threadId));
  await assert.rejects(f.adapter.read(f.binding), /archived/);
  f.mutate(db => db.exec('DROP TABLE session_v2'));
  await assert.rejects(f.adapter.read(f.binding), /2.x session tables/);
});

test('OpenCode does not create a missing database or bind without a usable CLI', async t => {
  const f = fixture(t), missing = path.join(f.root, 'missing.db');
  await assert.rejects(new OpenCodeWake({dbPath: missing}).read(f.binding), /database unavailable/);
  assert.equal(fs.existsSync(missing), false);
  f.adapter.cliPath = path.join(f.root, 'missing-cli');
  await assert.rejects(f.adapter.verify(f.binding), /CLI unavailable/);
});

test('OpenCode treats active events, pending queues and unknown queue schemas conservatively', async t => {
  const f = fixture(t);
  f.add('user', {text: '当前回合仍在执行'});
  assert.equal((await f.adapter.read(f.binding)).thread.status.type, 'active');
  await assert.rejects(f.adapter.send(f.binding, message), error => error.safeToRetry === true && /not idle/.test(error.message));
  f.add('idle');
  for (const table of ['session_inbox', 'session_pending']) {
    f.mutate(db => db.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run(f.threadId, '{}'));
    assert.equal((await f.adapter.read(f.binding)).thread.status.type, 'active');
    f.mutate(db => db.exec(`DELETE FROM ${table}`));
  }
  f.mutate(db => db.exec('DROP TABLE session_inbox; CREATE TABLE session_inbox (payload TEXT)'));
  assert.equal((await f.adapter.read(f.binding)).thread.status.type, 'unknown');
  await assert.rejects(f.adapter.send(f.binding, message), /not idle/);
});

test('OpenCode delivery requires an exact user marker and deduplicates recovered notifications', async t => {
  const f = fixture(t); let calls = 0;
  f.adapter.runCli = (file, args, options) => {
    calls++; assert.equal(file, process.execPath);
    assert.deepEqual(args, ['run', '--session', f.threadId, '--format', 'json', message]);
    assert.equal(options.cwd, f.workspace);
    f.add('user', {text: message});
    return {done: Promise.resolve({code: 1})};
  };
  const receipt = await f.adapter.send(f.binding, message);
  assert.equal(receipt.delivered, true); assert.equal(receipt.turnEnded, false);
  f.add('idle');
  assert.equal((await f.adapter.send(f.binding, message)).delivered, true);
  assert.equal(calls, 1);
});

test('OpenCode confirms delivery while the CLI is still generating and blocks concurrent turns', async t => {
  const f = fixture(t); let finish;
  f.adapter.runCli = () => {f.add('user', {text: message}); return {done: new Promise(resolve => {finish = resolve;})};};
  assert.equal((await f.adapter.send(f.binding, message)).delivered, true);
  f.add('idle');
  await assert.rejects(f.adapter.send(f.binding, '[TASK-DISPATCH-PLANNING:second] 收尾'), /not idle/);
  finish({code: 0}); await f.adapter.running.get(f.threadId);
  assert.equal(f.adapter.running.size, 0);
});

test('OpenCode zero exit status, assistant echoes, other sessions and marker prefixes are not delivery proof', async t => {
  const f = fixture(t);
  f.adapter.runCli = () => {
    f.add('assistant', {text: message});
    f.add('user', {text: message}, 'ses_other0001');
    f.add('user', {text: `[${marker}-other]`});
    f.add('idle');
    return {done: Promise.resolve({code: 0})};
  };
  await assert.rejects(f.adapter.send(f.binding, message), error => !error.safeToRetry && /delivery uncertain/.test(error.message));
});

test('OpenCode retries only definite startup failure and never sends to a different workspace or self', async t => {
  const f = fixture(t); let calls = 0;
  f.adapter.runCli = () => {calls++; return {done: Promise.resolve({spawnError: 'ENOENT'})};};
  await assert.rejects(f.adapter.send(f.binding, message), error => error.safeToRetry === true);
  assert.equal(calls, 1);
  await assert.rejects(f.adapter.send({...f.binding, threadId: 'ses_absent0001'}, message), /does not exist/);
  await assert.rejects(f.adapter.send({...f.binding, workspace: f.root}, message), /workspace changed/);
  await assert.rejects(f.adapter.send({...f.binding, canSend: () => false}, message), error => error.safeToRetry === true);
  f.adapter.sourceSession = f.threadId;
  await assert.rejects(f.adapter.send(f.binding, message), /self-wake/);
  assert.equal(calls, 1);
});

test('OpenCode preserves model and permissions unless explicitly configured', async t => {
  const f = fixture(t);
  await assert.rejects(f.adapter.send({...f.binding, model: 'invalid'}, message), /provider\/model/);
  f.adapter.env = {TASK_DISPATCH_OPENCODE_AUTO: '1'};
  f.adapter.runCli = (file, args) => {
    assert.deepEqual(args, ['run', '--session', f.threadId, '--format', 'json', '--auto', '--model', 'fixture/model', message]);
    f.add('user', {text: message}); return {done: Promise.resolve({code: 0})};
  };
  assert.equal((await f.adapter.send({...f.binding, model: 'fixture/model'}, message)).delivered, true);
});

test('OpenCode dispatcher rechecks pause, revocation and claim after the final host read', async t => {
  const f = fixture(t), {Wake} = require('../runtime/core/wake.cjs');
  const binding = {armed: true, wake: f.binding};
  const attempt = {id: 'fixture-attempt', role: 'worker', delivery: {}, settled: false};
  const project = {workspace: f.workspace, bindings: {worker: binding}, tasks: {T: {attempts: [attempt]}}};
  const store = {state: {projects: {p: project}}};
  const wake = new Wake({store}, f.adapter), read = f.adapter.read.bind(f.adapter);
  let calls = 0; f.adapter.runCli = () => {calls++; throw Error('must not launch');};
  for (const revoke of [() => {project.paused = true;}, () => {binding.armed = false;}, () => {attempt.claimedBy = 'worker';}]) {
    project.paused = false; binding.armed = true; delete attempt.claimedBy;
    f.adapter.read = async value => {const info = await read(value); revoke(); return info;};
    await assert.rejects(wake.send(f.adapter, f.binding, message), error => error.safeToRetry === true && /changed before delivery/.test(error.message));
  }
  assert.equal(calls, 0);
});

test('OpenCode task notification uses persistent wake receipts and is reconciled without a second CLI turn', async t => {
  const f = fixture(t), {Store} = require('../runtime/core/storage.cjs');
  const {Dispatcher} = require('../runtime/core/dispatcher.cjs'), {Desktop} = require('../runtime/core/desktop.cjs'), {Wake} = require('../runtime/core/wake.cjs');
  const store = new Store(path.join(f.root, 'data')); t.after(() => store.close());
  const d = new Dispatcher(store, {enableRealCalls: false}, () => {throw Error('no model');});
  const desktop = new Desktop(d);
  desktop.attach({workspace: f.workspace, role: 'worker', clientId: 'worker123', token: 'a'.repeat(64), sessionId: f.threadId});
  store.change(s => {for (const p of Object.values(s.projects)) p.startup = {state: 'started'};});
  const identity = desktop.authenticate('a'.repeat(64));
  const wake = new Wake(desktop, {forProvider: provider => {assert.equal(provider, 'opencode'); return f.adapter;}});
  await assert.rejects(wake.bind(identity, {...f.binding, model: 'invalid', experimentalAcknowledged: true}), /provider\/model/);
  await wake.bind(identity, {...f.binding, experimentalAcknowledged: true});
  assert.equal(wake.park(identity).parked, true);
  d.addTask(identity.projectId, {id: 'T', title: 'T', instructions: 'i', acceptance: 'a', allowedPaths: ['result.txt']});
  require('./stage-fixture.cjs').begin(d); d.tick();
  let calls = 0;
  f.adapter.runCli = (file, args) => {calls++; f.add('user', {text: args.at(-1)}); return {done: Promise.resolve({code: 0})};};
  await wake.run();
  const run = () => store.state.projects[identity.projectId].tasks.T.attempts.at(-1);
  assert.equal(run().wakeNotice.status, 'sent'); assert.equal(calls, 1);
  store.change(s => {s.projects[identity.projectId].tasks.T.attempts.at(-1).wakeNotice.status = 'sending';});
  const restarted = new Wake(desktop, wake.adapter); await restarted.run();
  assert.equal(run().wakeNotice.status, 'sent'); assert.equal(calls, 1);
  assert.equal(desktop.claim(identity).taskId, 'T');
  assert.equal(store.state.projects[identity.projectId].bindings.worker.armed, false);
  await Promise.all([...d.active.values()].map(a => a.promise));
});

test('OpenCode discovers Desktop 2.x CLI versions numerically and respects explicit paths', t => {
  const f = fixture(t), name = process.platform === 'win32' ? 'opencode-cli.exe' : 'opencode-cli';
  for (const version of ['2.0.9', '2.0.24', '1.99.99']) {
    const dir = path.join(f.root, 'ai.opencode.desktop', 'cli', version);
    fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync(path.join(dir, name), '');
  }
  const env = {APPDATA: f.root, PATH: ''};
  assert.equal(findOpenCodeCli(env), path.join(f.root, 'ai.opencode.desktop', 'cli', '2.0.24', name));
  assert.equal(findOpenCodeCli({...env, TASK_DISPATCH_OPENCODE_CLI: process.execPath}), process.execPath);
  assert.throws(() => findOpenCodeCli({...env, TASK_DISPATCH_OPENCODE_CLI: f.root}), /executable file/);
  fs.writeFileSync(path.join(f.root, 'opencode.cmd'), '@exit');
  if (process.platform === 'win32') assert.throws(() => findOpenCodeCli({...env, TASK_DISPATCH_OPENCODE_CLI: path.join(f.root, 'opencode.cmd')}), /shell wrapper/);
  assert.throws(() => findOpenCodeCli({APPDATA: f.workspace, PATH: ''}), /CLI unavailable/);
});

test('OpenCode CLI transport passes literal argv without a shell', async t => {
  const f = fixture(t), sentinel = path.join(f.root, 'literal.json');
  const literal = '中文 & $() "引号"';
  const {done} = runOpenCodeCli(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv[2]))', sentinel, literal], {cwd: f.workspace});
  const keepAlive = setInterval(() => {}, 1000);
  try {assert.equal((await done).code, 0); assert.equal(JSON.parse(fs.readFileSync(sentinel, 'utf8')), literal);}
  finally {clearInterval(keepAlive);}
});

test('real CLI connects OpenCode brain, reviewer and worker, then resumes the verified original sessions', async t => {
  const f = fixture(t), {initialize} = require('../runtime/wizard.cjs'), {serve} = require('../runtime/server.cjs');
  const {WakeProviders} = require('../runtime/adapters/mimo-wake.cjs');
  const execFile = require('node:util').promisify(require('node:child_process').execFile);
  const data = path.join(f.root, 'data'); initialize(data);
  const providers = new WakeProviders({opencode: {dbPath: f.dbPath, cliPath: process.execPath, env: {}}});
  providers.forProvider('opencode').runCli = () => {throw Error('No real model turn is authorized by this test');};
  const server = await serve(data, {wakeAdapter: providers});
  const cli = path.resolve(__dirname, '../runtime/desktop-client.cjs');
  const run = async args => JSON.parse((await execFile(process.execPath, [cli, ...args, '--data', data], {cwd: f.workspace, windowsHide: true, env: {...process.env, CODEX_THREAD_ID: 'different-codex-session'}})).stdout);
  try {
    for (const role of ['brain', 'reviewer', 'worker']) {
      const session = `ses_${role}0001`;
      f.mutate(db => db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, NULL, 1, ?)').run(session, f.workspace, 'build', 'succeeded'));
      f.add('idle', {}, session);
      const connected = await run(['connect', '--provider', 'opencode', '--role', role, '--session-id', session]);
      assert.equal(connected.continuation.mode, 'wake'); assert.equal(connected.continuation.provider, 'opencode');
      assert.equal(connected.parked, true);
      const credential = JSON.parse(fs.readFileSync(connected.credential, 'utf8'));
      assert.equal(credential.sessionId, session);
      assert.equal(server.store.state.projects[connected.projectId].bindings[role].wake.workspace, f.workspace);
      if (role === 'brain') assert.ok(connected.reviewerInvite.platformOptions.includes('opencode'));
      assert.equal((await run(['resume', '--credential', connected.credential])).parked, true);
    }
    const missing = await run(['connect', '--provider', 'opencode', '--role', 'worker', '--worker-id', 'missing', '--session-id', 'ses_absent0001']);
    assert.equal(missing.continuation.mode, 'attention'); assert.equal(missing.nextAction, 'attention');
    assert.equal(missing.parked, undefined);
  } finally {await server.close();}
});
