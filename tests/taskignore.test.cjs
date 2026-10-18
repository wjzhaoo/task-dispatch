// [AI-added] 2026-09-24 14:04: Snapshot ignore rules exclude bulky inputs without hiding rule edits.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const snap = require('../runtime/core/snapshot.cjs');
// [AI-added] 2026-09-24 14:17: Exercise the dispatch boundary as well as the snapshot helper.
const { Store } = require('../runtime/core/storage.cjs');
const { Dispatcher } = require('../runtime/core/dispatcher.cjs');
const { Desktop } = require('../runtime/core/desktop.cjs');

function fixture(t) {
  const base = path.resolve(__dirname, '../tmp');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'taskignore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, name, value) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

test('.taskignore skips large files and nested directories before snapshot limits', t => {
  // [AI-added] 2026-09-24 14:05: Keep immutable artifacts outside the scanned workspace.
  const base = fixture(t), root = path.join(base, 'workspace');
  fs.mkdirSync(root);
  write(root, '.taskignore', '# generated files\n*.dll\nbin/\n!keep.dll\n');
  write(root, 'src/large.dll', 'x'.repeat(100));
  write(root, 'nested/bin/large.dat', 'x'.repeat(100));
  write(root, 'keep.dll', 'yes');
  write(root, 'src/main.c', 'main');
  const config = { maxFileBytes: 50, maxTotalBytes: 128 };
  const artifact = snap.snapshot(root, path.join(base, 'artifacts'), config);
  assert.deepEqual(Object.keys(artifact.files).sort(), ['.taskignore', 'keep.dll', 'src/main.c']);
  assert.deepEqual(artifact.policy.taskIgnoreRules, ['*.dll', 'bin/', '!keep.dll']);
  // [AI-added] 2026-09-24 14:12: The review copy must reconstruct the same scoped manifest.
  const reviewed = snap.reviewCopy(path.join(base, 'artifacts'), artifact.id, path.join(base, 'review'), artifact.policy);
  assert.deepEqual(reviewed, artifact.files);
});

test('attempt policy freezes .taskignore and tracks edits to the rule file', t => {
  const root = fixture(t);
  write(root, '.taskignore', 'b.bin\n');
  write(root, 'a.txt', 'A');
  write(root, 'b.bin', 'B');
  const initial = snap.manifest(root, {});
  const frozen = snap.workspacePolicy(root, {});
  assert.deepEqual(Object.keys(initial).sort(), ['.taskignore', 'a.txt']);
  write(root, '.taskignore', 'a.txt\n');
  const after = snap.manifest(root, frozen);
  assert.deepEqual(Object.keys(after).sort(), ['.taskignore', 'a.txt']);
  assert.deepEqual(snap.difference(initial, after), ['.taskignore']);
  assert.deepEqual(Object.keys(snap.manifest(root, {})).sort(), ['.taskignore', 'b.bin']);
});

test('project configurations resolve .taskignore before freezing an attempt', t => {
  const root = fixture(t);
  write(root, '.taskignore', 'b.bin\n');
  write(root, 'a.txt', 'A');
  write(root, 'b.bin', 'B');
  const config = snap.policy({ version: 2 });
  assert.deepEqual(Object.keys(snap.manifest(root, config)).sort(), ['.taskignore', 'a.txt']);
  const next = snap.workspacePolicy(root, config);
  assert.deepEqual(Object.keys(snap.manifest(root, next)).sort(), ['.taskignore', 'a.txt']);
});

test('named ignored deliverables are rejected and protected authority remains visible', t => {
  const root = fixture(t);
  write(root, '.taskignore', 'bin/\n*.dll\n*\n');
  write(root, 'bin/tool.dll', 'x');
  write(root, '.task-dispatch/plan.md', 'plan');
  write(root, '.dispatch-evidence/changes.json', '{}');
  assert.deepEqual(snap.excludedTaskPaths(['bin/tool.dll', 'other.dll', '.task-dispatch/plan.md'], {}, root), ['bin/tool.dll', 'other.dll']);
  assert.deepEqual(Object.keys(snap.manifest(root, {})).sort(), ['.dispatch-evidence/changes.json', '.task-dispatch/plan.md', '.taskignore']);
  // [AI-added] 2026-09-24 14:31: Explicit policy cannot erase the rule-file audit trail.
  assert.throws(() => snap.policy({ exclude: ['.taskignore'] }), /Cannot exclude .taskignore/);
});

test('invalid .taskignore encoding and traversal rules fail visibly', t => {
  const root = fixture(t);
  write(root, '.taskignore', Buffer.from([0xff]));
  assert.throws(() => snap.manifest(root, {}), /encoded|valid|UTF-8|utf-8/i);
  write(root, '.taskignore', '../outside\n');
  assert.throws(() => snap.manifest(root, {}), /Invalid .taskignore rule/);
});

test('a rule added after task registration blocks dispatch before an attempt is recorded', async t => {
  // [AI-added] 2026-09-24 14:17: The worker must never receive an invisible deliverable.
  const base = fixture(t), root = path.join(base, 'work');
  fs.mkdirSync(root);
  write(root, 'result.dll', 'deliverable');
  const store = new Store(path.join(base, 'service'));
  t.after(() => store.close());
  const dispatcher = new Dispatcher(store,{maxConcurrent:2});
  const desktop = new Desktop(dispatcher);
  desktop.attach({ workspace: root, role: 'worker', clientId: 'worker123', token: 'a'.repeat(64) });
  desktop.attach({ workspace: root, role: 'brain', clientId: 'brain1234', token: 'b'.repeat(64) });
  const projectId = desktop.authenticate('b'.repeat(64)).projectId;
  require('./stage-fixture.cjs').start(desktop,desktop.authenticate('b'.repeat(64)));
  dispatcher.addTask(projectId, { id: 'T', title: 'T', instructions: 'update result', acceptance: 'result', allowedPaths: ['result.dll'] });
  write(root, '.taskignore', '*.dll\n');
  store.change(s=>{s.projects[projectId].tasks.T.roundId='fixture';});
  await dispatcher.execute(projectId, 'T');
  const task = store.state.projects[projectId].tasks.T;
  assert.equal(task.state, 'blocked');
  assert.equal(task.attempts.length, 0);
  assert.match(task.error, /result\.dll/);
});

test('invalid rules block the task without stopping dispatch', async t => {
  // [AI-added] 2026-09-24 14:19: Configuration errors stay local to the affected task.
  const base = fixture(t), root = path.join(base, 'work');
  fs.mkdirSync(root);
  write(root, 'result.txt', 'deliverable');
  const store = new Store(path.join(base, 'service'));
  t.after(() => store.close());
  const dispatcher = new Dispatcher(store,{maxConcurrent:2});
  const desktop = new Desktop(dispatcher);
  desktop.attach({ workspace: root, role: 'worker', clientId: 'worker123', token: 'a'.repeat(64) });
  desktop.attach({ workspace: root, role: 'brain', clientId: 'brain1234', token: 'b'.repeat(64) });
  const brain = desktop.authenticate('b'.repeat(64)), projectId = brain.projectId;
  require('./stage-fixture.cjs').start(desktop,brain);
  dispatcher.addTask(projectId, { id: 'T', title: 'T', instructions: 'update result', acceptance: 'result', allowedPaths: ['result.txt'] });
  write(root, '.taskignore', '../outside\n');
  store.change(s=>{s.projects[projectId].tasks.T.roundId='fixture';});
  await dispatcher.execute(projectId, 'T');
  assert.equal(store.state.projects[projectId].tasks.T.state, 'blocked');
  assert.match(store.state.projects[projectId].tasks.T.error, /Invalid .taskignore rule/);
  assert.equal(dispatcher.stopping, false);
});
