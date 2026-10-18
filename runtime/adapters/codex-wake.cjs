'use strict';
const fs = require('node:fs');
const { rpc } = require('../../scripts/probe-codex-desktop.cjs');
// Enumerate the pipe namespace directly without starting a shell process.
const PIPE_ROOT = '\\\\.\\pipe\\';
const PIPE_MARKER = 'codex-browser-use-';
class CodexWake {
  constructor({ rpcImpl = rpc } = {}) { this.rpc = rpcImpl; this.pipe = null; this.discovery = null; }
  async resolveTurn(threadId, workspace, sessionRoot) {
    const fs=require('node:fs'), path=require('node:path');
    // [AI-added] 2026-09-24 14:23: Use the active suffixed rollout, not an older exact-name log.
    const root=sessionRoot || path.join(process.env.CODEX_HOME || path.join(require('node:os').homedir(),'.codex'),'sessions');
    const file=require('../core/codex-usage.cjs').discoverCurrent(root,threadId);
    if(!file)return;
    const lines=require('node:readline').createInterface({input:fs.createReadStream(file,{encoding:'utf8'}),crlfDelay:Infinity});
    let verified=false, turnId;
    for await(const line of lines){
      let row;try{row=JSON.parse(line);}catch{continue;}
      if(row.type==='session_meta')verified=row.payload?.id===threadId && typeof row.payload.cwd==='string' && path.relative(workspace,row.payload.cwd)==='';
      if(row.type==='turn_context' && typeof row.payload?.turn_id==='string')turnId=row.payload.turn_id;
    }
    return verified?turnId:undefined;
  }
  discover() {
    if (this.pipe) return Promise.resolve(this.pipe);
    // Wake and Monitor can probe the same adapter in one tick; share the enumeration.
    this.discovery ||= this.enumerate().finally(() => { this.discovery = null; });
    return this.discovery;
  }
  async enumerate() {
    if (process.platform !== 'win32') throw Error('Codex wake currently supports Windows only');
    let names;
    try { names = await fs.promises.readdir(PIPE_ROOT); }
    catch (e) { throw Error('Codex Desktop pipe namespace unreadable: ' + e.message); }
    for (const name of names) {
      if (!name.toLowerCase().includes(PIPE_MARKER)) continue;
      const pipe = PIPE_ROOT + name;
      try {
        const r = await this.rpc(pipe,{id:1,jsonrpc:'2.0',method:'tools/list',params:{threadStartKind:'all'}});
        if (['read_thread','send_message_to_thread'].every(n=>r.result?.tools?.some(t=>t.namespace==='codex_app'&&t.name===n))) return this.pipe=pipe;
      } catch {}
    }
    throw Error('Compatible Codex Desktop tools pipe unavailable');
  }
  async call(binding, tool, args) {
    try {
      const r = await this.rpc(await this.discover(), {id:2,jsonrpc:'2.0',method:'tools/call',params:{callerSource:'codex',namespace:'codex_app',tool,threadId:binding.threadId,turnId:binding.turnId,callId:require('node:crypto').randomUUID(),arguments:args}},10000);
      if (r.error || r.result?.success !== true) throw Error('Desktop call failed: '+(r.error?.message || 'unsuccessful result'));
      const text=r.result.contentItems?.find(i=>i.type==='inputText')?.text;
      return JSON.parse(text);
    } catch(e) { this.pipe=null; throw e; }
  }
  read(binding) { return this.call(binding,'read_thread',{threadId:binding.threadId,turnLimit:10}); }
  send(binding,prompt) { return this.call(binding,'send_message_to_thread',{threadId:binding.threadId,prompt}); }
}
module.exports={CodexWake};
