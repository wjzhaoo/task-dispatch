// [AI-added] 2026-09-12 11:00
'use strict';
const { Transport } = require('./transport.cjs');
function completion(transport, signal, timeoutMs) {
  let done, fail;
  const promise = new Promise((resolve, reject) => { done = resolve; fail = reject; });
  promise.catch(() => {}); // Initialization may still be awaiting a separate RPC.
  const abort = () => fail(Error('Agent interrupted; reconcile before retry'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  transport.on('failure', fail); transport.on('closed', fail);
  const timer = setTimeout(() => fail(Error('Attempt time limit reached')), timeoutMs);
  return { promise, done, fail, cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', abort); transport.off('failure', fail); transport.off('closed', fail); } };
}
class Agent {
  constructor(profile) { this.profile = profile; }
  async run(options) {
    const { profile } = this;
    const rpc = new Transport(profile, options.cwd, options.onProcess);
    const end = completion(rpc, options.signal, profile.timeoutMs || 30 * 60 * 1000);
    let sessionId, turnId;
    try {
      if (profile.adapter === 'codex') {
        // [AI-added] 2026-09-14 09:43
/* Previous implementation:
await rpc.request('initialize', { clientInfo: { name: 'task_dispatch', version: '0.2.0' } });
*/
await rpc.request('initialize', { clientInfo: { name: 'task_dispatch', version: require('../../package.json').version } });
        rpc.send('initialized', {});
        const start = { cwd: options.cwd, approvalPolicy: 'never', sandbox: options.role === 'brain' ? 'read-only' : 'workspace-write' };
        if (profile.model) start.model = profile.model;
        const session = await rpc.request(options.sessionId ? 'thread/resume' : 'thread/start', { ...start, ...(options.sessionId ? { threadId: options.sessionId } : {}) });
        sessionId = session?.thread?.id;
        if (!sessionId) throw Error('Codex missing thread id');
        options.onSession(sessionId);
        const buffer = []; let started = false, text = '';
        const handle = msg => {
          if (msg.id !== undefined && msg.method) return end.fail(Error('Agent requests permission/user input: ' + msg.method));
          const p = msg.params || {}; if (p.threadId !== sessionId) return;
          if (!started) { buffer.push(msg); return; }
          if (p.turnId && p.turnId !== turnId) return;
          if (msg.method === 'item/completed' && p.item?.type === 'agentMessage') text = p.item.text || '';
          if (msg.method === 'turn/completed' && p.turn?.id === turnId) {
            p.turn.status === 'completed' ? end.done({ text }) : end.fail(Error('Codex terminal: ' + p.turn.status));
          }
        };
        rpc.on('message', handle);
        const params = { threadId: sessionId, cwd: options.cwd, input: [{ type: 'text', text: options.prompt }], approvalPolicy: 'never',
          sandboxPolicy: options.role === 'brain' ? { type: 'readOnly' } : { type: 'workspaceWrite', writableRoots: [options.cwd], networkAccess: false } };
        if (profile.model) params.model = profile.model;
        const response = await rpc.request('turn/start', params); turnId = response?.turn?.id;
        if (!turnId) throw Error('Codex missing turn id');
        started = true; buffer.forEach(handle);
      } else if (profile.adapter === 'zcode') {
        const workspace = { workspacePath: options.cwd, workspaceKey: options.cwd };
        const session = await rpc.request(options.sessionId ? 'session/resume' : 'session/create', options.sessionId ? { sessionId: options.sessionId, workspace } : { workspace });
        sessionId = session?.session?.sessionId || (options.sessionId && session?.sessionId);
        if (!sessionId) throw Error('ZCode missing session id (private protocol mismatch)');
        options.onSession(sessionId);
        const sub = await rpc.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', includeSnapshot: true, afterSeq: 0 });
        const status = sub?.snapshot?.projection?.status;
        if (['running', 'busy', 'working'].includes(status)) throw Error('ZCode session is already active');
        let lastSeq = sub?.eventSeq ?? -1, text = '', begun = false;
        rpc.on('message', msg => {
          if (msg.id !== undefined && msg.method) return end.fail(Error('Agent requests permission/user input: ' + msg.method));
          if (msg.method !== 'session/event' || msg.params?.sessionId !== sessionId) return;
          const { seq, type, payload: p = {} } = msg.params;
          if (!Number.isInteger(seq) || seq <= lastSeq) return; lastSeq = seq;
          if (type === 'turn.started') {
            if (p.inputSource === 'background_task') return end.fail(Error('Background turns unsupported; stop/reconcile'));
            if (begun) return end.fail(Error('Unexpected second ZCode turn'));
            begun = true;
          }
          if (!begun) return;
          if (type === 'session.updated' && p.taskId) return end.fail(Error('Background tasks unsupported; stop/reconcile'));
          if (type === 'tool.updated' && ['started', 'scheduled'].includes(p.kind)) text = '';
          if (type === 'model.streaming' && p.kind === 'text_delta') {
            text += p.delta || ''; if (text.length > 2 * 1024 * 1024) end.fail(Error('Final output exceeds limit'));
          }
          if (type === 'turn.failed') end.fail(Error(p.error?.message || 'ZCode turn failed'));
          if (type === 'turn.completed') {
            if (['success', 'end_turn'].includes(p.resultType)) end.done({ text, usage: p.usage });
            else end.fail(Error('Unknown ZCode resultType: ' + p.resultType));
          }
          if (type === 'turn.terminal' && p.status !== 'success') end.fail(Error('ZCode terminal: ' + p.status));
        });
        const accepted = await rpc.request('session/send', { sessionId, content: options.prompt });
        if (!accepted?.accepted) throw Error('ZCode did not accept prompt');
      } else throw Error('Unknown adapter');
      return await end.promise;
    } finally {
      end.cleanup();
      if (sessionId) {
        if (profile.adapter === 'zcode') rpc.send('session/stop', { sessionId })?.catch?.(() => {});
        else if (turnId) rpc.request('turn/interrupt', { threadId: sessionId, turnId }).catch(() => {});
      }
      await rpc.close();
    }
  }
}
function factory(config) {
  return profile => {
    if (!config.enableRealCalls) { const e = Error('Real calls disabled; set enableRealCalls explicitly after configuring adapters'); e.safeToRetry = true; throw e; }
    if (profile.adapter === 'zcode' && profile.experimentalProtocolAcknowledged !== true) { const e = Error('ZCode private protocol requires experimentalProtocolAcknowledged'); e.safeToRetry = true; throw e; }
    return new Agent(profile);
  };
}
module.exports = { Agent, factory };
