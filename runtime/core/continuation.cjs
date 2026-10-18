'use strict';
const { bindingKey } = require('./bindings.cjs');
const { assertRoleProvider, continuationMode } = require('./platforms.cjs');
const hostCall = require('./host-call.cjs');

function detail(error) {
  return [...new Set([error.message, error.cause?.message, error.code || error.cause?.code].filter(Boolean))].join('; ');
}

// Resolve only the explicitly selected host. Verification never mutates bindings.
async function prepare(wake, { role, workspace, sessionId }, input, binding = {}) {
  const provider = assertRoleProvider(role, input.provider || binding.provider);
  if (!provider) throw Error('首次配置续接必须显式提供 --provider <当前真实平台>；已明确的平台直接复用，仅缺失时询问。');
  if (binding.provider && binding.provider !== provider) throw Error('Connected platform differs; use rebind');
  if (input.noWake && continuationMode(provider) === 'wake') throw Error('--no-wake is only valid for a wait-only worker provider');
  if (binding.wake) {
    if (binding.wake.threadId !== sessionId) throw Error('Role belongs to another session; use rebind');
    if (binding.wake.provider !== provider || (input.model && binding.wake.model !== input.model)) throw Error('Connected platform/model differs; use rebind');
    return { mode:'wake', provider, candidate:binding.wake };
  }
  if (continuationMode(provider) === 'wait') return { mode:'wait', provider };
  if (!sessionId) throw Error('缺少当前真实会话 ID；请用 connect --session-id 接入，不按目录猜测会话。');
  const adapter = wake.forProvider(provider);
  let turnId = input.turnId;
  if (provider === 'codex' && !turnId) turnId = await hostCall.bounded('Resolve Codex turn', () => adapter.resolveTurn?.(sessionId, workspace), wake.readTimeoutMs);
  if (provider === 'codex' && !turnId) throw Error('Codex 缺少真实 turnId；请执行 connect 或 resume --turn-id <真实当前回合 ID>。');
  const candidate = { provider, threadId:sessionId,...(provider==='qoder'&&input.qoderDescriptorPath?{descriptorPath:input.qoderDescriptorPath}:{}), ...(turnId ? {turnId} : {}), ...(['qoder','opencode','codearts','dsh'].includes(provider) ? {workspace} : {}) };
  const info = await wake.verify(candidate, workspace);
  const model = input.model || (provider === 'mimo' ? info.model : undefined);
  if (provider === 'mimo' && !model) throw Error('MiMo 会话缺少模型信息；请补充 --model <已确认 provider/model>。');
  if (model) candidate.model = model;
  return { mode:'wake', provider, candidate:wake.configuration({role,workspace,sessionId}, candidate) };
}

function apply(wake, identity, plan) {
  const b = wake.desktop.assertBinding(identity);
  if (plan.mode === 'wake') { wake.apply(identity, plan.candidate); return; }
  if (b.provider === plan.provider && !b.continuationError) return;
  wake.store.change(s => {
    const q = s.projects[identity.projectId].bindings[bindingKey(identity)];
    q.provider = plan.provider; delete q.continuationError;
  });
}

async function configure(wake, identity, input = {}, complete) {
  const desktop = wake.desktop, binding = desktop.assertBinding(identity), project = desktop.store.state.projects[identity.projectId];
  if (project.completedAt) return { mode:'stopped', ...desktop.nextStep(identity) };
  const provider = assertRoleProvider(identity.role, input.provider || binding.provider);
  if (input.noWake && provider && continuationMode(provider) === 'wake') throw Error('--no-wake is only valid for a wait-only worker provider');
  const expected = JSON.stringify(binding);
  let plan;
  try {
    plan = await prepare(wake, {...identity,workspace:project.workspace,sessionId:binding.sessionId}, input, binding);
  } catch (error) {
    const b = desktop.assertBinding(identity);
    if (JSON.stringify(b) !== expected) throw Error('Connection changed during host verification; retry resume');
    const reason = (provider ? provider + ': ' : '') + detail(error);
    if (b.continuationError !== reason || (!b.provider && provider)) desktop.store.change(s => {
      const q=s.projects[identity.projectId].bindings[bindingKey(identity)];
      if (!q.provider && provider) q.provider=provider; q.continuationError=reason;
    });
    return {mode:'attention',provider,nextAction:'attention',error:reason,nextInstruction:reason};
  }
  if (JSON.stringify(desktop.assertBinding(identity)) !== expected) throw Error('Connection changed during host verification; retry resume');
  return desktop.store.transaction(() => {
    if (desktop.store.state.projects[identity.projectId].completedAt) return {mode:'stopped',...desktop.nextStep(identity)};
    apply(wake, identity, plan);
    return complete ? complete({mode:plan.mode,provider:plan.provider}) : {mode:plan.mode,provider:plan.provider,...desktop.nextStep(identity)};
  });
}
function fields(plan) {
  return {provider:plan.provider,...(plan.mode === 'wake' ? {wake:plan.candidate} : {})};
}
module.exports = { prepare, apply, configure, fields, detail };
