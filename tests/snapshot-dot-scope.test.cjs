'use strict';
// [AI-added] 2026-09-20: IDE/agent cache dot folders must never enter a snapshot, count as
// worker drift, or block review of attempts issued before the rule existed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const snapshots = require('../runtime/core/snapshot.cjs');
const scope = require('../runtime/core/scope-recovery.cjs');
const { Store } = require('../runtime/core/storage.cjs');
const { Dispatcher } = require('../runtime/core/dispatcher.cjs');
const { Desktop } = require('../runtime/core/desktop.cjs');

function workdir(t) {
  const base = path.resolve(__dirname, '../tmp'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'dot-scope-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, rel, text = 'x') {
  const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file;
}

test('top-level dot folders are cache: excluded from snapshots, authority dirs kept', t => {
  const root = workdir(t);
  write(root, '.workbuddy-ai/memory/2026-09-20.md');
  write(root, '.zcode/state.json');
  write(root, '.godot/imported/cache.ctex');
  write(root, '.task-dispatch/plan.md', 'authority');
  write(root, '.dispatch-evidence/changes.json', '{}');
  write(root, 'src/.well-known/security.txt', 'not a cache');
  write(root, 'README.md', 'business');
  const files = snapshots.manifest(root, {});
  assert.deepEqual(Object.keys(files).sort(), ['.dispatch-evidence/changes.json', '.task-dispatch/plan.md', 'README.md', 'src/.well-known/security.txt']);
  // Only the workspace root qualifies: nested dot folders are ordinary content.
  assert.ok(files['src/.well-known/security.txt']);
});

test('dot folders stay unmonitored under a stored legacy policy and never register as drift', t => {
  const root = workdir(t);
  write(root, '.workbuddy-ai/memory/a.md');
  write(root, 'README.md', 'before');
  for (const policy of [{}, { version: 1, exclude: [] }, { version: 2, exclude: ['tmp/'] }]) {
    assert.equal(snapshots.ignored('.workbuddy-ai/memory/a.md', policy), true, JSON.stringify(policy));
    assert.equal(snapshots.ignored('.task-dispatch/plan.md', policy), false, JSON.stringify(policy));
    assert.ok(!snapshots.difference({ '.workbuddy-ai/memory/a.md': { hash: 'a' } }, { '.workbuddy-ai/memory/a.md': { hash: 'b' } }).length);
  }
  // A dot deliverable cannot be authorized: registration rejects it instead of delivering nothing.
  assert.deepEqual(snapshots.excludedTaskPaths(['.workbuddy-ai/out.md', 'src/a.ts'], {}), ['.workbuddy-ai/out.md']);
});

test('a candidate recorded before the rule still passes review drift and integrity checks', async t => {
  const root = workdir(t), workspace = path.join(root, 'work'); fs.mkdirSync(workspace);
  write(workspace, 'README.md', 'before');
  const store = new Store(path.join(root, 'service')); t.after(() => store.close());
  const d = new Dispatcher(store, { enableRealCalls: false }, () => { throw Error('no model'); });
  const desktop = new Desktop(d);
  desktop.attach({ workspace, role: 'worker', clientId: 'worker123', token: 'a'.repeat(64) });
  desktop.attach({ workspace, role: 'brain', clientId: 'brain1234', token: 'b'.repeat(64) });
  const brain = desktop.authenticate('b'.repeat(64)), worker = desktop.authenticate('a'.repeat(64)), projectId = worker.projectId;
  require('./stage-fixture.cjs').start(desktop,brain);
  d.addTask(projectId, { id: 'T', title: 'T', instructions: 'edit readme', acceptance: 'edited', allowedPaths: ['README.md'] });
  // A candidate created before the rule listed IDE cache files; rewrite its stored manifest that
  // way, then let the cache churn on disk exactly as .workbuddy-ai does during a review.
  const candidate = d.createSnapshot(workspace, {});
  const cache = { '.workbuddy-ai/memory/2026-09-20.md': { hash: 'deadbeef', mode: 0o644 } };
  const stored = { ...candidate, files: { ...candidate.files, ...cache } };
  delete stored.monitoredHash;
  stored.hash = require('../runtime/core/storage.cjs').sha(JSON.stringify(stored.files));
  fs.writeFileSync(path.join(d.artifacts, candidate.id, 'manifest.json'), JSON.stringify(stored));
  store.change(s => Object.assign(s.projects[projectId].tasks.T, { artifactId: candidate.id, artifactHash: stored.hash, changedFiles: ['README.md'], snapshotPolicy: candidate.policy }));
  write(workspace, '.workbuddy-ai/memory/2026-09-20.md', 'cache churn after the candidate');
  const live = store.state.projects[projectId], task = live.tasks.T;
  // Review must not be refused as stale: the cache file is outside the monitored scope.
  assert.doesNotThrow(() => d.assertReviewWorkspace(live, task, task.snapshotPolicy, 'settle'));
  // And the review copy must still verify: the raw stored hash covers cache entries the fresh
  // manifest never lists, so integrity is checked on the monitored scope instead.
  const dest = path.join(root, 'review-copy');
  const reviewManifest = snapshots.reviewCopy(d.artifacts, candidate.id, dest, task.snapshotPolicy);
  assert.notEqual(require('../runtime/core/storage.cjs').sha(JSON.stringify(reviewManifest)), stored.hash);
  assert.equal(snapshots.monitoredHash(reviewManifest), snapshots.storedMonitoredHash(snapshots.loadSnapshot(d.artifacts, candidate.id)));
});

test('an explicitly authorized other-task evidence directory stays writable', () => {
  const evidence = 'docs/worker-results/T15A/report.md';
  assert.equal(scope.writable(evidence, ['docs/worker-results/T15A/'], 'T15B'), true);
  assert.equal(scope.writable(evidence, ['docs/worker-results/T15B/'], 'T15B'), false);
  assert.equal(scope.writable(evidence, ['docs/worker-results/'], 'T15B'), false, 'blanket grant must not authorize');
  assert.equal(scope.writable(evidence, ['docs/worker-results/T15A/'], 'T15B', 'x'), true);
});
