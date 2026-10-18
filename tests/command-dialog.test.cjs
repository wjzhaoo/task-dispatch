'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const policy = import('../runtime/console-web/command-policy.mjs');

// Execute the actual dialog controller with a small DOM. Requests, target selection,
// disabled controls and receipt reuse are exercised without a browser dependency.
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.disabled = false; this.hidden = false; this.open = false; this.textContent = ''; this.value = ''; this.dataset = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; if (this.tag === 'select') this.value = nodes[0]?.value || ''; }
  closest() { return this.label ||= new Element('label'); }
  querySelector() { return this.heading ||= new Element('h2'); }
  addEventListener() {}
  removeEventListener() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}
async function harness(request = async () => ({ ok: true })) {
  const controls = ['action', 'worker-id', 'additional', 'retry-mode', 'rebind-mode', 'close-dialog', 'command-cancel', 'execute'];
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) { const element = new Element(['action', 'worker-id', 'retry-mode', 'rebind-mode'].includes(id) ? 'select' : 'div'); element.id = id; elements.set(id, element); }
    return elements.get(id);
  };
  get('command-form').elements = controls.map(get);
  const project = { id: 'p', title: '测试项目', workspace: 'D:/test', tasks: [
    { id: 'T', title: '测试任务', state: 'blocked', attempts: [{ id: 'attempt' }] },
    { id: 'U', title: '其他任务', state: 'ready', attempts: [] }
  ], goals: [{ id: 'G', title: '测试目标' }], connections: [{ binding: 'brain', role: 'brain', clientId: 'original', provider: 'codex' }],
  team: { members: [{ role: 'worker', workerId: 'worker-1', responsibilities: '实现' }] } };
  const owner = { entry: { workspace: project.workspace }, snapshot: { instanceId: 'instance', revision: 3, projects: [project] } };
  const calls = [];
  const source = fs.readFileSync('runtime/console-web/app.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^boot\(\);\r?$/m, '');
  const context = vm.createContext({ ...(await policy), commandTarget: (await import('../runtime/console-web/project-setup.mjs')).commandTarget,
    document: { getElementById: get, createElement: tag => new Element(tag) },
    window: { addEventListener() {} }, structuredClone, crypto, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      const result = await request(body);
      return { ok: true, json: async () => result };
    }
  });
  vm.runInContext(source + '\nrefresh = async () => {}; globalThis.controller = { openCommand, submit: () => document.getElementById("command-form").onsubmit({ preventDefault() {} }), setContext(value) { ctx = value; }, wireCommandDialog };', context);
  context.controller.setContext(owner); context.controller.wireCommandDialog();
  return { ...context.controller, get, owner, project, calls };
}

test('routine clicks execute once without a dialog, reason input or checkbox', async () => {
  const { needsDialog } = await policy;
  for (const action of ['start-work', 'start-goal', 'pause', 'resume', 'reopen-project', 'wake-retry', 'wake-remind', 'rebind-cancel']) assert.equal(needsDialog(action), false, action);
  for (const action of ['pause', 'resume', 'retry', 'wake-remind']) {
    const h = await harness();
    await h.openCommand(action, ['retry', 'wake-remind'].includes(action) ? 'T' : null);
    assert.equal(h.calls.length, 1, action); assert.equal(h.get('command-dialog').open, false, action);
    assert.equal(h.calls[0].confirmed, true); assert.match(h.calls[0].reason, /Web 控制台/);
  }
});

test('a second click while a command is running does not send another command', async () => {
  let release; const response = new Promise(resolve => { release = resolve; });
  const h = await harness(() => response);
  const first = h.openCommand('pause'); await h.openCommand('resume');
  assert.equal(h.calls.length, 1); release({ ok: true }); await first;
});

test('budget and assignment dialogs contain only necessary parameters and close on success', async () => {
  const h = await harness();
  await h.openCommand('task-budget', 'T');
  assert.equal(h.calls.length, 0); assert.equal(h.get('additional').closest().hidden, false);
  assert.equal(h.get('worker-id').disabled, true); h.get('additional').value = '4';
  await h.submit(); assert.equal(h.calls[0].additionalAttempts, 4); assert.equal(h.get('command-dialog').open, false);
  await h.openCommand('assign', 'T');
  assert.equal(h.get('additional').disabled, true); assert.equal(h.get('worker-id').value, 'worker-1');
  await h.submit(); assert.equal(h.calls[1].workerId, 'worker-1'); assert.equal(h.calls[1].taskId, 'T');
});

