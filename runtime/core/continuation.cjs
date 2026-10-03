'use strict';
const path = require('node:path');
const {bindingKey} = require('./bindings.cjs');
const {assertRoleProvider,continuationMode} = require('./platforms.cjs');

// Identify the exact connected session, never select a session by workspace alone.
async function configure(wake, identity, input = {}) {
  const desktop = wake.desktop;
  const binding = desktop.assertBinding(identity);
  const project = desktop.store.state.projects[identity.projectId];
  if (project.completedAt) return {mode:'stopped', ...desktop.nextStep(identity)};
  if (binding.wake) return {mode:'wake', provider:binding.wake.provider, ...desktop.nextStep(identity)};
  const selected = assertRoleProvider(identity.role,input.provider || binding.provider);
  if (selected && binding.provider !== selected) desktop.store.change(s => { s.projects[identity.projectId].bindings[bindingKey(identity)].provider = selected; });
  if (input.noWake === true) {
    if (!selected || selected === 'auto') throw Error('--no-wake requires an explicit host provider');
    if (continuationMode(selected)==='wake') throw Error('--no-wake is only valid for a wait-only worker provider');
    desktop.store.change(s => { s.projects[identity.projectId].bindings[bindingKey(identity)].continuation = {mode:'wait',provider:selected}; });
    return {mode:'wait',provider:selected,...desktop.nextStep(identity)};
  }
  if (selected && continuationMode(selected)==='wait') {
    desktop.store.change(s => { s.projects[identity.projectId].bindings[bindingKey(identity)].continuation = {mode:'wait',provider:selected}; });
    return {mode:'wait', provider:selected, ...desktop.nextStep(identity)};
  }
  if (!selected && binding.continuation?.mode === 'wait') return {...binding.continuation,...desktop.nextStep(identity)};
  const attention = reason => {
    desktop.store.change(s => { s.projects[identity.projectId].bindings[bindingKey(identity)].continuationError = reason; });
    return {mode:'attention',provider:selected,nextAction:'attention',nextInstruction:reason};
  };
  if(!selected)return attention('首次配置续接必须显式提供 --provider <当前真实平台>；不会跨平台扫描或猜测。');
  if (!binding.sessionId) return attention('缺少当前真实会话 ID；重新 connect --session-id 后再执行 resume，不按目录猜测会话。');
  if (selected === 'codex' && !input.turnId) {
    try { input = {...input,turnId:await wake.forProvider(selected).resolveTurn?.(binding.sessionId,project.workspace)}; } catch {}
    if (!input.turnId) return attention('当前宿主为 Codex，无法从本会话记录取得真实 turnId；执行 resume --turn-id <真实当前回合 ID>。');
  }
  const providers = [selected];
  const results = await Promise.allSettled(providers.map(async provider => {
    const candidate = {provider,threadId:binding.sessionId,...(input.turnId?{turnId:input.turnId}:{}),...(provider==='qoder'?{workspace:project.workspace}:{})};
    // Previous implementation: every connect used a full read here and another full read in Wake.bind.
    // [AI-added] 2026-09-24 13:26: Verify identity once; MiMo can omit activity polling during setup.
    const adapter = wake.forProvider(provider);
    const info = await (typeof adapter.verify === 'function' ? adapter.verify(candidate) : adapter.read(candidate));
    if (info.thread?.id !== binding.sessionId || !info.thread.cwd || path.relative(project.workspace,info.thread.cwd) !== '') throw Error('Session workspace mismatch');
    return {candidate,info};
  }));
  desktop.assertBinding(identity);
  const matches = results.filter(r=>r.status==='fulfilled').map(r=>r.value);
  if (matches.length !== 1) return attention('显式指定的 '+selected+' 唤醒适配器未能核实当前会话。请检查真实 session、workspace 和宿主连接条件后重试；不会探测或改用其他平台。');
  const {candidate,info} = matches[0];
  if (candidate.provider === 'codex' && !candidate.turnId) return attention('显式指定 Codex，但缺少真实当前 turnId；执行 resume --turn-id <真实当前回合 ID>，不能编造。');
  if (candidate.provider === 'mimo') {
    candidate.model = input.model || info.model;
    if (!candidate.model) return attention('显式指定 MiMo，但没有成功消息中的模型信息；执行 resume --model <已确认 provider/model>。');
  } else if (input.model) candidate.model = input.model;
  // [AI-added] 2026-09-24 13:26: Pass the checked result only through this internal call.
  try { await wake.bind(identity,{...candidate,experimentalAcknowledged:true},info); }
  catch { return attention('显式指定的 '+candidate.provider+' 唤醒绑定失败；核对会话、模型与适配器条件后重试，不能降级 wait。'); }
  desktop.store.change(s => { delete s.projects[identity.projectId].bindings[bindingKey(identity)].continuationError; });
  return {mode:'wake',provider:candidate.provider,...desktop.nextStep(identity)};
}
module.exports = {configure};
