'use strict';
const path = require('node:path');
const {WakeProviders} = require('../adapters/mimo-wake.cjs');
const {discoveryProviders} = require('./platforms.cjs');

// An invitation marker associates a pasted user message with its actual host
// session. Workspace, titles, activity, and newest-session ordering are not identity.
const marker = id => `[TASK-DISPATCH-INVITE:${id}]`;
async function discover({workspace, invitationId, provider}, adapters = new WakeProviders()) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(invitationId || '')) throw Error('A generated --invitation-id is required for session discovery');
  if(!provider||provider==='auto')throw Error('discover-session requires an explicit --provider');
  const providers = discoveryProviders(provider);
  const results = await Promise.all(providers.map(async name => {
    try {
      const adapter = adapters.forProvider(name);
      if (typeof adapter.discoverInvitation === 'function') {
        const sessions = await adapter.discoverInvitation({ invitationId, workspace });
        return {provider:name,status:'checked',matches:sessions.map(session => ({provider:name,sessionId:session.id,workspace:session.directory}))};
      }
      const sessions = await adapter.sessions(workspace);
      const matches = [];
      // Read only same-workspace histories, sequentially to bound host load.
      for (const session of sessions) {
        if (typeof session.id !== 'string' || typeof session.directory !== 'string' || !path.isAbsolute(session.directory) || path.relative(workspace,session.directory) !== '') continue;
        const messages = await adapter.messages(session);
        if (messages.some(m => m.info?.role === 'user' && (m.parts || []).some(p => p.type === 'text' && typeof p.text === 'string' && p.text.includes(marker(invitationId))))) matches.push({provider:name,sessionId:session.id,workspace:session.directory});
      }
      return {provider:name,status:'checked',matches};
    } catch { return {provider:name,status:'unavailable',matches:[]}; }
  }));
  const matches = results.flatMap(r=>r.matches);
  const checks = results.map(({provider,status})=>({provider,status}));
  if (matches.length !== 1) return {identified:false,nextAction:'attention',reason:matches.length?'ambiguous_invitation':'invitation_not_found',checks,nextInstruction:'无法唯一核实接收本邀请的会话。请确保邀请原文只发给一个目标会话；不要扫描数据库、输出连接令牌或按目录猜测。可补充宿主提供的真实 --session-id，或为目标会话生成新邀请。'};
  return {identified:true,...matches[0],checks};
}
module.exports = {discover,marker};
