'use strict';
// [AI-added] 2026-09-20: IDE/agent cache dot folders must never enter a snapshot, count as
// worker drift, or block review of current attempts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const snapshots = require('../runtime/core/snapshot.cjs');
const scope = require('../runtime/core/scope-recovery.cjs');

function workdir(t) {
  const base = path.resolve(__dirname, '../tmp'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'dot-scope-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, rel, text = 'x') {
  const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file;
}

test('reserved device names are rejected as deliverables without rejecting ordinary names', () => {
  for (const name of ['nul', 'NUL.txt', 'src/CON', 'src/aux.log', 'COM1/', 'nested/LPT².log', 'nul. ', 'dir/nul/file.txt']) {
    assert.throws(() => snapshots.validatePaths([name]), /Windows reserved file names/);
  }
  assert.doesNotThrow(() => snapshots.validatePaths(['null.txt', 'src/console.js', 'com10.txt', 'lpt10/', 'auxiliary.md']));
  // A stored exclusion remains readable; it does not authorize a reserved deliverable.
  assert.ok(snapshots.policy({ exclude: ['nul'] }).exclude.includes('nul'));
});

test('real reserved-name files are diagnosed but cannot enter a snapshot', t => {
  const base = workdir(t), root = path.join(base, 'work'), artifacts = path.join(base, 'artifacts');
  fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'src'));
  for (const name of ['nul', 'src/COM1.txt']) fs.writeFileSync(path.toNamespacedPath(path.join(root, name)), 'actual file');
  write(root, 'null.txt', 'ordinary');
  const files = snapshots.manifest(root, {});
  assert.deepEqual(snapshots.reservedNames(files), ['nul', 'src/COM1.txt']);
  assert.equal(files.nul.hash, require('../runtime/core/storage.cjs').sha('actual file'));
  assert.throws(() => snapshots.snapshot(root, artifacts, {}), /Windows reserved file names.*nul.*src\/COM1\.txt/);
  assert.equal(fs.existsSync(artifacts), false, 'reject before creating any candidate');
});

test('legacy reserved-name evidence remains readable but cannot be copied to review or validation', async t => {
  const base = workdir(t), root = path.join(base, 'work'), artifacts = path.join(base, 'artifacts'), dest = path.join(base, 'review');
  fs.mkdirSync(root); write(root, 'README.md', 'ordinary');
  const candidate = snapshots.snapshot(root, artifacts, {}), { sha } = require('../runtime/core/storage.cjs');
  candidate.files.nul = { hash: sha(''), mode: 0o666 };
  candidate.hash = sha(JSON.stringify(candidate.files)); candidate.monitoredHash = snapshots.monitoredHash(candidate.files);
  const file = path.join(artifacts, candidate.id, 'manifest.json'), bytes = Buffer.from(JSON.stringify(candidate));
  fs.writeFileSync(file, bytes);
  assert.ok(snapshots.loadSnapshot(artifacts, candidate.id).files.nul);
  assert.throws(() => snapshots.reviewCopy(artifacts, candidate.id, dest, candidate.policy), /Windows reserved file names.*nul/);
  assert.equal(fs.existsSync(dest), false);
  const validationRoot = path.join(base, 'validation');
  await assert.rejects(require('../runtime/core/validation.cjs').prepare({ workspace: root, artifacts, artifactId: candidate.id, artifactHash: candidate.hash, root: validationRoot, config: { dependencies: 'copy-node-modules', checks: [['run', 'test']] } }), /Windows reserved file names.*nul/);
  assert.equal(fs.existsSync(validationRoot), false);
  assert.deepEqual(fs.readFileSync(file), bytes, 'historical evidence is not rewritten');
});

test('an unrecorded reserved file in an artifact is never copied into a review', t => {
  const base = workdir(t), root = path.join(base, 'work'), artifacts = path.join(base, 'artifacts'), dest = path.join(base, 'review');
  fs.mkdirSync(root); write(root, 'README.md', 'ordinary');
  const candidate = snapshots.snapshot(root, artifacts, {});
  fs.writeFileSync(path.toNamespacedPath(path.join(artifacts, candidate.id, 'tree/nul')), '');
  assert.throws(() => snapshots.reviewCopy(artifacts, candidate.id, dest, candidate.policy), /Windows reserved file names.*nul/);
  assert.equal(fs.existsSync(dest) && fs.readdirSync(dest).includes('nul'), false);
});

