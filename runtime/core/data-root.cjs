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

function systemIndexRoot(home = os.homedir()) {
  return path.resolve(home, '.task-dispatch-service');
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

function assertServiceRoot(root, home) {
  const target = path.resolve(root);
  if (inside(systemIndexRoot(home), target)) throw Error('The user-home .task-dispatch-service directory is reserved for the system index');
  return target;
}

function resolveDataRoot({ args = [], data, credentialFile, workspace, home } = {}) {
  const root = dataArgument(args) || data || credentialData(credentialFile) || (workspace && projectDataRoot(workspace));
  if (!root) throw Error('A workspace, credential or explicit --data directory is required');
  return assertServiceRoot(root, home);
}

// [AI-added] 2026-09-17 11:46
module.exports = { dataArgument, workspaceArgument, systemIndexRoot, assertServiceRoot, projectControlRoot, projectDataRoot, inside, ensureProjectLayout, credentialData, resolveDataRoot };
