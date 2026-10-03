'use strict';
// [AI-added] 2026-09-20: Wake repair coverage — restartable host failures trigger the
// adapter's start/restart repair, and the wake loop records it as an event plus operator text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Store, atomic } = require('../runtime/core/storage.cjs');
const { Dispatcher } = require('../runtime/core/dispatcher.cjs');
const { Desktop } = require('../runtime/core/desktop.cjs');
const { Wake } = require('../runtime/core/wake.cjs');
const { MimoWake } = require('../runtime/adapters/mimo-wake.cjs');

function mimoFixture(t, discovery) {
  // Long paths only: os.tmpdir() is 8.3-short on some Windows hosts and fs.existsSync
  // silently fails on those, which would fake an executable-not-found here.
  const base = path.resolve(__dirname, '../tmp'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'mimo-repair-'));
  const file = path.join(root, 'mimo.json');
  if (discovery) atomic(file, discovery);
  const restarts = [];
  let clock = 1000;
  const adapter = new MimoWake({
    credentialFile: file, env: {}, fetchImpl: async () => { throw Object.assign(Error('connect refused'), { name: 'Error', cause: { code: 'ECONNREFUSED' } }); },
    restartApp: async opts => { restarts.push(opts); return { attempted: true, action: opts.kill ? 'restart' : 'launch', exe: 'C:\\Fake\\Xiaomi MiMo.exe', killed: opts.kill ? 3 : 0 }; },
    now: () => clock,
  });
  return { root, file, adapter, restarts, advance: ms => clock += ms };
}

test('MiMo launch-only repair when the recorded Desktop pid is gone', async t => {
  const f = mimoFixture(t, { api: 1, port: 1234, token: 'a'.repeat(64), pid: 99999999 });
  const result = await f.adapter.repairBridge();
  assert.equal(result.action, 'launch'); assert.equal(result.attempted, true);
  assert.equal(f.restarts.length, 1); assert.equal(f.restarts[0].kill, false);
});

test('MiMo restart repair is refused while any session is active', async t => {
  const f = mimoFixture(t, { api: 1, port: 1234, token: 'a'.repeat(64), pid: process.pid });
  f.adapter.sessions = async () => [{ id: 's1', directory: f.root, status: 'busy' }];
  assert.equal((await f.adapter.repairBridge()).reason, 'session-active');
  assert.equal(f.restarts.length, 0);
});

test('MiMo restarts only a provably idle app; an unreachable app is never killed automatically', async t => {
  const f = mimoFixture(t, { api: 1, port: 1234, token: 'a'.repeat(64), pid: process.pid });
  assert.equal((await f.adapter.repairBridge()).reason, 'status-unknown', 'hung API must not force-kill');
  f.adapter.sessions = async () => [{ id: 's1', directory: f.root, status: 'idle' }];
  const result = await f.adapter.repairBridge();
  assert.equal(result.action, 'restart'); assert.equal(f.restarts[0].kill, true);
});

test('MiMo repair rate limits and disables after repeated failures', async t => {
  const f = mimoFixture(t, { api: 1, port: 1234, token: 'a'.repeat(64), pid: 99999999 });
  f.adapter.restartApp = async () => ({ attempted: false, reason: 'executable-not-found' });
  for (let i = 0; i < 3; i++) { await f.adapter.repairBridge(); f.advance(11 * 60_000); }
  assert.equal((await f.adapter.repairBridge()).reason, 'disabled-after-repeated-failures');
  const ok = mimoFixture(t, { api: 1, port: 1234, token: 'a'.repeat(64), pid: 99999999 });
  await ok.adapter.repairBridge();
  assert.equal((await ok.adapter.repairBridge()).reason, 'rate-limited');
});

test('MiMo transport refusal is restartable but a timeout is not', async t => {
  const f = mimoFixture(t, { api: 1, port: 1234, token: 'a'.repeat(64), pid: 1 });
  await assert.rejects(f.adapter.json('sessions'), e => e.restartable === true && /unreachable/i.test(e.message));
  f.adapter.fetch = async () => { const e = Error('aborted'); e.name = 'AbortError'; throw e; };
  await assert.rejects(f.adapter.json('sessions'), e => e.restartable === undefined);
});

function wakeLoopFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-repair-test-')), workspace = path.join(root, 'work');
  fs.mkdirSync(workspace);
  const store = new Store(path.join(root, 'data')); t.after(() => store.close());
  const d = new Dispatcher(store, { enableRealCalls: false }, () => { throw Error('no model'); });
  const desktop = new Desktop(d);
  desktop.attach({ workspace, role: 'worker', clientId: 'worker123', token: 'a'.repeat(64) });
  store.change(s => { for (const p of Object.values(s.projects)) p.startup = { state: 'started' }; });
  const identity = desktop.authenticate('a'.repeat(64));
  const repairs = [];
  const adapter = {
    read: async () => ({ thread: { id: 'test-thread', cwd: workspace, status: { type: 'idle' } }, turns: [] }),
    send: async () => ({}),
    repairBridge: async error => { repairs.push(error); return { attempted: true, action: 'restart', exe: 'C:\\Fake\\App.exe', killed: 1 }; },
  };
  const wake = new Wake(desktop, adapter);
  return { store, d, desktop, identity, wake, adapter, repairs, workspace };
}

test('wake loop repairs a restartable host failure, records the event and the operator note', async t => {
  const x = wakeLoopFixture(t);
  await x.wake.bind(x.identity, { provider: 'codex', threadId: 'test-thread', turnId: 'old-turn', experimentalAcknowledged: true });
  x.wake.park(x.identity);
  x.d.addTask(x.identity.projectId, { id: 'T', title: 't', instructions: 'i', acceptance: 'a', allowedPaths: ['README.md'] });
  require('./stage-fixture.cjs').begin(x.d);
  x.d.tick();
  const failure = Error('app plugin bridge is not loaded'); failure.repairAction = 'restart'; failure.restartable = true;
  x.adapter.read = async () => { throw failure; };
  await x.wake.run();
  const attempt = x.store.state.projects[x.identity.projectId].tasks.T.attempts.at(-1);
  assert.match(attempt.wakeNotice.error, /app plugin bridge is not loaded/);
  assert.match(attempt.wakeNotice.error, /服务已自动重启宿主应用/);
  assert.deepEqual(x.repairs, [failure]);
  assert.ok(x.store.state.events.some(e => e.type === 'wake_repair' && e.taskId === 'T' && e.attempted === true && e.outcome === 'restart'));
  // A second tick re-reads the host; repairBridge stays callable (the adapter owns rate limiting).
  await x.wake.run();
  assert.equal(x.repairs.length, 2);
});

test('wake loop ignores non-restartable failures and adapters without repair', async t => {
  const x = wakeLoopFixture(t);
  await x.wake.bind(x.identity, { provider: 'codex', threadId: 'test-thread', turnId: 'old-turn', experimentalAcknowledged: true });
  x.wake.park(x.identity);
  x.d.addTask(x.identity.projectId, { id: 'T', title: 't', instructions: 'i', acceptance: 'a', allowedPaths: ['README.md'] });
  require('./stage-fixture.cjs').begin(x.d);
  x.d.tick();
  x.adapter.read = async () => { throw Error('host read timed out'); };
  await x.wake.run();
  assert.equal(x.repairs.length, 0);
  assert.match(x.store.state.projects[x.identity.projectId].tasks.T.attempts.at(-1).wakeNotice.error, /timed out/);
  assert.equal(x.store.state.events.some(e => e.type === 'wake_repair'), false);
  const plain = new Wake(x.desktop, { read: x.adapter.read, send: async () => ({}) });
  assert.equal(await plain.repair({ read: () => ({}) }, Error('x'), {}), null);
});

