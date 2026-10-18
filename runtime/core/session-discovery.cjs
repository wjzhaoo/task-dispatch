'use strict';
const path = require('node:path');
const {WakeProviders} = require('../adapters/mimo-wake.cjs');
const {normalizeProvider} = require('./platforms.cjs');
const {detail} = require('./continuation.cjs');
const marker = id => `[TASK-DISPATCH-INVITE:${id}]`;
async function discover({workspace, invitationId, provider}, adapters = new WakeProviders()) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(invitationId || '')) throw Error('A generated --invitation-id is required for session discovery');
  if(!provider||provider==='auto')throw Error('discover-session requires an explicit --provider');
  provider=normalizeProvider(provider);
  const matches=[], check={provider,status:'checked'};
  try {
    const adapter=adapters.forProvider(provider);
    if(typeof adapter.discoverInvitation==='function') {
      const sessions=await adapter.discoverInvitation({invitationId,workspace});
      for(const session of sessions) if(typeof session.id==='string'&&session.id&&typeof session.directory==='string'&&path.isAbsolute(session.directory)&&path.relative(workspace,session.directory)==='')matches.push({provider,sessionId:session.id,workspace:session.directory});
    } else {
      const sessions=await adapter.sessions(workspace);
      for(const session of sessions) {
        if(typeof session.id!=='string'||typeof session.directory!=='string'||!path.isAbsolute(session.directory)||path.relative(workspace,session.directory)!=='')continue;
        const messages=await adapter.messages(session);
        if(messages.some(m=>m.info?.role==='user'&&(m.parts||[]).some(p=>p.type==='text'&&typeof p.text==='string'&&p.text.includes(marker(invitationId)))))matches.push({provider,sessionId:session.id,workspace:session.directory});
      }
    }
  } catch(error) {matches.length=0;check.status='unavailable';check.error=detail(error);}
  const checks=[check];
  if(matches.length!==1)return {identified:false,nextAction:'attention',reason:matches.length?'ambiguous_invitation':'invitation_not_found',checks,nextInstruction:(check.error?provider+': '+check.error+'。':'')+'无法唯一核实接收本邀请的会话。请确保邀请原文只发给一个目标会话；可补充宿主提供的真实 --session-id，或生成新邀请，不按目录猜测。'};
  return {identified:true,...matches[0],checks};
}
module.exports={discover,marker};
