// [AI-added] 2026-09-14 09:43
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
class CodeArtsWake {
  constructor({ credentialFile, discoveryDir, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    this.file = credentialFile;
    this.dir = discoveryDir || path.join(os.homedir(), '.codeartsdoer', 'task-dispatch');
    this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  discovery(binding) {
    if (typeof binding.threadId !== 'string' || !binding.threadId.trim()) throw Error('CodeArts session ID required');
    const name = crypto.createHash('sha256').update(binding.threadId).digest('hex') + '.json';
    /* Previous implementation:
    const c = JSON.parse(fs.readFileSync(this.file || path.join(this.dir, name), 'utf8'));
    */
    // [AI-added] 2026-09-14 20:18
    const selected=this.file||[path.join(this.dir,name),path.join(this.dir,'bridge.json')].find(fs.existsSync);
    if(!selected)throw Error('CodeArts discovery file not found');
    const c = JSON.parse(fs.readFileSync(selected, 'utf8'));
    if(!c.sessionId)c.sessionId=binding.threadId;
    const url = new URL(c.url);
    // [AI-added] 2026-09-14 20:10
    if (![1,2].includes(c.version) || c.sessionId !== binding.threadId || typeof c.directory !== 'string' || !c.directory ||
        url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        (c.version===1&&(typeof c.username !== 'string'||!c.username||c.username.includes(':')||typeof c.password !== 'string'||!c.password)) ||
        (c.version===2&&(typeof c.token!=='string'||!/^[a-f0-9]{64}$/i.test(c.token))))
      throw Error('Invalid CodeArts discovery file');
    return c;
  }
  async request(binding, route, options = {}) {
    const c = this.discovery(binding);
    // [AI-added] 2026-09-14 20:10
    const bridgeRoute=route==='/session/status'?'/v1/status':route.endsWith('/message')?'/v1'+route.replace(/\/message$/,'/messages'):route.endsWith('/prompt_async')?'/v1'+route.replace(/\/prompt_async$/,'/prompt'):'/v1'+route;
    const url = new URL(c.version===2?bridgeRoute:route, c.url);
    if(c.version===1)url.searchParams.set('directory', c.directory);
    return this.fetch(url.href, { ...options, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: c.version===2?'Bearer '+c.token:'Basic ' + Buffer.from(c.username + ':' + c.password).toString('base64') } });
  }
  async json(binding, route) {
    const r = await this.request(binding, route);
    if (!r.ok) throw Error('CodeArts query failed: HTTP ' + r.status);
    return r.json();
  }
  async sessions(workspace) {
    // Multiple project kernels overwrite bridge.json. Per-session descriptors
    // preserve each kernel's endpoint; do not infer the current kernel from the
    // last global writer. These files are private adapter data, never CLI output.
    const files = this.file ? [this.file] : fs.readdirSync(this.dir).filter(n=>n==='bridge.json'||/^[a-f0-9]{64}\.json$/.test(n)).map(n=>path.join(this.dir,n));
    const groups = new Map();
    for (const file of files) {
      try {
        const c=JSON.parse(fs.readFileSync(file,'utf8'));
        if (typeof c.directory!=='string' || (workspace && path.relative(workspace,c.directory)!=='')) continue;
        const key=JSON.stringify([c.url,c.directory]);
        if (!groups.has(key)) groups.set(key,{file,c});
      } catch {}
    }
    const found = new Map();let reachable=false;
    this.discoverySources=new Map();
    for (const {file,c} of groups.values()) {
      try {
        const source=new CodeArtsWake({credentialFile:file,fetchImpl:this.fetch,timeoutMs:this.timeoutMs});
        const binding={threadId:c.sessionId||'discovery'};
        const sessions=await source.json(binding,c.version===2?'/sessions':'/session');
        if (!Array.isArray(sessions)) continue;
        reachable=true;
        for (const session of sessions) {
          if(typeof session.id!=='string'||typeof session.directory!=='string'||path.relative(c.directory,session.directory)!=='')continue;
          found.set(session.id,session);
          this.discoverySources.set(session.id,{source,binding});
        }
      } catch {}
    }
    if(!reachable)throw Error('CodeArts project bridge unavailable');
    return [...found.values()];
  }
  async messages(session) {
    const discovered=this.discoverySources?.get(session.id);
    const messages = await (discovered ? discovered.source.json(discovered.binding,'/session/'+encodeURIComponent(session.id)+'/message') : this.json({threadId:session.id},'/session/'+encodeURIComponent(session.id)+'/message'));
    if (!Array.isArray(messages)) throw Error('Unsupported CodeArts message history');
    return messages;
  }
  async read(binding) {
    const route = '/session/' + encodeURIComponent(binding.threadId);
    const session = await this.json(binding, route);
    // [AI-added] 2026-09-14 09:43
    // Previous: only the session ID and directory type were checked.
    if (session.id !== binding.threadId || typeof session.directory !== 'string' ||
        path.relative(this.discovery(binding).directory, session.directory) !== '') throw Error('CodeArts session mismatch');
    const messages = await this.json(binding, route + '/message');
    if (!Array.isArray(messages)) throw Error('Unsupported CodeArts message history');
    const statuses = await this.json(binding, '/session/status');
    if (!statuses || Array.isArray(statuses) || typeof statuses !== 'object') throw Error('Unsupported CodeArts status');
    const status = statuses[binding.threadId]?.type;
    const type = !Object.hasOwn(statuses, binding.threadId) || status === 'idle' ? 'idle' : ['busy', 'retry'].includes(status) ? 'active' : 'unknown';
    return { thread: { id: session.id, cwd: session.directory, status: { type } },
      turns: messages.map(m => ({ items: [{ type: m.info?.role === 'user' ? 'userMessage' : 'agentMessage',
        content: (m.parts || []).filter(p => p.type === 'text' && typeof p.text === 'string').map(p => ({ text: p.text })) }] })) };
  }
  async send(binding, message) {
    const current = await this.read(binding);
    if (current.thread.status.type !== 'idle') { const e = Error('CodeArts session is not idle'); e.safeToRetry = true; throw e; }
    const body = { parts: [{ type: 'text', text: message }] };
    if (binding.model) {
      const match = /^([^\s/]+)\/(\S+)$/.exec(binding.model);
      if (!match) throw Error('CodeArts model must be provider/model');
      body.model = { providerID: match[1], modelID: match[2] };
    }
    const r = await this.request(binding, '/session/' + encodeURIComponent(binding.threadId) + '/prompt_async', { method: 'POST', body: JSON.stringify(body) });
    if (r.status === 204) return { delivered: true };
    throw Error('CodeArts delivery unconfirmed: HTTP ' + r.status);
  }
}
module.exports = { CodeArtsWake };