test('a claimed worker gets reserved-name diagnostics and cannot submit until its accidental file is removed', async t => {
  const x = await require('./stage-fixture.cjs').setup(t);
  assert.throws(() => x.task('BAD', { allowedPaths: ['nul'] }), /Windows reserved file names/);
  assert.equal(x.p().tasks.BAD, undefined);
  x.task('A', { allowedPaths: ['output/'] }); x.register(x.definition(['A']));
  const worker = await x.claim('worker'), dir = path.join(x.workspace, 'output'); fs.mkdirSync(dir);
  const accidental = path.toNamespacedPath(path.join(dir, 'nul')); fs.writeFileSync(accidental, '');
  const state = JSON.stringify(x.store.state), artifacts = fs.readdirSync(x.d.artifacts);
  const check = x.desktop.preflight(x.identities.worker, { taskId: 'A', attemptId: worker.attemptId });
  assert.equal(check.ok, false); assert.deepEqual(check.reservedNames, ['output/nul']);
  assert.equal(JSON.stringify(x.store.state), state, 'preflight stays read only');
  await assert.rejects(x.submit(worker), /Windows reserved file names.*output\/nul/);
  assert.deepEqual(fs.readdirSync(x.d.artifacts), artifacts, 'rejection creates no candidate');
  assert.equal(fs.existsSync(x.d.receiptPath(worker.attemptId)), false);
  assert.equal(x.p().tasks.A.attempts.at(-1).settled, false);
  fs.unlinkSync(accidental); write(x.workspace, 'output/result.txt', 'actual deliverable');
  await x.submit(worker);
  assert.equal((await x.claim('reviewer')).taskId, 'A', 'same attempt can submit after correction');
});

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

test('dot folders stay unmonitored under current frozen policies and never register as drift', t => {
  const root = workdir(t);
  write(root, '.workbuddy-ai/memory/a.md');
  write(root, 'README.md', 'before');
  for (const policy of [{}, snapshots.workspacePolicy(root, {}), { version: 2, exclude: ['tmp/'] }]) {
    assert.equal(snapshots.ignored('.workbuddy-ai/memory/a.md', policy), true, JSON.stringify(policy));
    assert.equal(snapshots.ignored('.task-dispatch/plan.md', policy), false, JSON.stringify(policy));
    assert.ok(!snapshots.difference({ '.workbuddy-ai/memory/a.md': { hash: 'a' } }, { '.workbuddy-ai/memory/a.md': { hash: 'b' } }).length);
  }
  // A dot deliverable cannot be authorized: registration rejects it instead of delivering nothing.
  assert.deepEqual(snapshots.excludedTaskPaths(['.workbuddy-ai/out.md', 'src/a.ts'], {}), ['.workbuddy-ai/out.md']);
});

test('stored snapshots require frozen rules and monitored hashes without rewriting them',t=>{
 const root=workdir(t),artifacts=path.join(root,'artifacts'),workspace=path.join(root,'work');fs.mkdirSync(workspace);write(workspace,'README.md','business');
 const candidate=snapshots.snapshot(workspace,artifacts,{}),file=path.join(artifacts,candidate.id,'manifest.json');
 assert.equal(JSON.stringify(snapshots.loadSnapshot(artifacts,candidate.id)),JSON.stringify(candidate));
 for(const modify of [v=>delete v.monitoredHash,v=>delete v.policy.taskIgnoreRules,v=>v.policy.version=1]){
  const value=structuredClone(candidate);modify(value);const bytes=Buffer.from(JSON.stringify(value));fs.writeFileSync(file,bytes);
  assert.throws(()=>snapshots.loadSnapshot(artifacts,candidate.id),/Stored snapshot|snapshot policy/);assert.deepEqual(fs.readFileSync(file),bytes);
 }
});

test('an explicitly authorized other-task evidence directory stays writable', () => {
  const evidence = 'docs/worker-results/T15A/report.md';
  assert.equal(scope.writable(evidence, ['docs/worker-results/T15A/'], 'T15B'), true);
  assert.equal(scope.writable(evidence, ['docs/worker-results/T15B/'], 'T15B'), false);
  assert.equal(scope.writable(evidence, ['docs/worker-results/'], 'T15B'), false, 'blanket grant must not authorize');
  assert.equal(scope.writable(evidence, ['docs/worker-results/T15A/'], 'T15B', 'x'), true);
});
