// [AI-added] 2026-09-12 11:00
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sha, atomic, read, id } = require('./storage.cjs');
// [AI-added] 2026-09-24 14:01: Freeze workspace ignore rules in each snapshot policy.
const taskignore = require('./taskignore.cjs');
// [AI-added] 2026-09-14 19:48
const EXCLUDED = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
// [AI-added] 2026-09-17 11:46
const DEFAULT_EXCLUDE = ['tmp/', '.task-dispatch/runtime/'];
// [AI-added] 2026-09-20: Working-directory dot folders are IDE/agent caches (.workbuddy-ai,
// .zcode, .trae, .claude, .godot, ...). They churn outside task scope and must never enter a
// snapshot or count as worker drift. .task-dispatch holds authoritative plans and
// .dispatch-evidence holds generated review evidence, so both stay tracked. This is a scope
// rule is frozen with the current snapshot policy.
// [AI-added] 2026-09-24 14:02: The rule file itself is tracked for drift and integrity checks.
const DOT_DIR_EXCEPTIONS = new Set(['.task-dispatch', '.dispatch-evidence', '.taskignore']);
const dotDirectory = name => name.startsWith('.') && !DOT_DIR_EXCEPTIONS.has(name);
function policy(input = {}) {
  const version = 2;
  if (input.version !== undefined && input.version !== 2) throw Error('Unsupported snapshot policy version');
  const configured = input.exclude || [];
  if (!Array.isArray(configured)) throw Error('snapshot.exclude must be an array');
  const exclude = [...new Set([...DEFAULT_EXCLUDE, ...configured])].sort();
  if (exclude.length) validatePaths(exclude, { allowReservedNames: true });
  if (exclude.some(p => p === '.dispatch-evidence/' || p.startsWith('.dispatch-evidence/'))) throw Error('Cannot exclude review evidence');
  // [AI-added] 2026-09-24 14:31: The control file must stay visible even with explicit exclusions.
  if (exclude.some(p => p === taskignore.FILE || p.startsWith(taskignore.FILE + '/'))) throw Error('Cannot exclude .taskignore');
  const maxTotalBytes = input.maxTotalBytes ?? 256 * 1024 * 1024;
  const maxFileBytes = input.maxFileBytes ?? 32 * 1024 * 1024;
  for (const n of [maxTotalBytes, maxFileBytes]) if (!Number.isSafeInteger(n) || n < 1) throw Error('Snapshot limits must be positive safe integers');
  const value = { version, exclude, maxTotalBytes, maxFileBytes };
  if (Object.hasOwn(input, 'taskIgnoreRules')) {
    if (!Array.isArray(input.taskIgnoreRules) || input.taskIgnoreRules.length > 1000) throw Error('Invalid taskIgnoreRules');
    input.taskIgnoreRules.forEach(taskignore.compile);
    value.taskIgnoreRules = [...input.taskIgnoreRules];
  }
  return value;
}
// [AI-added] 2026-09-24 14:01: Resolve once for a new attempt; stored attempt policies remain fixed.
function workspacePolicy(root, input) {
  const config = policy(input);
  if (!Object.hasOwn(config, 'taskIgnoreRules')) config.taskIgnoreRules = taskignore.readRules(root);
  return config;
}
function frozenPolicy(input) {
  if (!input || input.version !== 2 || !Array.isArray(input.taskIgnoreRules)) throw Error('Stored snapshot requires version-2 frozen taskIgnoreRules');
  return policy(input);
}
function manifest(root, input) {
  // [AI-added] 2026-09-24 14:01: Direct manifest callers also honor the workspace rule file.
  const config = workspacePolicy(root, input);
  const taskExcluded = taskignore.matcher(config.taskIgnoreRules || []);
  const result = Object.create(null); let total = 0;
  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      if (EXCLUDED.has(name) || (prefix === '' && dotDirectory(name))) continue;
      // Extended Windows paths inspect the real file instead of resolving NUL/CON devices.
      const file = path.toNamespacedPath(path.join(dir, name)), rel = prefix + name, st = fs.lstatSync(file);
      // [AI-added] 2026-09-24 14:01: Exclude before sizing or reading large files.
      if (allowed(rel, config.exclude) || (st.isDirectory() && config.exclude.includes(rel + '/')) || taskExcluded(rel, st.isDirectory())) continue;
      if (st.isSymbolicLink()) throw Error('Snapshot refuses symlink/junction: ' + rel);
      if (st.isDirectory()) walk(file, rel + '/');
      else if (st.isFile()) {
        total += st.size;
        if (total > config.maxTotalBytes || st.size > config.maxFileBytes) throw Error(`Snapshot limit exceeded at ${rel}: file=${st.size} bytes (limit ${config.maxFileBytes}), accumulated=${total} bytes (limit ${config.maxTotalBytes}); configure project snapshot policy, no files silently omitted`);
        result[rel] = { hash: sha(fs.readFileSync(file)), mode: st.mode & 0o777 };
      } else throw Error('Unsupported file: ' + rel);
    }
  }
  walk(root); return result;
}
function snapshot(root, base, input, beforeCopy) {
  // [AI-added] 2026-09-24 14:01: Both scans and the stored artifact use the same rules.
  const config = workspacePolicy(root, input);
  const files = manifest(root, config);
  assertNoReservedNames(files);
  const key = id(), dir = path.join(base, key), tree = path.join(dir, 'tree');
  beforeCopy?.(Object.keys(files).reduce((n,f) => n + fs.statSync(path.join(root,f)).size,0));
  fs.mkdirSync(tree, { recursive: true });
  for (const [name, info] of Object.entries(files)) {
    const dest = path.join(tree, name); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, name), dest); fs.chmodSync(dest, info.mode);
    if (sha(fs.readFileSync(dest)) !== info.hash) throw Error('Workspace changed while snapshotting');
  }
  if (sha(JSON.stringify(manifest(root, config))) !== sha(JSON.stringify(files))) throw Error('Workspace changed while snapshotting');
  const value = { id: key, hash: sha(JSON.stringify(files)), monitoredHash: monitoredHash(files), policy: config, policyHash: sha(JSON.stringify(config)), files };
  atomic(path.join(dir, 'manifest.json'), value);
  return value;
}
function difference(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(k => !ignored(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}
function monitored(files) {
  return Object.fromEntries(Object.entries(files || {}).filter(([name]) => !ignored(name)));
}
function monitoredHash(files) { return sha(JSON.stringify(monitored(files))); }
function allowed(name, paths) { return paths.some(p => name === p || (p.endsWith('/') && name.startsWith(p))); }
// [AI-added] 2026-09-22 09:20: Shared, content-free diagnostics for preflight and receipts.
function changes(before,after){
  return difference(before,after).map(name=>({path:name,kind:!Object.hasOwn(before,name)?'added':!Object.hasOwn(after,name)?'deleted':'modified'}));
}
function reservedPath(name){return name.split('/').some(part=>/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part.replace(/[ .]+$/,'')));}
function reservedNames(files){return Object.keys(files).filter(reservedPath);}
function assertNoReservedNames(files){
  const names=reservedNames(files);
  if(names.length)throw Error('Windows reserved file names are forbidden: '+names.slice(0,20).join(', ')+'; in Bash discard output with >/dev/null 2>&1, in PowerShell use *> $null');
}
function overlapsPath(a, b) { return a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b)); }
function excludedTaskPaths(paths, input, root) {
  // [AI-added] 2026-09-24 14:01: Reject individually named deliverables hidden by .taskignore.
  const config = root ? workspacePolicy(root, input) : policy(input);
  const taskExcluded = taskignore.matcher(config.taskIgnoreRules || []);
  // Deliverables inside a top-level dot folder are never reviewed, so flag them like an
  // explicit exclusion instead of letting the task pass registration and silently deliver nothing.
  return paths.filter(p => dotDirectory(String(p).split('/')[0]) && p !== taskignore.FILE || config.exclude.some(excluded => overlapsPath(p, excluded)) || taskExcluded(p.replace(/\/$/, ''), p.endsWith('/')));
}
// [AI-added] 2026-09-14 20:03
function ignored(name, input = {}) {
  const parts = name.split('/');
  // Top-level IDE/agent cache folders are unmonitored; nested dot files remain business data.
  if (parts.some(part => EXCLUDED.has(part)) || dotDirectory(parts[0])) return true;
  // [AI-added] 2026-09-24 14:01: Diff and scope recovery use the frozen ignore rules.
  const config = policy(input);
  return allowed(name, config.exclude) || taskignore.matcher(config.taskIgnoreRules || [])(name);
}
function validatePaths(paths, { allowReservedNames = false } = {}) {
  if (!Array.isArray(paths) || !paths.length) throw Error('allowedPaths must be nonempty');
  for (const p of paths) {
    if (typeof p !== 'string' || !p || p.includes('\\') || p.startsWith('/') || p.includes(':') || p.split('/').some(x => x === '..' || x === '.') || p.includes('*') || p.split('/').some(x => EXCLUDED.has(x))) throw Error('Use explicit relative files or directory/ prefixes: ' + p);
    if (!allowReservedNames) assertNoReservedNames({ [p]: null });
  }
}
function loadSnapshot(base, key) {
  const value = read(path.join(base, key, 'manifest.json'));
  frozenPolicy(value.policy);
  if (typeof value.monitoredHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.monitoredHash)) throw Error('Stored snapshot requires monitoredHash');
  if (value.hash !== sha(JSON.stringify(value.files)) || value.monitoredHash !== monitoredHash(value.files) || value.policyHash !== sha(JSON.stringify(value.policy))) throw Error('Stored snapshot integrity mismatch');
  return value;
}
function reviewCopy(base, candidate, dest, input) {
  const source = path.join(base, candidate, 'tree');
  assertNoReservedNames(loadSnapshot(base, candidate).files);
  fs.cpSync(source, dest, { recursive: true, errorOnExist: true, force: false, filter: file => {
    assertNoReservedNames({ [path.relative(source, file).split(path.sep).join('/')]: null });
    return true;
  } });
  return manifest(dest, input);
}
// [AI-added] 2026-09-14 20:03
module.exports = { policy, frozenPolicy, workspacePolicy, manifest, snapshot, difference, changes, reservedNames, assertNoReservedNames, allowed, ignored, monitored, monitoredHash, validatePaths, excludedTaskPaths, loadSnapshot, reviewCopy, EXCLUDED, DEFAULT_EXCLUDE, DOT_DIR_EXCEPTIONS, dotDirectory };
