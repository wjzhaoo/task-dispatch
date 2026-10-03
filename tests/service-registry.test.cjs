'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const registry = require('../runtime/core/service-registry.cjs');
const dashboard = require('../runtime/core/dashboard.cjs');
const { atomic, desktopProjectId } = require('../runtime/core/storage.cjs');

function rootAt(parent, name, projects = {}) {
  const root = path.join(parent, name); fs.mkdirSync(root, { recursive: true });
  atomic(path.join(root, 'state.json'), { version: 2, revision: 1, projects, events: [] });
  atomic(path.join(root, 'config.json'), { version: 1 }); return root;
}
function project(workspace, title) {
  const id = desktopProjectId(workspace);
  return { id, workspace, mode: 'desktop', paused: false, turns: 0, tasks: { T: { id: 'T', title, state: 'ready', maxAttempts: 30, attempts: [], dependsOn: [] } }, bindings: {}, startup: { state: 'waiting' } };
}
test('dashboard aggregates registered project service roots without reading credentials', t => {
  const temp = fs.mkdtempSync(path.join(path.resolve(__dirname, '../tmp'), 'registry-')); t.after(() => fs.rmSync(temp, { recursive: true }));
  const publicWorkspace = path.join(temp, 'public-workspace'), localWorkspace = path.join(temp, 'local-workspace'); fs.mkdirSync(publicWorkspace); fs.mkdirSync(localWorkspace);
  const publicProject = project(publicWorkspace, 'Public task'), localProject = project(localWorkspace, 'Local task');
  const publicRoot = rootAt(temp, 'public-service', { [publicProject.id]: publicProject });
  const localRoot = rootAt(temp, 'local-service', { [localProject.id]: localProject });
  fs.writeFileSync(path.join(localRoot, 'admin-token'), 'must-not-be-read');
  const file = path.join(temp, 'registry.json'); registry.register(localRoot, [localWorkspace], { file });
  const snapshot = { instanceId: 'instance', revision: 1, cursor: 0, health: {}, projects: [{ id: publicProject.id, workspace: publicWorkspace, connections: [], tasks: [], alerts: [] }] };
  const result = dashboard.aggregateSnapshot(snapshot, publicRoot, { file, home: path.join(temp, 'home') });
  assert.deepEqual(result.projects.map(p => p.id).sort(), [publicProject.id, localProject.id].sort());
  const external = result.projects.find(p => p.id === localProject.id);
  assert.equal(external.readOnly, true); assert.equal(external.tasks[0].title, 'Local task'); assert.equal(external.service.dataRoot, localRoot);
  assert.equal(result.projects.find(p => p.id === publicProject.id).readOnly, false);
});

test('known public workspace bootstraps a pre-registry sibling project root', t => {
  const temp = fs.mkdtempSync(path.join(path.resolve(__dirname, '../tmp'), 'registry-bootstrap-')); t.after(() => fs.rmSync(temp, { recursive: true }));
  const workspace = path.join(temp, 'workspace'); fs.mkdirSync(workspace);
  const p = project(workspace, 'Migrated task'), publicRoot = rootAt(temp, 'public-service', { [p.id]: p });
  const sibling = require('../runtime/core/data-root.cjs').projectDataRoot(workspace); rootAt(path.dirname(sibling), path.basename(sibling), { [p.id]: p });
  const services = registry.discover(publicRoot, { file: path.join(temp, 'missing-registry.json'), home: path.join(temp, 'home') });
  assert.ok(services.some(service => registry.pathKey(service.root) === registry.pathKey(sibling)));
});

