'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const readline = require('node:readline/promises');
const ROOT = path.resolve(__dirname, '..');
const PLATFORMS = {
  // task-dispatch is installed only on hosts allowed to own the brain role.
  codex: '.codex/skills',
  // [AI-added] 2026-09-14 17:19
  mimo: '.config/mimocode/skills',
  // [AI-added] 2026-09-15 19:05
  qoder: '.qoder/skills',
  qodercn: '.qoder-cn/skills',
  opencode: '.config/opencode/skills'
};
const QODER_HOOK_PREFIX = 'task-dispatch-qoder';
const QODER_BRIDGE_RELATIVE = 'app/dev-extensions/task-dispatch-bridge';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}
function noLinks(target) {
  for (let p = target; ; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw Error('Symbolic link/junction not supported: ' + p);
    if (p === path.dirname(p)) break;
  }
}
function files(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.isSymbolicLink()) throw Error('Unexpected source link: ' + e.name);
    const name = prefix + e.name;
    return e.isDirectory() ? files(path.join(dir, e.name), name + '/') : [name];
  });
}
// [AI-added] 2026-09-14 17:19
function validateYamlSkill(data, platform = 'MiMo') {
  const text = data.toString('utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw Error(platform + ' requires YAML frontmatter in SKILL.md');
  for (const field of ['name', 'description']) {
    if (!new RegExp('^' + field + ':\\s*\\S', 'm').test(match[1])) throw Error(platform + ' YAML frontmatter requires ' + field);
  }
}
// [AI-added] 2026-09-15 19:05
// Qoder handlers are declared as exec-form argv so no shell quoting is involved,
// and every handler this installer owns is named with a fixed prefix.
function ownedQoderHandler(value) {
  return !!value && typeof value === 'object' && typeof value.name === 'string' && value.name.startsWith(QODER_HOOK_PREFIX);
}
// [AI-added] 2026-09-15 19:05
// Only handlers carrying our own name prefix are touched. Any user-edited handler
// we previously installed, and any group mixing our handler with a foreign one, is
// reported as a conflict instead of being overwritten.
function planQoderSettings({ id, base, target, previous, writes }) {
  const configDir = path.resolve(base, path.dirname(PLATFORMS[id]));
  const settingsFile = path.resolve(base, path.dirname(PLATFORMS[id]), 'settings.json');
  if (!inside(base, settingsFile)) throw Error('Invalid Qoder settings path');
  noLinks(settingsFile);
  let settings = {};
  if (fs.existsSync(settingsFile)) {
    try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { throw Error('Invalid Qoder settings file; fix or move it before retrying: ' + settingsFile); }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('Invalid Qoder settings file; fix or move it before retrying: ' + settingsFile);
  }
  const conflict = name => Error('Local file conflict; preserve or move it before retrying: ' + settingsFile + (name ? ' (' + name + ')' : ''));
  const current = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {};
  const recorded = previous && previous.hooks && previous.hooks.file === settingsFile ? previous.hooks.entries || {} : {};
  const desired = [{
    event: 'UserPromptSubmit',
    handler: {
      type: 'command', command: 'node',
      args: [path.join(target, 'qoder-invitation-hook.cjs'), '--config-dir', configDir],
      name: 'task-dispatch-qoder-invitation', timeout: 2
    }
  }];
  const byName = new Map(desired.map(item => [item.handler.name, item]));
  const prior = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
  const next = {};
  const settled = new Set();
  for (const [event, value] of Object.entries(current)) {
    if (!Array.isArray(value)) { next[event] = value; continue; }
    const groups = [];
    let dropped = false;
    for (const group of value) {
      const handlers = group && typeof group === 'object' && Array.isArray(group.hooks) ? group.hooks : null;
      const ours = handlers ? handlers.filter(ownedQoderHandler) : [];
      if (!ours.length) { groups.push(group); continue; }
      if (handlers.length !== ours.length) throw conflict(ours[0].name);
      const wanted = byName.get(ours[0].name);
      const digest = hash(JSON.stringify(ours[0]));
      // A handler we installed before but no longer register is dropped only while
      // it still matches the receipt, so a user edit can never be discarded.
      if (!wanted || wanted.event !== event) { if (recorded[ours[0].name] !== digest) throw conflict(ours[0].name); dropped = true; continue; }
      const known = recorded[ours[0].name];
      const wantedDigest = hash(JSON.stringify(wanted.handler));
      if (known === undefined ? digest !== wantedDigest : known !== digest) throw conflict(ours[0].name);
      settled.add(event);
      // An unchanged handler keeps its original group object, so a repeat install
      // produces byte-identical settings and performs no write at all.
      groups.push(digest === wantedDigest ? group : { ...group, hooks: [wanted.handler] });
    }
    if (groups.length || !dropped) next[event] = groups;
  }
  for (const item of desired) {
    if (settled.has(item.event)) continue;
    const groups = Array.isArray(next[item.event]) ? next[item.event] : [];
    next[item.event] = [...groups, { hooks: [item.handler] }];
  }
  const merged = { ...settings, hooks: next };
  const text = JSON.stringify(merged, null, 2) + '\n';
  if (prior !== text) writes.push([settingsFile, Buffer.from(text)]);
  return { file: settingsFile, entries: Object.fromEntries(desired.map(item => [item.handler.name, hash(JSON.stringify(item.handler))])) };
}
function planQoderBridge({ id, base, root, previous, writes, deletes }) {
  const configDir = path.resolve(base, path.dirname(PLATFORMS[id]));
  const target = path.join(configDir, QODER_BRIDGE_RELATIVE);
  const source = path.join(root, 'qoder-app-plugin', 'task-dispatch-bridge');
  const payload = Object.fromEntries(files(source).map(file => [file, fs.readFileSync(path.join(source, file))]));
  payload['bridge-config.json'] = Buffer.from(JSON.stringify({ version: 1, descriptorPath: path.join(configDir, 'task-dispatch-bridge.json') }, null, 2) + '\n');
  const recorded = previous?.bridge?.hashes || {};
  for (const [file, data] of Object.entries(payload)) {
    const destination = path.join(target, file);
    if (!inside(base, destination)) throw Error('Invalid Qoder bridge path');
    noLinks(destination);
    if (fs.existsSync(destination)) {
      const current = hash(fs.readFileSync(destination));
      if (current === hash(data)) continue;
      if (recorded[file] !== current) throw Error('Local file conflict; preserve or move it before retrying: ' + destination);
    }
    writes.push([destination, data]);
  }
  for (const [file, digest] of Object.entries(recorded)) if (!Object.hasOwn(payload, file)) {
    const destination = path.join(target, file);
    if (!fs.existsSync(destination)) continue;
    if (hash(fs.readFileSync(destination)) !== digest) throw Error('Local file conflict; preserve or move it before retrying: ' + destination);
    deletes.push(destination);
  }
  return { target, hashes: Object.fromEntries(Object.entries(payload).map(([file, data]) => [file, hash(data)])) };
}
function enableQoderDevelopmentPlugins() {
  process.env.QODER_APP_PLUGIN_ALLOW_UNVERIFIED = 'true';
  if (process.platform === 'win32') execFileSync('setx.exe', ['QODER_APP_PLUGIN_ALLOW_UNVERIFIED', 'true'], { windowsHide: true, stdio: 'ignore' });
}
function install({ platforms, home = os.homedir(), dryRun = false, root = ROOT }) {
  const ids = [...new Set(platforms.flatMap(id => id === 'all' ? Object.keys(PLATFORMS) : [id === 'qoder-cn' ? 'qodercn' : id]))];
  if (!ids.length || ids.some(id => !Object.hasOwn(PLATFORMS, id))) throw Error('Select valid platforms: ' + Object.keys(PLATFORMS).join(', '));
  const source = path.join(root, 'skills', 'task-dispatch');
  const version = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8')).version;
  // [AI-added] 2026-09-14 09:43
const sharedPayload = Object.fromEntries(files(source).map(f => [f, fs.readFileSync(path.join(source, f))]));
  // [AI-added] 2026-09-14 17:19
  if (ids.includes('mimo')) validateYamlSkill(sharedPayload['SKILL.md']);
  // [AI-added] 2026-09-16: Validate both Qoder products before planning writes.
  for (const id of ['qoder', 'qodercn', 'opencode']) {
    if (ids.includes(id)) validateYamlSkill(sharedPayload['SKILL.md'], id === 'qoder' ? 'Qoder' : id === 'qodercn' ? 'QoderCN' : 'OpenCode');
  }
  const payload = sharedPayload;
  // [AI-added] 2026-09-16 16:00
  // [AI-added] 2026-09-17 11:46
  payload['runtime-link.json'] = Buffer.from(JSON.stringify({ version: 3, client: path.resolve(root, 'runtime/desktop-client.cjs'), dataMode: 'workspace-local-v2' }, null, 2) + '\n');
  // [AI-added] 2026-09-14 09:43
  const plans = ids.map(id => {
    const payload = { ...sharedPayload };
    // [AI-added] 2026-09-16 16:00
    const base = path.resolve(home);
    const target = path.resolve(base, PLATFORMS[id], 'task-dispatch');
    if (!inside(base, target)) throw Error('Invalid target: ' + target);
    noLinks(target);
    const receipt = path.join(target, '.task-dispatch-install.json');
    const previous = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')) : null;
    if (previous && (previous.name !== 'task-dispatch' || typeof previous.hashes !== 'object' || !previous.hashes)) throw Error('Invalid installation receipt: ' + receipt);
    const writes = [], deletes = [];
    for (const [f, data] of Object.entries(payload)) {
      // [AI-added] 2026-09-14 09:43
const dest = path.join(target, f);
      if (!inside(base, dest)) throw Error('Invalid installation path');
      noLinks(dest);
      if (fs.existsSync(dest)) {
        const current = hash(fs.readFileSync(dest));
        if (current === hash(data)) continue;
        if (!previous || current !== previous.hashes[f]) throw Error('Local file conflict; preserve or move it before retrying: ' + dest);
      }
      writes.push([dest, data]);
    }
    for (const [file, digest] of Object.entries(previous?.hashes || {})) if (!Object.hasOwn(payload, file)) {
      const destination = path.join(target, file);
      if (!fs.existsSync(destination)) continue;
      if (hash(fs.readFileSync(destination)) !== digest) throw Error('Local file conflict; preserve or move it before retrying: ' + destination);
      deletes.push(destination);
    }
    // [AI-added] 2026-09-15 19:05
    const hooks = ['qoder', 'qodercn'].includes(id) ? planQoderSettings({ id, base, target, previous, writes }) : null;
    const bridge = ['qoder', 'qodercn'].includes(id) ? planQoderBridge({ id, base, root, previous, writes, deletes }) : null;
    // [AI-added] 2026-09-14 09:43
    const receiptData=Buffer.from(JSON.stringify({name:'task-dispatch',version,hashes:Object.fromEntries(Object.entries(payload).map(([f,d])=>[f,hash(d)])),...(hooks?{hooks}:{}),...(bridge?{bridge}:{})},null,2)+'\n');
    if(!fs.existsSync(receipt)||!fs.readFileSync(receipt).equals(receiptData))writes.push([receipt,receiptData]);
    return { id, target, receipt, writes, deletes, payload, hooks, bridge };
  });
  // Preflight all selected platforms before writing any files.
  for (const plan of plans) {
    console.log(`${dryRun ? '[preview]' : '[install]'} ${plan.id}: ${plan.target} (${plan.writes.length + plan.deletes.length} changed files)`);
    if (dryRun) continue;
    for (const destination of plan.deletes) fs.rmSync(destination, { force: true });
    for (const [dest, data] of plan.writes) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }
  }
  return plans;
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/install.js [all|codex|mimo|qoder|qodercn|opencode] [--dry-run] [--home DIRECTORY]\nNo platform: interactive selection. Default selection: all.\nPlatforms: ' + Object.keys(PLATFORMS).join(', '));
    return;
  }
  let selection, home = os.homedir(), dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--home') {
      home = args[++i];
      if (!home || home.startsWith('--')) throw Error('--home requires a directory');
    } else if (args[i].startsWith('-') || selection) throw Error('Unknown argument: ' + args[i]);
    else selection = args[i];
  }
  if (!selection) {
    if (!process.stdin.isTTY) throw Error('Specify a platform in non-interactive mode, e.g. codex');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('Task Dispatch install/upgrade\n' + Object.keys(PLATFORMS).join(', '));
      selection = (await rl.question('Platforms (comma separated; Enter = all): ')).trim() || 'all';
    } finally { rl.close(); }
  }
  const plans = install({ platforms: selection.split(/[,，\s]+/).filter(Boolean), home, dryRun });
  if (!dryRun && plans.some(plan => ['qoder','qodercn'].includes(plan.id))) enableQoderDevelopmentPlugins();
  console.log(dryRun ? 'Preview complete. No files changed.' : plans.some(plan => ['qoder','qodercn'].includes(plan.id)) ? 'Complete. Restart Qoder once to load the direct wake bridge.' : 'Complete. Start a new conversation in your tool to load the skill.');
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { install, PLATFORMS, enableQoderDevelopmentPlugins };
