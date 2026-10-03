// [AI-added] 2026-09-16 16:00
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { workspaceKey } = require('./storage.cjs');

function dataArgument(args = []) {
  const index = args.indexOf('--data');
  if (index < 0) return null;
  if (!args[index + 1]) throw Error('--data requires directory');
  return path.resolve(args[index + 1]);
}

function workspaceArgument(args = []) {
  const index = args.indexOf('--workspace');
  if (index < 0) return null;
  if (!args[index + 1]) throw Error('--workspace requires directory');
  return path.resolve(args[index + 1]);
}

function legacyDataRoot(home = os.homedir()) {
  return path.resolve(home, '.task-dispatch-service');
}

// [AI-added] 2026-09-17 11:46
function legacyProjectDataRoot(workspace) {
  const resolved = path.resolve(workspace);
  return path.join(path.dirname(resolved), `.${workspaceKey(resolved)}.task-dispatch-service`);
}

// [AI-added] 2026-09-17 11:46
function projectControlRoot(workspace) {
  return path.join(path.resolve(workspace), '.task-dispatch');
}

function projectDataRoot(workspace) {
  const resolved = path.resolve(workspace);
  return path.join(projectControlRoot(resolved), 'runtime', workspaceKey(resolved));
}

// [AI-added] 2026-09-17 11:46
function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

// [AI-added] 2026-09-17 11:46
function ensureProjectLayout(workspace, root = projectDataRoot(workspace)) {
  const resolvedWorkspace = fs.realpathSync(path.resolve(workspace));
  const expected = projectDataRoot(resolvedWorkspace), target = path.resolve(root);
  if (target !== expected) return target;
  const control = projectControlRoot(resolvedWorkspace), ignore = path.join(control, '.gitignore');
  if (fs.existsSync(control) && fs.lstatSync(control).isSymbolicLink()) throw Error('Project dispatch directory cannot be a symlink/junction');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  let text = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  const lines = text.split(/\r?\n/).map(value => value.trim());
  if (!lines.includes('runtime/')) {
    text = text.replace(/\s*$/, '') + (text.trim() ? '\n' : '') + '# [AI-added] task-dispatch private runtime\nruntime/\n';
    fs.writeFileSync(ignore, text, { encoding: 'utf8', mode: 0o600 });
  }
  return target;
}

function credentialData(file) {
  if (!file || !fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof value.data !== 'string' || !value.data) throw Error('Credential data directory is missing');
  return path.resolve(value.data);
}

// [AI-added] 2026-09-24 11:16: A migrated project must not silently resurrect the old
// user-home service when a saved invitation still carries its historical --data path.
function guardMigratedLegacyRoot(root, workspace, home = os.homedir()) {
  if (!workspace) return root;
  const same = (left, right) => process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
  if (!same(root, legacyDataRoot(home))) return root;
  const target = projectDataRoot(workspace);
  if (fs.existsSync(path.join(target, 'config.json')) && fs.existsSync(path.join(target, 'state.json'))) {
    throw Error('Project service has moved to ' + target + '; use its current credential and --data path instead of the legacy user-home service');
  }
  // [AI-added] 2026-09-24 13:30: Do not create a new service inside the reserved metadata index.
  if (!fs.existsSync(path.join(root, 'config.json')) && !fs.existsSync(path.join(root, 'state.json'))) {
    throw Error('The user-home .task-dispatch-service directory is reserved for the system index; use the workspace service at ' + target);
  }
  return root;
}

function resolveDataRoot({ args = [], data, credentialFile, workspace, home } = {}) {
  const explicit = dataArgument(args);
  // Previous implementation: if (explicit) return explicit;
  // Previous implementation: if (data) return path.resolve(data);
  // [AI-added] 2026-09-24 11:16: Reject stale explicit roots after migration.
  if (explicit) return guardMigratedLegacyRoot(explicit, workspace, home);
  if (data) return guardMigratedLegacyRoot(path.resolve(data), workspace, home);
  const saved = credentialData(credentialFile);
  // Previous implementation: if (saved) return saved;
  // [AI-added] 2026-09-24 11:16: A saved credential can also point at the retired root.
  if (saved) return guardMigratedLegacyRoot(saved, workspace, home);
  if (workspace) return projectDataRoot(workspace);
  return legacyDataRoot(home);
}

// [AI-added] 2026-09-17 11:46
module.exports = { dataArgument, workspaceArgument, legacyDataRoot, legacyProjectDataRoot, projectControlRoot, projectDataRoot, inside, ensureProjectLayout, credentialData, resolveDataRoot };
