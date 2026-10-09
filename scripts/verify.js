'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { install, PLATFORMS } = require('./install');
const tempBase = path.resolve(__dirname, '../tmp');
fs.mkdirSync(tempBase, { recursive: true });
const temp = fs.mkdtempSync(path.join(tempBase, 'task-dispatch-test-'));
process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));
const home = path.join(temp, 'test home');
const root = path.join(temp, 'source');
fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
fs.mkdirSync(path.join(root, 'skills/task-dispatch'), { recursive: true });
fs.cpSync(path.resolve(__dirname, '../qoder-app-plugin'), path.join(root, 'qoder-app-plugin'), { recursive: true });
fs.writeFileSync(path.join(root, '.codex-plugin/plugin.json'), JSON.stringify({ version: '0.1.0' }));
const source = path.join(root, 'skills/task-dispatch/SKILL.md');
// [AI-added] 2026-09-14 17:19
/* Previous fixture:
fs.writeFileSync(source, 'version one');
*/
fs.writeFileSync(source, '---\nname: task-dispatch\ndescription: verification fixture\n---\n\nversion one');
const options = { platforms: Object.keys(PLATFORMS), home, root };
assert.deepEqual(Object.keys(PLATFORMS), ['codex', 'mimo', 'qoder', 'qodercn', 'opencode']);
install({ ...options, dryRun: true });
assert.equal(fs.existsSync(home), false);
install(options);
assert.ok(install(options).every(p => p.writes.length === 0));
// [AI-added] 2026-09-14 17:19
fs.writeFileSync(source, '---\nname: task-dispatch\ndescription: verification fixture\n---\n\nversion two');
install(options);
const target = path.join(home, '.codex/skills/task-dispatch/SKILL.md');
// [AI-added] 2026-09-14 17:19
assert.match(fs.readFileSync(target, 'utf8'), /version two$/);
fs.writeFileSync(target, 'my custom edits');
assert.throws(() => install(options), /Local file conflict/);
assert.equal(fs.readFileSync(target, 'utf8'), 'my custom edits');
assert.throws(() => install({ ...options, platforms: ['../../bad'] }), /valid platforms/);
for (const retired of ['trae', 'claude-code', 'workbuddy', 'codearts', 'codeartsdoer', 'vscode', 'qoderwork']) {
  assert.throws(() => install({ ...options, platforms: [retired] }), /valid platforms/);
}
const fresh = path.join(temp, 'real package home');
install({ platforms: ['codex'], home: fresh });
assert.ok(fs.existsSync(path.join(fresh, '.codex/skills/task-dispatch/references/handoff.md')));
// [AI-added] 2026-09-14 17:19
const mimo = path.join(temp, 'mimo home');
install({ platforms: ['mimo'], home: mimo });
const mimoSkill = path.join(mimo, '.config/mimocode/skills/task-dispatch/SKILL.md');
assert.match(fs.readFileSync(mimoSkill, 'utf8'), /^---\r?\nname:\s*task-dispatch\r?\ndescription:\s*\S/);
const invalidRoot = path.join(temp, 'invalid yaml source');
fs.mkdirSync(path.join(invalidRoot, '.codex-plugin'), { recursive: true });
fs.mkdirSync(path.join(invalidRoot, 'skills/task-dispatch'), { recursive: true });
fs.writeFileSync(path.join(invalidRoot, '.codex-plugin/plugin.json'), JSON.stringify({ version: '0.4.1' }));
fs.writeFileSync(path.join(invalidRoot, 'skills/task-dispatch/SKILL.md'), '# no yaml frontmatter');
assert.throws(() => install({ platforms: ['mimo'], home: path.join(temp, 'bad mimo'), root: invalidRoot }), /YAML frontmatter/);
console.log('PASS: preview, all adapters, repeat install, upgrade, conflict preservation, invalid platform, real package.');
// Restore the file the conflict case above edited, then prove a platform-wide
// install still settles at zero writes with the Qoder bridge in place.
fs.copyFileSync(source, target);
assert.ok(install(options).every(p => p.writes.length === 0));
for (const config of ['.qoder', '.qoder-cn']) {
  const bridge = path.join(home, config, 'app/dev-extensions/task-dispatch-bridge');
  assert.ok(fs.existsSync(path.join(bridge, '.qoder-app-plugin/plugin.json')));
  assert.ok(fs.existsSync(path.join(bridge, 'dist/node/main.cjs')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(bridge, 'bridge-config.json'), 'utf8')).descriptorPath, path.join(home, config, 'task-dispatch-bridge.json'));
  assert.equal(fs.existsSync(path.join(home, config, 'skills/task-dispatch/qoder-hook.cjs')), false);
}
console.log('PASS: Qoder/QoderCN direct bridge payload and repeat install.');
// [AI-added] 2026-09-16: Verify Qoder payload and reject malformed skills before writes.
const qoderHome = path.join(temp, 'qoder package home');
install({ platforms: ['qoder'], home: qoderHome });
const qoderTarget = path.join(qoderHome, '.qoder/skills/task-dispatch');
assert.ok(fs.existsSync(path.join(qoderTarget, 'SKILL.md')));
assert.ok(fs.existsSync(path.join(qoderTarget, 'references/handoff.md')));
// [AI-added] 2026-09-16 16:00
const runtimeLink=JSON.parse(fs.readFileSync(path.join(qoderTarget, 'runtime-link.json'), 'utf8'));
assert.equal(runtimeLink.client, path.resolve(__dirname, '../runtime/desktop-client.cjs'));
// [AI-added] 2026-09-17 11:46
assert.equal(runtimeLink.version,3);
assert.equal(runtimeLink.dataMode,'workspace-local-v2');
assert.equal(runtimeLink.data,undefined);
assert.ok(install({ platforms: ['qoder'], home: qoderHome }).every(p => p.writes.length === 0));
for (const [index, content] of ['# no frontmatter', '---\nname: task-dispatch\n---\n', '---\ndescription: fixture\n---\n'].entries()) {
  fs.writeFileSync(path.join(invalidRoot, 'skills/task-dispatch/SKILL.md'), content);
  for (const platform of ['qoder', 'qodercn', 'opencode']) {
    const invalidHome = path.join(temp, `invalid-${platform}-${index}`);
    assert.throws(() => install({ platforms: [platform], home: invalidHome, root: invalidRoot }), /(?:Qoder|OpenCode).*YAML frontmatter/);
    assert.equal(fs.existsSync(invalidHome), false);
  }
}
console.log('PASS: Qoder payload, runtime link, repeat install and frontmatter preflight.');
const opencodeHome = path.join(temp, 'opencode package home');
const [opencodePlan] = install({ platforms: ['opencode'], home: opencodeHome });
const opencodeTarget = path.join(opencodeHome, '.config/opencode/skills/task-dispatch');
assert.equal(opencodePlan.target, opencodeTarget);
assert.ok(fs.existsSync(path.join(opencodeTarget, 'SKILL.md')));
assert.ok(fs.existsSync(path.join(opencodeTarget, 'references/opencode.md')));
assert.equal(JSON.parse(fs.readFileSync(path.join(opencodeTarget, 'runtime-link.json'), 'utf8')).client, path.resolve(__dirname, '../runtime/desktop-client.cjs'));
assert.equal(fs.existsSync(path.join(opencodeHome, '.config/opencode/opencode.json')), false);
assert.ok(install({ platforms: ['opencode'], home: opencodeHome }).every(p => p.writes.length === 0));
fs.writeFileSync(path.join(opencodeTarget, 'SKILL.md'), 'user edits');
assert.throws(() => install({ platforms: ['opencode'], home: opencodeHome }), /Local file conflict/);
console.log('PASS: OpenCode installation, runtime link, no configuration edits, repeat install and conflict preservation.');
