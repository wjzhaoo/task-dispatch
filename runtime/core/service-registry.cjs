// [AI-added] 2026-09-17: Local index for public and per-project service data roots.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomic, read, sha, alive } = require('./storage.cjs');
const { legacyDataRoot, legacyProjectDataRoot, projectDataRoot } = require('./data-root.cjs');

// [AI-added] 2026-09-17 11:46
function systemCacheRoot({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (platform === 'win32') return path.resolve(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'));
  return path.resolve(env.XDG_CACHE_HOME || path.join(home, '.cache'));
}
// [AI-added] 2026-09-24 13:24: The home directory is a lightweight index; service data stays in each workspace.
function systemIndexRoot(home = os.homedir()) { return path.resolve(home, '.task-dispatch-service'); }
function legacyCacheRegistryFile(cacheRoot = systemCacheRoot()) {
  return path.join(path.resolve(cacheRoot), 'task-dispatch', 'service-registry.json');
}
function registryFile(indexRoot = systemIndexRoot()) {
  return path.join(path.resolve(indexRoot), 'service-registry.json');
}
// [AI-added] 2026-09-17 11:46
function legacyRegistryFile(home = os.homedir()) {
  return path.join(path.resolve(home), '.task-dispatch-service-registry.json');
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
  if (state.version !== 2 || !state.projects || typeof state.projects !== 'object') throw Error('Unsupported/corrupt service state: ' + root);
  return state;
}
function workspacesOf(state) {
  return [...new Set(Object.values(state?.projects || {}).map(p => p?.workspace).filter(v => typeof v === 'string' && path.isAbsolute(v)).map(v => path.resolve(v)))];
}
// [AI-added] 2026-09-17 13:54
function emptyRegistry() { return { version: 2, services: {}, projects: {} }; }
// [AI-added] 2026-09-17 13:54
function normalizeRegistry(value) {
  if (!value || ![1, 2].includes(value.version) || !value.services || typeof value.services !== 'object') throw Error('Unsupported/corrupt service registry');
  return { version: 2, services: value.services, projects: value.projects && typeof value.projects === 'object' ? value.projects : {} };
}
// [AI-added] 2026-09-24 13:24: Import old system indexes only until the canonical home index exists.
function registrySources(file, home = os.homedir(), cacheRoot) {
  if (file) return [path.resolve(file)];
  const canonical = registryFile(systemIndexRoot(home));
  return fs.existsSync(canonical) ? [canonical] : [legacyRegistryFile(home), legacyCacheRegistryFile(cacheRoot)];
}
function mergedRegistry(file, home, cacheRoot) {
  const value = emptyRegistry();
  for (const source of registrySources(file, home, cacheRoot)) if (fs.existsSync(source)) {
    let old;
    try { old = normalizeRegistry(read(source)); }
    catch (error) { if (file || source === registryFile(systemIndexRoot(home))) throw error; else continue; }
    Object.assign(value.services, old.services);
    Object.assign(value.projects, old.projects);
  }
  return value;
}
function projectMetadataFile(workspace, home = os.homedir()) {
  return path.join(systemIndexRoot(home), 'projects', keyOf(workspace), 'project.json');
}
function register(root, workspaces = [], { file, home, cacheRoot } = {}) {
  if (!file && !home && process.env.NODE_TEST_CONTEXT) return null;
  const target = path.resolve(file || registryFile(systemIndexRoot(home))), resolved = path.resolve(root), now = new Date().toISOString();
  // Previous implementation: load only the selected registry file.
  // [AI-added] 2026-09-24 13:24: Preserve existing AppData catalog entries on the first home-index write.
  const value = mergedRegistry(file, home, cacheRoot);
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
  if (!file) for (const project of Object.values(value.projects)) atomic(projectMetadataFile(project.workspace, home), { version: 1, ...project });
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
function discover(currentRoot, { file, home, cacheRoot } = {}) {
  const roots = new Map(), add = (root, registered = {}) => {
    if (typeof root !== 'string' || !path.isAbsolute(root)) return false;
    const resolved = path.resolve(root), key = pathKey(resolved);
    if (roots.has(key)) return false;
    if (!fs.existsSync(path.join(resolved, 'state.json')) && !fs.existsSync(path.join(resolved, 'config.json'))) return false;
    roots.set(key, { key: keyOf(resolved), root: resolved, workspaces: registered.workspaces || [], registeredAt: registered.registeredAt, seenAt: registered.seenAt }); return true;
  };
  add(path.resolve(currentRoot));
  add(legacyDataRoot(home));
  // [AI-added] 2026-09-17 11:46
  const targets = registrySources(file, home, cacheRoot);
  // [AI-added] 2026-09-24 13:28: Explicit test roots are safe to inspect without touching the real user index.
  for (const target of targets) if ((file || home || cacheRoot || !process.env.NODE_TEST_CONTEXT) && fs.existsSync(target)) {
    try {
      const value = normalizeRegistry(read(target));
      for (const entry of Object.values(value.services)) add(entry.root, entry);
      for (const entry of Object.values(value.projects)) add(entry.dataRoot, { workspaces: [entry.workspace], registeredAt: entry.registeredAt, seenAt: entry.seenAt });
    } catch { /* A damaged optional index must not hide the current service. */ }
  }
  // Known service states reveal their workspaces. This bootstraps sibling project roots
  // created before the registry existed without scanning arbitrary user directories.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const entry of [...roots.values()]) {
      try {
        const state = stateAt(entry.root), workspaces = [...new Set([...entry.workspaces, ...workspacesOf(state)])]; entry.workspaces = workspaces;
        // [AI-added] 2026-09-17 11:46
        for (const workspace of workspaces) {
          changed = add(projectDataRoot(workspace), { workspaces: [workspace] }) || changed;
          changed = add(legacyProjectDataRoot(workspace), { workspaces: [workspace] }) || changed;
        }
        const connections = path.join(entry.root, 'connections');
        for (const name of fs.existsSync(connections) ? fs.readdirSync(connections) : []) {
          if (!name.endsWith('.json')) continue;
          try { changed = add(read(path.join(connections, name)).data) || changed; } catch { /* Ignore stale descriptors. */ }
        }
      } catch { /* Keep the service entry visible even if its state is unavailable. */ }
    }
    if (!changed) break;
  }
  return [...roots.values()].map(entry => ({ ...entry, online: online(entry.root), current: pathKey(entry.root) === pathKey(currentRoot) }));
}
// [AI-added] 2026-09-17 13:54
function catalog({ file, home, cacheRoot } = {}) {
  const entries = new Map(), put = input => {
    if (!input || typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace) || typeof input.dataRoot !== 'string' || !path.isAbsolute(input.dataRoot)) return;
    const workspace = path.resolve(input.workspace), dataRoot = path.resolve(input.dataRoot), key = keyOf(workspace), old = entries.get(key) || {};
    entries.set(key, { key, projectId: input.projectId || old.projectId, workspace, dataRoot, registeredAt: input.registeredAt || old.registeredAt, seenAt: input.seenAt || old.seenAt,
      workspaceExists: fs.existsSync(workspace), dataExists: fs.existsSync(path.join(dataRoot, 'config.json')), online: online(dataRoot) });
  };
  const targets = registrySources(file, home, cacheRoot);
  for (const target of targets) if ((file || home || cacheRoot || !process.env.NODE_TEST_CONTEXT) && fs.existsSync(target)) try {
    const value = normalizeRegistry(read(target));
    for (const entry of Object.values(value.projects)) put(entry);
    for (const service of Object.values(value.services)) for (const workspace of service.workspaces || []) put({ workspace, dataRoot: service.root, registeredAt: service.registeredAt, seenAt: service.seenAt });
  } catch { /* A corrupt optional catalog is ignored; verified service state may still recover entries. */ }
  for (const service of discover(legacyDataRoot(home), { file, home, cacheRoot })) try {
    const state = stateAt(service.root);
    for (const project of Object.values(state?.projects || {})) put({ projectId: project.id, workspace: project.workspace, dataRoot: service.root, registeredAt: service.registeredAt, seenAt: service.seenAt });
  } catch { /* Keep only validated catalog metadata for an unavailable service. */ }
  return [...entries.values()].sort((a, b) => (b.seenAt || '').localeCompare(a.seenAt || '') || a.workspace.localeCompare(b.workspace));
}
// [AI-added] 2026-09-19: Operator-initiated cleanup of stale catalog index entries.
// Removes registry records for workspaces that no longer exist on disk; project state
// and runtime data are never touched, and a service re-registers its workspaces the
// next time it starts. Entries whose service data still exists or whose service is
// online are reported as kept instead of being removed.
function pruneInvalid({ file, home, cacheRoot } = {}) {
  // Previous implementation: prune every historical index in place.
  // [AI-added] 2026-09-24 13:24: Write pruning results only to the canonical index.
  const targets = [path.resolve(file || registryFile(systemIndexRoot(home)))];
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
  // [AI-added] 2026-09-24 13:31: Pruning also upgrades an old-only catalog into the home index.
  for (const target of targets) if ((file || home || cacheRoot || !process.env.NODE_TEST_CONTEXT) && registrySources(file, home, cacheRoot).some(source => fs.existsSync(source))) {
    let value;
    try { value = mergedRegistry(file, home, cacheRoot); } catch { /* A corrupt optional index is skipped, never rewritten blind. */ continue; }
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
    if (changed || !fs.existsSync(target)) atomic(target, { version: 2, services, projects });
    // [AI-added] 2026-09-24 13:31: An index upgraded by pruning also receives its project folders.
    if (!file) for (const entry of Object.values(projects)) atomic(projectMetadataFile(entry.workspace, home), { version: 1, ...entry });
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
module.exports = { systemCacheRoot, systemIndexRoot, legacyCacheRegistryFile, registryFile, legacyRegistryFile, projectMetadataFile, keyOf, pathKey, stateAt, workspacesOf, register, tryRegister, online, discover, catalog, pruneInvalid };
