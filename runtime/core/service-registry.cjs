// Local index for explicitly registered project service roots.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomic, atomicChanged, read, sha, alive } = require('./storage.cjs');
const { systemIndexRoot, assertServiceRoot } = require('./data-root.cjs');

function registryFile(indexRoot = systemIndexRoot()) {
  return path.join(path.resolve(indexRoot), 'service-registry.json');
}
function keyOf(value) {
  const root = path.resolve(value);
  return sha(process.platform === 'win32' ? root.toLowerCase() : root).slice(0, 16);
}
function pathKey(value) {
  const root = path.resolve(value);
  return process.platform === 'win32' ? root.toLowerCase() : root;
}
function stateAt(root) {
  const file = path.join(root, 'state.json');
  if (!fs.existsSync(file)) return null;
  const state = read(file);
  return require('./storage.cjs').validateState(state);
}
function workspacesOf(state) {
  return [...new Set(Object.values(state?.projects || {}).map(p => p?.workspace).filter(v => typeof v === 'string' && path.isAbsolute(v)).map(v => path.resolve(v)))];
}
// [AI-added] 2026-09-17 13:54
function emptyRegistry() { return { version: 2, services: {}, projects: {} }; }
// [AI-added] 2026-09-17 13:54
function normalizeRegistry(value) {
  if (!value || value.version !== 2 || !value.services || typeof value.services !== 'object' || Array.isArray(value.services) || !value.projects || typeof value.projects !== 'object' || Array.isArray(value.projects)) throw Error('Unsupported/corrupt service registry');
  return { version: 2, services: value.services, projects: value.projects };
}
function readRegistry(file) {
  return fs.existsSync(file) ? normalizeRegistry(read(file)) : emptyRegistry();
}
function projectMetadataFile(workspace, home) {
  return path.join(systemIndexRoot(home), 'projects', keyOf(workspace), 'project.json');
}
function register(root, workspaces = [], { file, home } = {}) {
  if (!file && !home && process.env.NODE_TEST_CONTEXT) return null;
  const target = path.resolve(file || registryFile(systemIndexRoot(home))), resolved = assertServiceRoot(root, home), now = new Date().toISOString();
  const value = readRegistry(target);
  const id = keyOf(resolved), previous = value.services[id] || {};
  const normalized = [...new Set([...(previous.workspaces || []), ...workspaces].filter(v => typeof v === 'string' && path.isAbsolute(v)).map(v => path.resolve(v)))];
  value.services[id] = { root: resolved, workspaces: normalized, registeredAt: previous.registeredAt || now, seenAt: now };
  let state; try { state = stateAt(resolved); } catch { state = null; }
  for (const workspace of normalized) {
    const project = Object.values(state?.projects || {}).find(item => pathKey(item.workspace) === pathKey(workspace));
    const projectKey = keyOf(workspace), old = value.projects[projectKey] || {};
    value.projects[projectKey] = { projectId: project?.id || old.projectId, workspace, dataRoot: resolved, registeredAt: old.registeredAt || now, seenAt: now };
  }
  atomic(target, value);
  // [AI-added] 2026-09-24 13:24: Per-project directories contain metadata only, never snapshots or credentials.
  if (!file) for (const workspace of normalized) {const project=value.projects[keyOf(workspace)];atomicChanged(projectMetadataFile(workspace,home),{version:1,...project});}
  return value.services[id];
}
function tryRegister(root, workspaces = [], options = {}) {
  try { return { entry: register(root, workspaces, options), error: null }; }
  catch (error) { return { entry: null, error: error.message }; }
}
function online(root) {
  try {
    const endpoint = read(path.join(root, 'endpoint.json'));
    return Number.isInteger(endpoint.pid) && Number.isInteger(endpoint.port) && alive(endpoint.pid);
  } catch { return false; }
}
function discover(currentRoot, { file, home } = {}) {
  const roots = new Map(), add = (root, registered = {}) => {
    if (typeof root !== 'string' || !path.isAbsolute(root)) return false;
    let resolved; try { resolved = assertServiceRoot(root, home); } catch { return false; }
    const key = pathKey(resolved);
    if (roots.has(key)) return false;
    if (!fs.existsSync(path.join(resolved, 'state.json')) && !fs.existsSync(path.join(resolved, 'config.json'))) return false;
    roots.set(key, { key: keyOf(resolved), root: resolved, workspaces: registered.workspaces || [], registeredAt: registered.registeredAt, seenAt: registered.seenAt }); return true;
  };
  add(path.resolve(currentRoot));
  // [AI-added] 2026-09-17 11:46
  const target = path.resolve(file || registryFile(systemIndexRoot(home)));
  // [AI-added] 2026-09-24 13:28: Explicit test roots are safe to inspect without touching the real user index.
  if ((file || home || !process.env.NODE_TEST_CONTEXT) && fs.existsSync(target)) {
    try {
      const value = normalizeRegistry(read(target));
      for (const entry of Object.values(value.services)) add(entry.root, entry);
      for (const entry of Object.values(value.projects)) add(entry.dataRoot, { workspaces: [entry.workspace], registeredAt: entry.registeredAt, seenAt: entry.seenAt });
    } catch { /* A damaged optional index must not hide the current service. */ }
  }
  return [...roots.values()].map(entry => ({ ...entry, online: online(entry.root), current: pathKey(entry.root) === pathKey(currentRoot) }));
}
// [AI-added] 2026-09-17 13:54
function catalog({ file, home } = {}) {
  const entries = new Map(), put = input => {
    if (!input || typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace) || typeof input.dataRoot !== 'string' || !path.isAbsolute(input.dataRoot)) return;
    let dataRoot; try { dataRoot = assertServiceRoot(input.dataRoot, home); } catch { return; }
    const workspace = path.resolve(input.workspace), key = keyOf(workspace), old = entries.get(key) || {};
    entries.set(key, { key, projectId: input.projectId || old.projectId, workspace, dataRoot, registeredAt: input.registeredAt || old.registeredAt, seenAt: input.seenAt || old.seenAt,
      workspaceExists: fs.existsSync(workspace), dataExists: fs.existsSync(path.join(dataRoot, 'config.json')), online: online(dataRoot) });
  };
  const target = path.resolve(file || registryFile(systemIndexRoot(home)));
  if ((file || home || !process.env.NODE_TEST_CONTEXT) && fs.existsSync(target)) try {
    const value = normalizeRegistry(read(target));
    for (const entry of Object.values(value.projects)) put(entry);
    for (const service of Object.values(value.services)) for (const workspace of service.workspaces || []) put({ workspace, dataRoot: service.root, registeredAt: service.registeredAt, seenAt: service.seenAt });
  } catch { /* An unsupported or corrupt optional catalog is ignored. */ }
  return [...entries.values()].sort((a, b) => (b.seenAt || '').localeCompare(a.seenAt || '') || a.workspace.localeCompare(b.workspace));
}
// [AI-added] 2026-09-19: Operator-initiated cleanup of stale catalog index entries.
// Removes registry records for workspaces that no longer exist on disk; project state
// and runtime data are never touched, and a service re-registers its workspaces the
// next time it starts. Entries whose service data still exists or whose service is
// online are reported as kept instead of being removed.
function pruneInvalid({ file, home } = {}) {
  const target = path.resolve(file || registryFile(systemIndexRoot(home)));
  const removed = [], kept = [], reported = new Set();
  const note = (list, workspace, dataRoot) => {
    const id = pathKey(workspace) + '|' + pathKey(dataRoot);
    if (!reported.has(id)) { reported.add(id); list.push({ workspace: path.resolve(workspace), dataRoot: path.resolve(dataRoot) }); }
  };
  const stale = (workspace, dataRoot) => {
    if (typeof workspace !== 'string' || fs.existsSync(workspace)) return false;
    if (online(dataRoot) || fs.existsSync(path.join(dataRoot, 'config.json'))) { note(kept, workspace, dataRoot); return false; }
    note(removed, workspace, dataRoot); return true;
  };
  if ((file || home || !process.env.NODE_TEST_CONTEXT) && fs.existsSync(target)) {
    let value;
    try { value = readRegistry(target); } catch { /* A corrupt optional index is skipped, never rewritten blind. */ return { removed, kept }; }
    let changed = false;
    const services = {};
    for (const [id, service] of Object.entries(value.services)) {
      const workspaces = (service.workspaces || []).filter(workspace => !stale(workspace, service.root));
      services[id] = workspaces.length === (service.workspaces || []).length ? service : { ...service, workspaces };
      if (services[id] !== service) changed = true;
    }
    const projects = {};
    for (const [key, entry] of Object.entries(value.projects)) {
      if (stale(entry.workspace, entry.dataRoot)) { changed = true; continue; }
      projects[key] = entry;
    }
    if (changed) atomic(target, { version: 2, services, projects });
    // Keep project metadata in sync with the canonical index.
    if (!file) for (const entry of Object.values(projects)) atomicChanged(projectMetadataFile(entry.workspace, home), { version: 1, ...entry });
    // [AI-added] 2026-09-24 13:31: Keep only matching metadata manifests; never touch service data.
    if (!file) for (const entry of Object.values(value.projects)) if (!projects[keyOf(entry.workspace)]) {
      const metadata = projectMetadataFile(entry.workspace, home);
      try {
        if (read(metadata).workspace !== path.resolve(entry.workspace)) continue;
        fs.unlinkSync(metadata);
        fs.rmdirSync(path.dirname(metadata));
      } catch { /* Missing or foreign metadata is left alone. */ }
    }
  }
  return { removed, kept };
}
// [AI-added] 2026-09-17 11:46
module.exports = { systemIndexRoot, registryFile, projectMetadataFile, keyOf, pathKey, stateAt, workspacesOf, register, tryRegister, online, discover, catalog, pruneInvalid };
