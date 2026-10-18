'use strict';
const fs = require('node:fs');
const path = require('node:path');
// [AI-added] 2026-09-19: A wake is only reported as delivered after it is read back from the
// target session history. MiMo's 202 + {ok:true} is an acknowledgement, not a delivery receipt.
const CONFIRM_ATTEMPTS = 4;
const CONFIRM_DELAY_MS = 400;
// [AI-added] 2026-09-20: Reachability failures may be auto-repaired by relaunching MiMo Desktop;
// the discovery file (port + token) is rewritten on startup, so the next probe reattaches.
const { listProcesses, restartApp, installCandidates, registryLookup } = require('../core/app-restart.cjs');
const REPAIR_INTERVAL_MS = 10 * 60_000;
const REPAIR_MAX_FAILURES = 3;
const MIMO_PROCESS_NAMES = ['Xiaomi MiMo'];
function unreachable(message) { const error = Error(message); error.restartable = true; return error; }
function mimoCandidates(env = process.env) {
  return [env.TASK_DISPATCH_MIMO_EXE, ...installCandidates(env, [
    ['Programs', 'Xiaomi MiMo', 'Xiaomi MiMo.exe'],
    ['Programs', 'MimoDesktop', 'Xiaomi MiMo', 'Xiaomi MiMo.exe'],
    ['MimoDesktop', 'Xiaomi MiMo', 'Xiaomi MiMo.exe'],
  ])].filter(Boolean);
}
// Mirror Desktop's preference normalization, including its empty stored default.
// Omitting perm would select the harness's different (manual ask) default.
function effectivePermission(settings, sessionId) {
  const known=['默认权限','帮我审批','完全访问权限'];
  const normalize=value=>value==='接受编辑权限'?'帮我审批':known.includes(value)?value:null;
  let bySession=settings.permByConvo;
  if(typeof bySession==='string'){try{bySession=JSON.parse(bySession);}catch{bySession=null;}}
  const value=normalize(bySession?.[sessionId]) || normalize(settings.perm) || '帮我审批';
  return value==='完全访问权限' && (settings.fullAccessEnabled===false || settings.fullAccessEnabled==='0') ? '默认权限' : value;
}
// Discovery is repeated for every request: ports and tokens change on Desktop restart.
class MimoWake {
  constructor({ credentialFile, fetchImpl = fetch, timeoutMs = 10000, eventTimeoutMs = 800, env, probeProcesses, restartApp: restartImpl, now } = {}) {
    this.file = credentialFile || path.join(process.env.APPDATA || '', 'Xiaomi MiMo', 'desktop-api.json');
    this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.eventTimeoutMs = eventTimeoutMs;
    this.env = env || process.env;
    this.probeProcesses = probeProcesses || (() => listProcesses(MIMO_PROCESS_NAMES));
    this.restartApp = restartImpl || (opts => restartApp(opts));
    this.now = now || (() => Date.now());
  }
  async request(route, options = {}) {
    let c;
    try { c = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { throw unreachable('Invalid MiMo Desktop discovery file'); }
    if (c.api !== 1 || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535 || !/^[a-f0-9]{64}$/i.test(c.token)) throw unreachable('Invalid MiMo Desktop discovery file');
    let response;
    try {
      response = await this.fetch(`http://127.0.0.1:${c.port}/v1/${route}`, {
        ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(this.timeoutMs),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.token }
      });
    } catch (error) {
      // Timeouts mean a slow or hung app, not proof it is down; only refused/reset
      // transport failures justify the restart repair.
      if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
      throw unreachable('MiMo Desktop unreachable: ' + (error.cause?.code || error.message));
    }
    return response;
  }
  async json(route) {
    const r = await this.request(route);
    if (!r.ok) throw Error('MiMo query failed: HTTP ' + r.status);
    return r.json();
  }
  async sessions() {
    const result = await this.json('sessions');
    const sessions = Array.isArray(result) ? result : result.sessions;
    if (!Array.isArray(sessions)) throw Error('Unsupported MiMo session listing');
    return sessions;
  }
  async messages(session) {
    const result = await this.json(`sessions/${encodeURIComponent(session.id)}/messages?dir=${encodeURIComponent(session.directory)}`);
    const messages = Array.isArray(result) ? result : result.messages;
    if (!Array.isArray(messages)) throw Error('Unsupported MiMo message history');
    return messages;
  }
  async status(id, directory) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.eventTimeoutMs);
    let reader;
    try {
      const r = await this.request(`sessions/${encodeURIComponent(id)}/events${directory?'?dir='+encodeURIComponent(directory):''}`, { signal: controller.signal });
      if (!r.ok || !r.body) return 'unknown';
      reader = r.body.getReader(); let buffer = ''; const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read(); if (done) return 'unknown';
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        if (buffer.length > 65536) throw Error('MiMo event too large');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const event = /^event:\s*(\S+)/m.exec(frame)?.[1];
          if (event === 'idle') return 'idle';
          if (['busy', 'permission'].includes(event)) return 'active';
          if (event === 'closed') return 'unknown';
        }
      }
    } catch { return 'unknown'; }
    finally { clearTimeout(timer); controller.abort(); if (reader) await reader.cancel().catch(() => {}); }
  }
  // [AI-added] 2026-09-24 13:26: Connection verification needs identity and model, not an SSE activity sample.
  async verify(binding) { return this.inspect(binding, false); }
  async read(binding) { return this.inspect(binding, true); }
  async inspect(binding, includeStatus) {
    const listing = await this.json('sessions');
    const sessions = Array.isArray(listing) ? listing : listing.sessions;
    if (!Array.isArray(sessions)) throw Error('Unsupported MiMo session listing');
    const session = sessions.find(s => s.id === binding.threadId);
    if (!session) throw Error('MiMo session not found');
    if(typeof session.directory!=='string'||!path.isAbsolute(session.directory))throw Error('MiMo session directory required');
    const history = await this.json(`sessions/${encodeURIComponent(binding.threadId)}/messages?dir=${encodeURIComponent(session.directory)}`);
    const messages = Array.isArray(history) ? history : history.messages;
    if (!Array.isArray(messages)) throw Error('Unsupported MiMo message history');
    const turns = messages.map(m => ({ items: [{ type: m.info?.role === 'user' ? 'userMessage' : 'agentMessage', content: (m.parts || []).filter(p => typeof p.text === 'string').map(p => ({ text: p.text })) }] }));
    // Live session listing and history succeeded. Missing initial SSE means unknown
    // activity, not offline; do not infer idle from this reachability evidence.
    const latest = [...messages].reverse().find(m=>m.info?.role==='assistant' && !m.info.error && m.info.providerID && m.info.modelID);
    const model = latest ? latest.info.providerID+'/'+latest.info.modelID : undefined;
    // [AI-added] 2026-09-24 13:26: Monitor and wake reads still include live activity status.
    return { thread: { id: session.id, cwd: session.directory, reachable:true, status: { type: includeStatus ? await this.status(session.id,session.directory) : 'unknown' } }, turns, model };
  }
  async send(binding, message) {
    if (typeof binding.model !== 'string' || !/^[^\s/]+\/[^\s]+$/.test(binding.model)) throw Error('MiMo wake requires explicit provider/model');
    const listing=await this.json('sessions'),sessions=Array.isArray(listing)?listing:listing.sessions;
    const session=Array.isArray(sessions)?sessions.find(s=>s.id===binding.threadId):null;
    if(!session||typeof session.directory!=='string'||!path.isAbsolute(session.directory))throw Error('MiMo session directory required');
    // Preserve the existing session policy; never upgrade permissions for wake.
    let perm;
    try { const settings=JSON.parse(fs.readFileSync(path.join(path.dirname(this.file),'preferences.json'),'utf8'));perm=effectivePermission(settings,binding.threadId); } catch {}
    const r = await this.request(`sessions/${encodeURIComponent(binding.threadId)}/turns`, {
      method: 'POST', body: JSON.stringify({ message, model: binding.model, dir:session.directory, ...(typeof perm==='string'&&perm?{perm}:{}), origin: 'task-dispatch' })
    });
    let body; try { body = await r.json(); } catch { throw Error('MiMo response uncertain'); }
    if (r.status !== 202 || body.ok !== true) {
      const e = Error(`MiMo wake rejected: HTTP ${r.status}${body.code === 'busy' ? ' busy' : ''}`);
      if (body.code === 'busy' && r.status >= 400 && r.status < 500) e.safeToRetry = true;
      throw e;
    }
    // [AI-added] 2026-09-19: MiMo answers 202 + {ok:true} even when its harness later refuses the
    // invocation (for example reason=invocation-conflict) and that refusal never reaches the caller.
    // Confirm the message really landed in the target history before reporting delivery.
    if (await this.confirm(session, message)) return { delivered: true };
    const unverified = Error('MiMo accepted the wake (HTTP 202) but it never appeared in the target session history after ' + CONFIRM_ATTEMPTS + ' reads. The target host most likely refused the invocation; restart the target app, then retry the task.');
    unverified.unverified = true;
    unverified.restartable = true;
    throw unverified;
  }
  async confirm(session, message) {
    const marker = /TASK-DISPATCH-[A-Z-]+:[0-9a-f-]{8,}(?::REMINDER:\d+)?/.exec(message)?.[0] || message.slice(0, 40);
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, CONFIRM_DELAY_MS));
      try {
        const history = await this.json(`sessions/${encodeURIComponent(session.id)}/messages?dir=${encodeURIComponent(session.directory)}`);
        const messages = Array.isArray(history) ? history : history.messages;
        if (Array.isArray(messages) && messages.some(m => (m.parts || []).some(p => typeof p.text === 'string' && p.text.includes(marker)))) return true;
      } catch { /* An unreadable history is not proof of delivery; keep polling. */ }
    }
    return false;
  }
  // [AI-added] 2026-09-20: Auto-repair an unreachable MiMo Desktop. The discovery file's pid
  // decides the shape: a dead pid only needs a launch, a live pid with a refusing API is a hung
  // app — but force-killing it would also drop any user conversation that is still generating.
  // So a live pid restarts only when the API still answers and reports every session idle; an
  // unresponsive app is never killed automatically, that stays a manual reminder.
  // Rate-limited, and disabled after repeated failures like the Qoder repair.
  async repairBridge() {
    this._repair ||= { at: 0, failures: 0 };
    if (this._repair.disabled) return { attempted: false, reason: 'disabled-after-repeated-failures' };
    if (this._repair.at && this.now() - this._repair.at < REPAIR_INTERVAL_MS) return { attempted: false, reason: 'rate-limited' };
    let value;
    try { value = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { value = null; }
    let pidAlive = false;
    if (Number.isInteger(value?.pid) && value.pid > 0) {
      try { process.kill(value.pid, 0); pidAlive = true; } catch (error) { pidAlive = error.code === 'EPERM'; }
    }
    let kill = false;
    if (pidAlive) {
      // The refusing port may be transient; if the app answers now, restart only with all
      // sessions provably idle. No listing (still unreachable) means no automatic kill.
      const sessions = await this.sessions().catch(() => null);
      if (!Array.isArray(sessions)) return { attempted: false, reason: 'status-unknown' };
      if (sessions.some(s => s.status === 'busy' || s.running === true || s.status?.type === 'busy'))
        return { attempted: false, reason: 'session-active' };
      kill = true;
    }
    this._repair.at = this.now();
    const result = await this.restartApp({
      names: MIMO_PROCESS_NAMES, kill, candidates: mimoCandidates(this.env),
      fallback: () => registryLookup(['Xiaomi MiMo.exe']),
    }).catch(e => ({ attempted: false, reason: 'restart-error', error: e.message }));
    if (!result?.attempted) {
      this._repair.failures++;
      if (this._repair.failures >= REPAIR_MAX_FAILURES) this._repair.disabled = true;
    }
    return result;
  }
}
class WakeProviders {
  // [AI-added] 2026-09-15 18:56
  // [AI-added] 2026-09-14 09:43
constructor(options = {}) { const qoder = new (require('./qoder-wake.cjs').QoderWake)(options.qoder); const opencode = new (require('./opencode-wake.cjs').OpenCodeWake)(options.opencode); this.adapters = { dsh: new (require('./dsh-wake.cjs').DshWake)(options.dsh), codearts: new (require('./codearts-wake.cjs').CodeArtsWake)(options.codearts), codex: new (require('./codex-wake.cjs').CodexWake)(), mimo: new MimoWake(options.mimo), qoder, opencode }; }
  forProvider(provider) { provider=require('../core/platforms.cjs').normalizeProvider(provider);if (!Object.hasOwn(this.adapters, provider)) throw Error('Wake provider not connected: ' + provider); return this.adapters[provider]; }
}
module.exports = { MimoWake, WakeProviders, effectivePermission };