test('reset loads its full scope automatically and one explicit button confirms stopped execution', async () => {
  const h = await harness(command => command.action === 'lifecycle-preview'
    ? { ok: true, affectedTasks: [{ id: 'T', title: '测试任务', state: 'uncertain' }], requiresStopped: true, message: '重置任务' }
    : { ok: true });
  await h.openCommand('reset-task', 'T');
  assert.equal(h.calls[0].action, 'lifecycle-preview'); assert.equal(h.calls.length, 1);
  assert.match(h.get('execute').textContent, /相关执行已停止/); assert.equal(h.get('execute').disabled, false);
  await h.submit(); const command = h.calls[1];
  assert.equal(command.confirmText, 'T'); assert.equal(command.resetDependents, true); assert.equal(command.confirmedStopped, true);
  assert.equal(command.taskId, 'T'); assert.equal(h.get('command-dialog').open, false);
});

test('uncertain retry and rebind recovery require explicit stopped wording and preserve choices', async () => {
  const h = await harness(); h.project.tasks[0].state = 'uncertain';
  await h.openCommand('retry', 'T'); assert.equal(h.calls.length, 0); assert.match(h.get('execute').textContent, /旧执行已停止/);
  await h.submit(); assert.equal(h.calls[0].confirmedStopped, true);
  await h.openCommand('rebind-invite', null, { binding: 'brain' });
  assert.equal(h.get('rebind-mode').value, 'safe');
  h.get('rebind-mode').value = 'recover'; h.get('rebind-mode').onchange();
  assert.match(h.get('execute').textContent, /旧会话已停止/);
  await h.submit(); assert.equal(h.calls[1].confirmedStopped, true); assert.equal(h.calls[1].clientId, 'original');
});

test('a lost response retries the same receipt and retains the original target and parameters', async () => {
  let count = 0;
  const h = await harness(() => { if (!count++) throw Error('连接中断'); return { ok: true, duplicate: true }; });
  await h.openCommand('task-budget', 'T'); h.get('additional').value = '5'; await h.submit();
  assert.equal(h.get('command-dialog').open, true); assert.equal(h.get('execute').textContent, '查询操作结果');
  h.owner.snapshot.revision++; h.project.tasks.reverse(); h.get('additional').value = '99';
  await h.openCommand('retry', 'U'); await h.submit();
  assert.deepEqual(h.calls[1], h.calls[0]); assert.equal(h.calls[1].taskId, 'T'); assert.equal(h.calls[1].additionalAttempts, 5);
  assert.equal(h.get('command-dialog').open, false);
});

test('a rejected operation shows an error without claiming success or reusing a failed receipt', async () => {
  const h = await harness(() => ({ ok: false, error: '状态已变化' }));
  await h.openCommand('pause');
  assert.match(h.get('command-result').textContent, /状态已变化/); assert.equal(h.get('command-dialog').open, true);
  assert.equal(h.owner.pendingCommand, null); assert.equal(h.get('execute').disabled, true);
});

test('cleanup previews human-readable paths and applies exactly that preview in one dialog', async () => {
  const h = await harness(command => command.action === 'cleanup-preview'
    ? { ok: true, entries: [{ relative: 'reviews/old', bytes: 2048 }], reclaimableBytes: 2048, previewId: 'preview' }
    : { ok: true });
  await h.openCommand('cleanup-preview');
  assert.equal(h.get('command-preview').hidden, false); assert.equal(h.get('execute').disabled, false);
  await h.submit(); assert.equal(h.calls[1].action, 'cleanup-apply'); assert.equal(h.calls[1].previewId, 'preview');
});

test('a failed preview cannot submit a destructive operation and stale preview responses cannot replace the selected action', async () => {
  const failed = await harness(() => ({ ok: false, error: '预览失败' }));
  await failed.openCommand('delete-project'); await failed.submit();
  assert.equal(failed.calls.length, 1); assert.equal(failed.get('execute').disabled, true);
  let release;
  const h = await harness(command => command.operation === 'archive-project' ? new Promise(resolve => { release = resolve; }) : { ok: true, message: '删除预览', affectedTasks: [], requiresStopped: false });
  const first = h.openCommand(); h.get('action').value = 'delete-project'; await h.get('action').onchange();
  release({ ok: true, message: '旧归档预览', affectedTasks: [], requiresStopped: true }); await first;
  assert.equal(h.owner.commandPreview.message, '删除预览'); assert.doesNotMatch(h.get('execute').textContent, /已停止/);
});