// [AI-added] 2026-09-17 13:54
test('system catalog lists every project workspace and its project-local data root', t => {
  const temp = fs.mkdtempSync(path.join(path.resolve(__dirname, '../tmp'), 'project-catalog-')); t.after(() => fs.rmSync(temp, { recursive: true }));
  const file = path.join(temp, 'registry.json'), workspaces = [path.join(temp, 'one'), path.join(temp, 'two')];
  for (const [index, workspace] of workspaces.entries()) {
    fs.mkdirSync(workspace); const p = project(workspace, 'Task ' + index), root = rootAt(temp, 'service-' + index, { [p.id]: p });
    registry.register(root, [workspace], { file });
  }
  const entries = registry.catalog({ file, home: path.join(temp, 'home') });
  assert.deepEqual(entries.map(entry => entry.workspace).sort(), workspaces.map(workspace => path.resolve(workspace)).sort());
  assert.equal(entries.every(entry => entry.projectId && entry.dataExists && entry.workspaceExists), true);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(raw.version, 2); assert.equal(Object.keys(raw.projects).length, 2);
});
// [AI-added] 2026-09-24 13:27: Import legacy AppData metadata into the home index without moving service data.
test('home index has project metadata directories and imports the legacy cache catalog', t => {
  const temp = fs.mkdtempSync(path.join(path.resolve(__dirname, '../tmp'), 'home-index-')); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home'), cacheRoot = path.join(temp, 'local-cache');
  const oldWorkspace = path.join(temp, 'old-workspace'), workspace = path.join(temp, 'workspace');
  fs.mkdirSync(oldWorkspace); fs.mkdirSync(workspace);
  const oldProject = project(oldWorkspace, 'Old'), current = project(workspace, 'Current');
  const oldRoot = rootAt(oldWorkspace, '.task-dispatch/runtime/old', { [oldProject.id]: oldProject });
  const root = rootAt(workspace, '.task-dispatch/runtime/current', { [current.id]: current });
  registry.register(oldRoot, [oldWorkspace], { file: registry.legacyCacheRegistryFile(cacheRoot) });
  assert.deepEqual(registry.catalog({ home, cacheRoot }).map(entry => entry.workspace), [path.resolve(oldWorkspace)]);
  registry.register(root, [workspace], { home, cacheRoot });
  const canonical = registry.registryFile(registry.systemIndexRoot(home));
  const entries = registry.catalog({ home, cacheRoot });
  assert.deepEqual(entries.map(entry => entry.workspace).sort(), [oldWorkspace, workspace].map(value => path.resolve(value)).sort());
  assert.equal(JSON.parse(fs.readFileSync(canonical, 'utf8')).projects[registry.keyOf(workspace)].dataRoot, path.resolve(root));
  for (const value of [oldWorkspace, workspace]) {
    const metadata = registry.projectMetadataFile(value, home);
    assert.equal(JSON.parse(fs.readFileSync(metadata, 'utf8')).workspace, path.resolve(value));
    assert.deepEqual(fs.readdirSync(path.dirname(metadata)), ['project.json']);
  }
});
// [AI-added] 2026-09-24 13:32: Index cleanup can upgrade old metadata and removes only its matching manifest.
test('pruning an old-only catalog creates and maintains home project metadata', t => {
  const temp=fs.mkdtempSync(path.join(path.resolve(__dirname,'../tmp'),'index-prune-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const home=path.join(temp,'home'),cacheRoot=path.join(temp,'cache'),workspace=path.join(temp,'workspace');fs.mkdirSync(workspace);
  const p=project(workspace,'Task'),root=rootAt(workspace,'.task-dispatch/runtime/current',{[p.id]:p});
  registry.register(root,[workspace],{file:registry.legacyCacheRegistryFile(cacheRoot)});
  assert.deepEqual(registry.pruneInvalid({home,cacheRoot}).removed,[]);
  const canonical=registry.registryFile(registry.systemIndexRoot(home)),metadata=registry.projectMetadataFile(workspace,home);
  assert.equal(fs.existsSync(canonical),true);assert.equal(fs.existsSync(metadata),true);
  fs.rmSync(workspace,{recursive:true,force:true});
  assert.equal(registry.pruneInvalid({home,cacheRoot}).removed.length,1);
  assert.equal(fs.existsSync(metadata),false);
});
// [AI-added] 2026-09-17 13:54
test('dashboard keeps an unavailable catalog project visible', t => {
  const temp = fs.mkdtempSync(path.join(path.resolve(__dirname, '../tmp'), 'catalog-unavailable-')); t.after(() => fs.rmSync(temp, { recursive: true }));
  const workspace = path.join(temp, 'moved-project'), root = rootAt(temp, 'missing-service'), file = path.join(temp, 'registry.json'); fs.mkdirSync(workspace);
  const p = project(workspace, 'Unavailable'); atomic(path.join(root, 'state.json'), { version: 2, revision: 1, projects: { [p.id]: p }, events: [] }); registry.register(root, [workspace], { file });
  fs.unlinkSync(path.join(root, 'config.json')); fs.unlinkSync(path.join(root, 'state.json'));
  const result = dashboard.aggregateSnapshot({ instanceId:'i', revision:1, cursor:0, health:{}, projects:[] }, path.join(temp, 'empty-current'), { file, home:path.join(temp, 'home') });
  assert.equal(result.projects.length, 1); assert.equal(result.projects[0].workspace, path.resolve(workspace)); assert.equal(result.projects[0].service.unavailable, true); assert.match(result.projects[0].alerts[0].message, /不可用/);
});
// [AI-added] 2026-09-19: index-only cleanup of vanished workspaces.
test('pruneInvalid removes only dead index entries and keeps services with live data', t => {
  const temp = fs.mkdtempSync(path.join(path.resolve(__dirname, '../tmp'), 'registry-prune-')); t.after(() => fs.rmSync(temp, { recursive: true }));
  const file = path.join(temp, 'registry.json');
  // Pure index residue: the per-project data root lives inside the vanished workspace.
  const gone = path.join(temp, 'gone-project'), goneRoot = rootAt(gone, 'service-data');
  const live = path.join(temp, 'live-project'), liveProject = project(live, 'Live'), liveRoot = rootAt(temp, 'live-service', { [liveProject.id]: liveProject });
  // Workspace vanished but its service data root is still alive elsewhere.
  const kept = path.join(temp, 'kept-project'), keptRoot = rootAt(temp, 'kept-service');
  // Service still running: never touched even though its workspace is gone.
  const busy = path.join(temp, 'busy-project'), busyRoot = path.join(temp, 'busy-service'); fs.mkdirSync(busyRoot);
  atomic(path.join(busyRoot, 'endpoint.json'), { pid: process.pid, port: 41000 });
  fs.mkdirSync(live); fs.mkdirSync(kept); fs.mkdirSync(busy);
  for (const [root, workspace] of [[goneRoot, gone], [liveRoot, live], [keptRoot, kept], [busyRoot, busy]]) registry.register(root, [workspace], { file });
  fs.rmSync(gone, { recursive: true }); for (const dir of [kept, busy]) { fs.rmSync(dir, { recursive: true, force: true }); }
  const result = registry.pruneInvalid({ file, home: path.join(temp, 'home') });
  assert.deepEqual(result.removed.map(entry => path.resolve(entry.workspace)).sort(), [gone].map(item => path.resolve(item)));
  assert.deepEqual(result.kept.map(entry => path.resolve(entry.workspace)).sort(), [kept, busy].map(item => path.resolve(item)).sort());
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(raw.projects).sort(), [live, kept, busy].map(workspace => registry.keyOf(path.resolve(workspace))).sort());
  assert.deepEqual(raw.services[registry.keyOf(path.resolve(goneRoot))].workspaces, []);
  assert.deepEqual(raw.services[registry.keyOf(path.resolve(keptRoot))].workspaces, [path.resolve(kept)]);
  assert.deepEqual(raw.services[registry.keyOf(path.resolve(busyRoot))].workspaces, [path.resolve(busy)]);
  // A second pass changes nothing further.
  assert.deepEqual(registry.pruneInvalid({ file, home: path.join(temp, 'home') }).removed, []);
  // Surviving entries stay visible in the catalog afterwards.
  assert.deepEqual(registry.catalog({ file, home: path.join(temp, 'home') }).map(entry => path.resolve(entry.workspace)).sort(), [live, kept, busy].map(item => path.resolve(item)).sort());
});