// [AI-added] 2026-09-21 23:41: A successful repair must reopen the marker-safe retry path.
test('wake send retries on the next tick after a completed host repair', async t => {
  const x = wakeLoopFixture(t);
  await x.wake.bind(x.identity, { provider: 'codex', threadId: 'test-thread', turnId: 'old-turn', experimentalAcknowledged: true });
  x.wake.park(x.identity);
  x.d.addTask(x.identity.projectId, { id: 'T', title: 't', instructions: 'i', acceptance: 'a', allowedPaths: ['README.md'] });
  require('./stage-fixture.cjs').begin(x.d);
  x.d.tick();
  let sends = 0;
  x.adapter.send = async () => {
    sends++;
    if (sends === 1) { const error = Error('connection reset'); error.restartable = true; throw error; }
    return { delivered: true };
  };
  await x.wake.run();
  let attempt = x.store.state.projects[x.identity.projectId].tasks.T.attempts.at(-1);
  assert.equal(attempt.wakeNotice.status, 'pending');
  assert.match(attempt.wakeNotice.error, /等待唤醒自动重试/);
  assert.equal(sends, 1);
  await x.wake.run();
  attempt = x.store.state.projects[x.identity.projectId].tasks.T.attempts.at(-1);
  assert.equal(attempt.wakeNotice.status, 'sent');
  assert.equal(attempt.wakeNotice.error, null);
  assert.equal(sends, 2);
});

// [AI-added] 2026-09-21 23:41: Keep conservative delivery semantics when repair did not run,
// and reconcile an already-present marker before attempting the repaired send again.
test('wake send keeps unperformed repair uncertain and deduplicates a repaired retry by marker', async t => {
  const uncertain = wakeLoopFixture(t);
  await uncertain.wake.bind(uncertain.identity, { provider: 'codex', threadId: 'test-thread', turnId: 'old-turn', experimentalAcknowledged: true });
  uncertain.wake.park(uncertain.identity);
  uncertain.d.addTask(uncertain.identity.projectId, { id: 'T', title: 't', instructions: 'i', acceptance: 'a', allowedPaths: ['README.md'] });
  require('./stage-fixture.cjs').begin(uncertain.d);
  uncertain.d.tick();
  uncertain.adapter.repairBridge = async () => ({ attempted: false, reason: 'status-unknown' });
  uncertain.adapter.send = async () => { const error = Error('connection reset'); error.restartable = true; throw error; };
  await uncertain.wake.run();
  assert.equal(uncertain.store.state.projects[uncertain.identity.projectId].tasks.T.attempts.at(-1).wakeNotice.status, 'uncertain');

  const dedupe = wakeLoopFixture(t);
  await dedupe.wake.bind(dedupe.identity, { provider: 'codex', threadId: 'test-thread', turnId: 'old-turn', experimentalAcknowledged: true });
  dedupe.wake.park(dedupe.identity);
  dedupe.d.addTask(dedupe.identity.projectId, { id: 'T', title: 't', instructions: 'i', acceptance: 'a', allowedPaths: ['README.md'] });
  require('./stage-fixture.cjs').begin(dedupe.d);
  dedupe.d.tick();
  let sends = 0, marker = '';
  dedupe.adapter.send = async (_binding, message) => {
    sends++; marker = /TASK-DISPATCH-WAKE:[0-9a-f-]+/.exec(message)?.[0] || '';
    const error = Error('connection reset'); error.restartable = true; throw error;
  };
  await dedupe.wake.run();
  assert.equal(dedupe.store.state.projects[dedupe.identity.projectId].tasks.T.attempts.at(-1).wakeNotice.status, 'pending');
  dedupe.adapter.read = async () => ({ thread: { id: 'test-thread', cwd: dedupe.workspace, status: { type: 'idle' } }, turns: [{ items: [{ type: 'userMessage', content: [{ text: `[${marker}] delivered before disconnect` }] }] }] });
  await dedupe.wake.run();
  assert.equal(dedupe.store.state.projects[dedupe.identity.projectId].tasks.T.attempts.at(-1).wakeNotice.status, 'sent');
  assert.equal(sends, 1);
});
