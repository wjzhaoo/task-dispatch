'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const execFile = require('node:util').promisify(require('node:child_process').execFile);

// The Desktop host uses a random port. Discover it afresh, never persist credentials or ports.
async function discoverHost() {
  if (process.platform !== 'win32') throw Error('DSH requires DSH_WEB_URL on this platform');
  const script = "$ErrorActionPreference='Stop'; $dshHosts=@(Get-CimInstance Win32_Process -Filter \"Name = 'DeepSeek Harness.exe'\" | Where-Object { $_.CommandLine -match 'dsh-desktop-host' } | Select-Object -ExpandProperty ProcessId); @(Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in $dshHosts -and $_.LocalAddress -in @('127.0.0.1','::1') } | ForEach-Object { if ($_.LocalAddress -eq '::1') { 'http://[::1]:' + $_.LocalPort } else { 'http://127.0.0.1:' + $_.LocalPort } } | Sort-Object -Unique) | ConvertTo-Json -Compress";
  let stdout;
  try { ({stdout} = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide:true, timeout:8000})); }
  catch { throw Error('DSH host discovery failed; set DSH_WEB_URL to the current Desktop host URL'); }
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  const urls = Array.isArray(parsed) ? parsed : [parsed];
  if (urls.length !== 1) throw Error('DSH host is missing or ambiguous; set DSH_WEB_URL to the current Desktop host URL');
  return urls[0];
}

function localUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('Invalid DSH host URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('DSH host URL must be a loopback origin');
  return url;
}
function browserSecret(home) {
  let lines;
  try { lines = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8').split(/\r?\n/); }
  catch { throw Error('DSH browser credentials unavailable'); }
  let inRecord = false;
  for (const line of lines) {
    if (/^\s{2}client-connection\/browser-session:\s*$/.test(line)) { inRecord = true; continue; }
    if (inRecord && /^\s{2}\S/.test(line)) break;
    const match = inRecord && line.match(/^\s+secret:\s*["']?([A-Za-z0-9_-]{43}=?)["']?\s*$/);
    if (match) {
      const bytes = Buffer.from(match[1], 'base64url');
      if (bytes.length === 32) return bytes;
    }
  }
  throw Error('DSH browser-session secret missing or invalid');
}
function cookieFor(url, secret) {
  const authority = url.protocol === 'https:' ? 'https://' + url.host : url.host, now = Date.now();
  const body = Buffer.from(JSON.stringify({version:1, authority, issuedAt:now, expiresAt:now + 300000})).toString('base64url');
  return 'dsh-auth-' + crypto.createHash('sha256').update(authority).digest('base64url') + '=v1.' + body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

class DshWake {
  constructor({env = process.env, home, baseUrl, discoverUrl = discoverHost, fetchImpl = fetch, timeoutMs = 10000} = {}) {
    this.env = env; this.home = home; this.baseUrl = baseUrl; this.discoverUrl = discoverUrl; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async connection() {
    const url = localUrl(this.baseUrl || this.env.DSH_WEB_URL || await this.discoverUrl());
    return {url, cookie:cookieFor(url, browserSecret(this.home || this.env.DSH_HOME || path.join(os.homedir(), '.dsh')))};
  }
  async call(connection, method, args) {
    let response;
    try {
      response = await this.fetch(new URL('/api/' + method, connection.url), {method:'POST', redirect:'error', signal:AbortSignal.timeout(this.timeoutMs),
        headers:{'Content-Type':'application/json', Cookie:connection.cookie},
        body:JSON.stringify({type:'client-request', rpcId:crypto.randomUUID(), method, payload:{args}})});
    } catch { throw Error('DSH ' + method + ' request failed; delivery may be uncertain'); }
    // Never echo response bodies: a host/proxy error could include the signed Cookie.
    if (!response.ok) throw Error('DSH ' + method + ': HTTP ' + response.status);
    let envelope;
    try { envelope = await response.json(); } catch { throw Error('Invalid DSH RPC response'); }
    if (envelope?.result?.ok !== true) throw Error('DSH ' + method + ' RPC rejected');
    return envelope.result.value;
  }
  async list(connection) {
    const items = [], seen = new Set(); let cursor;
    do {
      const page = await this.call(connection, 'session/list', {_request:cursor ? {cursor} : {}});
      if (!Array.isArray(page?.items)) throw Error('Unsupported DSH session list');
      items.push(...page.items); cursor = page.nextCursor;
      if (cursor) {
        if (typeof cursor !== 'string' || seen.has(cursor) || seen.size >= 100) throw Error('Invalid DSH session cursor');
        seen.add(cursor);
      }
    } while (cursor);
    return items;
  }
  async session(connection, binding) {
    if (typeof binding.threadId !== 'string' || !binding.threadId.trim()) throw Error('DSH session ID required');
    const session = (await this.list(connection)).find(item => item.sessionId === binding.threadId);
    if (!session || typeof session.cwd !== 'string' || !path.isAbsolute(session.cwd) ||
        (binding.workspace && path.relative(binding.workspace, session.cwd) !== '')) throw Error('DSH session identity or workspace mismatch');
    return session;
  }
  info(session) {
    const outline = session.projections?.values?.turnOutline || [];
    if (!Array.isArray(outline)) throw Error('Unsupported DSH turn outline');
    return {thread:{id:session.sessionId, cwd:session.cwd, reachable:true,
      status:{type:session.running === true ? 'active' : session.running === false ? 'idle' : 'unknown'}},
      turns:outline.map(turn => ({items:[
        {type:'userMessage', content:[{text:typeof turn.prompt === 'string' ? turn.prompt : ''}]},
        {type:'agentMessage', content:[{text:typeof turn.response === 'string' ? turn.response : ''}]}
      ]}))};
  }
  async read(binding) { return this.info(await this.session(await this.connection(), binding)); }
  async verify(binding) { return this.read(binding); }
  async sessions(workspace) {
    return (await this.list(await this.connection())).filter(s => typeof s.cwd === 'string' && path.isAbsolute(s.cwd) && (!workspace || path.relative(workspace, s.cwd) === ''))
      .map(s => ({id:s.sessionId, directory:s.cwd}));
  }
  async messages(session) {
    const info = await this.read({threadId:session.id, workspace:session.directory});
    return info.turns.flatMap(t => t.items.map(i => ({info:{role:i.type === 'userMessage' ? 'user' : 'assistant'}, parts:i.content.map(c => ({type:'text', text:c.text}))})));
  }
  async send(binding, message) {
    if (binding.model) throw Error('DSH wake preserves the session model; omit --model');
    if (typeof message !== 'string' || !message.trim()) throw Error('DSH message required');
    let connection, session;
    try { connection = await this.connection(); session = await this.session(connection, binding); }
    catch (error) { error.safeToRetry = true; throw error; }
    if (session.running !== false || session.agentAvailable === false) {
      const error = Error('DSH session is not idle or cannot be restored'); error.safeToRetry = true; throw error;
    }
    if (binding.canSend && !binding.canSend()) { const error = Error('The binding or pending attempt changed before delivery'); error.safeToRetry = true; throw error; }
    const requestId = crypto.randomUUID();
    const result = await this.call(connection, 'session/prompt', {request:{requestId, sessionId:binding.threadId, mode:'queue',
      content:[{type:'text', text:message}], clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}});
    if (result?.accepted !== true) throw Error('DSH delivery unconfirmed');
    // Acceptance is delivery only; claim/submit still determine task completion.
    return {delivered:true, accepted:true, requestId};
  }
}
module.exports = {DshWake};
