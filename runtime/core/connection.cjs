'use strict';
const path = require('node:path');
const { plainDirectory, sha } = require('./storage.cjs');
const { bindingKey } = require('./bindings.cjs');
const { assertRoleProvider } = require('./platforms.cjs');
const continuation = require('./continuation.cjs');
const PROTOCOL = 2;

function ready(desktop, input) {
  if (!input.workspace) return {};
  const p = Object.values(desktop.store.state.projects).find(p => path.relative(p.workspace, input.workspace) === '');
  const b = p?.bindings?.[bindingKey(input)];
  return { connection: { projectId:p?.id, webManaged:!!p?.webSetup,
    ...(b ? {binding:{clientId:b.clientId,sessionId:b.sessionId,provider:b.provider}} : {}) } };
}

function finish(wake, identity, plan) {
  const step = wake.desktop.nextStep(identity);
  if (step.nextAction === 'claim') {
    const job = wake.desktop.claim(identity, {dispatch:false});
    if (job) return {...plan,...step,job,nextAction:'work',nextInstruction:'处理返回的正式 job，完成后 submit 和 resume。'};
  }
  if (step.nextAction !== 'park') return {...plan,...step};
  const standby = wake.park(identity, {dispatch:false});
  return {...plan,...step,...standby,nextAction:standby.job ? 'work' : standby.parked ? 'standby' : step.nextAction,
    nextInstruction:standby.job ? '处理返回的正式 job，完成后 submit 和 resume。' : '已自动待命，结束当前回合；后续由服务唤醒。'};
}

async function connect(wake, input) {
  const desktop = wake.desktop, store = desktop.store;
  if (!['brain','reviewer','worker'].includes(input.role)) throw Error('Role must be brain, worker or reviewer');
  if (!input.provider) throw Error('connect requires explicit --provider <actual host>');
  if (input.waitLocked) throw Error('已有 wait 进程或遗留锁；核对并续等原进程，不能同时配置唤醒。');
  const provider = assertRoleProvider(input.role, input.provider), workspace = plainDirectory(input.workspace);
  const key = bindingKey(input), p = Object.values(store.state.projects).find(p => p.workspace === workspace), previous = p?.bindings?.[key];
  if (input.continue && input.role !== 'brain') throw Error('Only brain connect can reopen a project');
  const owned = previous?.clientId === input.clientId && previous.tokenHash === sha(input.token || '');
  const signature = b => JSON.stringify(b && {clientId:b.clientId,tokenHash:b.tokenHash,sessionId:b.sessionId,provider:b.provider,wake:b.wake});
  const pending = p?.handovers?.[key], ownsPending = pending?.clientId === input.clientId && pending.tokenHash === sha(input.token || '');
  const expected = signature(previous), expectedPending = JSON.stringify(pending);
  let plan;
  try {
    plan = await continuation.prepare(wake, {...input,workspace}, {...input,provider}, owned ? previous : ownsPending ? {...pending,...pending.connection} : {});
  } catch (error) { throw Error(provider + ': ' + continuation.detail(error), {cause:error}); }
  const current = () => Object.values(store.state.projects).find(p => p.workspace === workspace);
  if (signature(current()?.bindings?.[key]) !== expected || JSON.stringify(current()?.handovers?.[key]) !== expectedPending) throw Error('Connection changed during host verification; retry connect');
  let registration, result;
  store.transaction(() => {
    registration = desktop.attach({...input,workspace,connection:continuation.fields(plan)});
    if (registration.handoverPending) {
      result = {attached:false,handoverPending:true,nextAction:'resume',nextInstruction:'旧端仍有在途任务，执行 resume 等待安全交接；完成后自动续接，不重复 connect 或执行旧任务。'};
      return;
    }
    if (current().completedAt && input.continue) desktop.d.finishProject(registration.projectId, true);
    if (current().completedAt) result = {mode:'stopped',...desktop.nextStep(registration)};
    else {
      continuation.apply(wake, registration, plan);
      result = finish(wake, registration, {mode:plan.mode,provider});
    }
  });
  if (registration.handoverPending) return {...result,registration};
  const status = desktop.status(registration);
  desktop.d.tick();
  return {attached:true,...status,...result,registration};
}

async function resume(wake, identity, input) {
  const result = await continuation.configure(wake, identity, input, plan => finish(wake, identity, plan));
  if (!['attention','stopped'].includes(result.mode)) wake.desktop.d.tick();
  return result;
}
function waitForHandover(wake, identity, input, events, signal) {
  const timeoutMs = input.handoverTimeoutMs ?? 20000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 20000) throw Error('handoverTimeoutMs must be 0..20000');
  const inspect = () => {
    const p = wake.store.state.projects[identity.projectId], key = bindingKey(identity), b = p?.bindings?.[key], next = p?.handovers?.[key];
    if (b?.clientId === identity.clientId && b.tokenHash === identity.tokenHash) {
      const {pending,tokenHash,...active} = identity;
      wake.desktop.assertBinding(active); return active;
    }
    if (next?.clientId !== identity.clientId || next.tokenHash !== identity.tokenHash) throw Error('Handover cancelled or replaced; this credential no longer owns the request');
    if (p.archivedAt) throw Error('Project archived; restore it in the management console');
    return null;
  };
  const active = inspect(); if (active) return Promise.resolve(active);
  wake.handoverWaiters ||= new Set();
  const key=identity.projectId+'/'+bindingKey(identity)+'/'+identity.clientId;
  if(wake.handoverWaiters.has(key))throw Error('已有本会话的 resume 交接等待；请续等原进程。');
  wake.handoverWaiters.add(key);
  return new Promise((resolve,reject) => {
    const cleanup = () => {wake.handoverWaiters.delete(key);clearTimeout(timer);events.off('change',changed);events.off('shutdown',stopped);signal?.removeEventListener('abort',aborted);};
    const done = (value,error) => {cleanup();error ? reject(error) : resolve(value);};
    const changed = () => {try {const active=inspect();if(active)done(active);}catch(error){done(null,error);}};
    const stopped = () => done(null,Error('Service stopping'));
    const aborted = () => done(null,Error('Handover wait disconnected'));
    const timer = setTimeout(() => done(null),timeoutMs);
    events.on('change',changed);events.once('shutdown',stopped);signal?.addEventListener('abort',aborted,{once:true});
    if(signal?.aborted)aborted();else changed();
  });
}
module.exports = { PROTOCOL, connect, resume, ready, waitForHandover };
