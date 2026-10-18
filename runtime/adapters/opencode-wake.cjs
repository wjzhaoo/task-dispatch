'use strict';
// Adapted from llm-game-arena/lib/wake/opencode.mjs to the task-dispatch host contract.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');

function executable(file) {
  return !(process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(file)) && fs.existsSync(file) && fs.statSync(file).isFile();
}
function findOpenCodeCli(env = process.env) {
  if (env.TASK_DISPATCH_OPENCODE_CLI) {
    const file = path.resolve(env.TASK_DISPATCH_OPENCODE_CLI);
    if (!executable(file)) throw Error('OpenCode CLI override must be an executable file, not a shell wrapper');
    return file;
  }
  const root = path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai.opencode.desktop', 'cli');
  if (fs.existsSync(root)) {
    const versions = fs.readdirSync(root, {withFileTypes: true}).filter(e => e.isDirectory()).map(e => {
      const match = /^(2\.\d+\.\d+)(?:-(x64|arm64|ia32))?$/.exec(e.name);
      return match && (!match[2] || match[2] === process.arch) ? {name: e.name, version: match[1].split('.').map(Number), native: !!match[2]} : null;
    }).filter(Boolean).sort((a, b) => {
      for (let i = 0; i < 3; i++) if (a.version[i] !== b.version[i]) return b.version[i] - a.version[i];
      return Number(b.native) - Number(a.native);
    });
    for (const version of versions) {
      const file = path.join(root, version.name, process.platform === 'win32' ? 'opencode-cli.exe' : 'opencode-cli');
      if (executable(file)) return file;
    }
  }
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of process.platform === 'win32' ? ['opencode-cli.exe', 'opencode.exe'] : ['opencode', 'opencode-cli']) {
      const file = path.join(dir.replace(/^"|"$/g, ''), name);
      if (executable(file)) return file;
    }
  }
  throw Error('OpenCode CLI unavailable; set TASK_DISPATCH_OPENCODE_CLI to the official 2.x executable');
}
function runOpenCodeCli(file, args, options) {
  const child = spawn(file, args, {...options, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
  const redact = value => String(value).split(args.at(-1) || '\0').join('[prompt]')
    .replace(/\b[a-f0-9]{64}\b/gi, '[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"']+/gi, '[redacted]')
    .replace(/((?:api[_-]?key|token|password|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}&]+/gi, '$1[redacted]').slice(0, 1200);
  let buffer = '', stderr = '', errorMessage;
  const line = value => {
    try {
      const event = JSON.parse(value);
      // Keep structured errors only; assistant and tool output are not diagnostics.
      if (event.type === 'error') errorMessage = redact(event.error?.message || event.error?.type || 'Unknown CLI error');
    } catch {}
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    if (buffer.length > 16384) buffer = '';
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const done = new Promise(resolve => {
    child.once('error', error => resolve({spawnError: error.code || error.message}));
    child.once('close', (code, signal) => {
      line(buffer);
      const diagnostic = errorMessage || (stderr.trim() ? redact(stderr.trim()) : undefined);
      resolve({code, signal, ...(diagnostic ? {errorMessage: diagnostic} : {})});
    });
  });
  // Stopping the dispatcher must not terminate the participant's model turn.
  child.unref();
  child.stdout.unref?.(); child.stderr.unref?.();
  return {done};
}
function retryable(message) { const error = Error(message); error.safeToRetry = true; return error; }
function sameWorkspace(a, b) {
  return typeof a === 'string' && typeof b === 'string' && path.isAbsolute(a) && path.isAbsolute(b) && path.relative(path.resolve(a), path.resolve(b)) === '';
}
function hasMarker(info, marker) {
  return (info.turns || []).some(turn => (turn.items || []).some(item => item.type === 'userMessage' && (item.content || []).some(part => typeof part.text === 'string' && part.text.includes(`[${marker}]`))));
}
class OpenCodeWake {
  constructor({dbPath, cliPath, runCli = runOpenCodeCli, confirmTimeoutMs = 25000, pollMs = 200, sourceSession, env = process.env} = {}) {
    this.dbPath = dbPath || env.TASK_DISPATCH_OPENCODE_DB || path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');
    this.cliPath = cliPath; this.runCli = runCli; this.confirmTimeoutMs = confirmTimeoutMs; this.pollMs = pollMs;
    this.sourceSession = sourceSession; this.env = env; this.running = new Map();
  }
  async verify(binding) {
    const info = await this.read(binding);
    this.resolveCli();
    return info;
  }
  resolveCli() {
    // Desktop replaces versioned CLI directories on update/restart. Discover each
    // time while keeping explicitly configured paths fixed.
    const file = this.cliPath || findOpenCodeCli(this.env);
    if (!executable(file)) throw Error('OpenCode CLI unavailable; check TASK_DISPATCH_OPENCODE_CLI');
    return file;
  }
  async withDatabase(read) {
    if (!fs.existsSync(this.dbPath)) throw Error('OpenCode session database unavailable; set TASK_DISPATCH_OPENCODE_DB');
    let DatabaseSync;
    try { ({DatabaseSync} = await import('node:sqlite')); }
    catch { throw Error('OpenCode requires Node.js 22.13+ with built-in SQLite'); }
    const db = new DatabaseSync(this.dbPath, {readOnly: true});
    try {
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 250');
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
      if (!tables.has('session_v2') || !tables.has('session_message')) throw Error('OpenCode 2.x session tables are required; legacy tables are not used');
      return read(db, tables);
    } finally { db.close(); }
  }
  async discoverInvitation({invitationId, workspace}) {
    const marker = `[TASK-DISPATCH-INVITE:${invitationId}]`;
    return this.withDatabase(db => {
      const rows = db.prepare(`SELECT s.id, s.directory, m.data FROM session_message m
        JOIN session_v2 s ON s.id = m.session_id
        WHERE m.type = 'user' AND instr(m.data, ?) > 0
          AND (s.time_archived IS NULL OR s.time_archived = 0)`).all(marker);
      const matches = new Map();
      for (const row of rows) {
        if (!sameWorkspace(row.directory, workspace)) continue;
        let data; try { data = JSON.parse(row.data); } catch { continue; }
        if (typeof data?.text === 'string' && data.text.includes(marker)) matches.set(row.id, {id: row.id, directory: row.directory});
      }
      return [...matches.values()];
    });
  }
  async read(binding) {
    if (!/^ses_[A-Za-z0-9_-]{4,196}$/.test(binding.threadId || '')) throw Error('OpenCode requires a real ses_ session ID');
    return this.withDatabase((db, tables) => {
      const session = db.prepare('SELECT id, directory, agent, time_archived, time_idle, idle_outcome FROM session_v2 WHERE id = ?').get(binding.threadId);
      if (!session) throw Error('OpenCode session does not exist; no new session will be created');
      if (session.time_archived != null && session.time_archived !== 0) throw Error('OpenCode session is archived');
      if (typeof session.directory !== 'string' || !path.isAbsolute(session.directory)) throw Error('OpenCode session workspace required');
      const latest = db.prepare('SELECT seq, type FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 1').get(binding.threadId);
      const turns = db.prepare("SELECT seq, data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq DESC").all(binding.threadId).map(row => {
        let data; try { data = JSON.parse(row.data); } catch {}
        return {id: String(row.seq), items: [{type: 'userMessage', content: [{text: typeof data?.text === 'string' ? data.text : ''}]}]};
      });
      let pending = false, unknownQueue = false;
      for (const table of ['session_inbox', 'session_pending']) {
        if (!tables.has(table)) continue;
        const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        if (!columns.includes('session_id')) { unknownQueue = true; continue; }
        if (db.prepare(`SELECT 1 FROM ${table} WHERE session_id = ? LIMIT 1`).get(binding.threadId)) pending = true;
      }
      // time_idle may belong to a previous turn. Only the latest idle event proves idle.
      const type = pending ? 'active' : !unknownQueue && latest?.type === 'idle' && session.time_idle != null ? 'idle' : latest && latest.type !== 'idle' ? 'active' : 'unknown';
      return {thread: {id: session.id, cwd: session.directory, reachable: true, status: {type}}, turns, agent: session.agent, latestSeq: latest?.seq, idleOutcome: session.idle_outcome};
    });
  }
  async send(binding, message) {
    const marker = /^\[(TASK-DISPATCH-[A-Z-]+:[^\]\r\n]+)\]/.exec(message)?.[1];
    if (!marker) throw retryable('OpenCode wake requires a unique task-dispatch message marker');
    if (this.sourceSession && this.sourceSession === binding.threadId) throw retryable('OpenCode self-wake is not allowed');
    const current = await this.read(binding);
    if (!sameWorkspace(current.thread.cwd, binding.workspace)) throw retryable('OpenCode workspace changed');
    if (hasMarker(current, marker)) return {delivered: true, evidence: 'database-user-message'};
    if (current.thread.status.type !== 'idle' || this.running.has(binding.threadId)) throw retryable('OpenCode session is not idle');
    if (binding.model !== undefined && (typeof binding.model !== 'string' || !/^[^\s/]+\/\S+$/.test(binding.model))) throw retryable('OpenCode model must be provider/model');
    let file;
    try { file = this.resolveCli(); }
    catch { throw retryable('OpenCode CLI unavailable; check TASK_DISPATCH_OPENCODE_CLI'); }
    const args = ['run', '--session', binding.threadId, '--format', 'json'];
    if (this.env.TASK_DISPATCH_OPENCODE_AUTO === '1') args.push('--auto');
    if (binding.model) args.push('--model', binding.model);
    args.push(message);
    if (binding.canSend && !binding.canSend()) throw retryable('The binding or pending attempt changed before delivery');
    let launch;
    try { launch = this.runCli(file, args, {cwd: binding.workspace, env: this.env}); }
    catch { throw retryable('OpenCode CLI could not be started'); }
    let outcome;
    const done = Promise.resolve(launch.done).then(value => { outcome = value; }, () => { outcome = {code: 1}; }).finally(() => {
      if (this.running.get(binding.threadId) === done) this.running.delete(binding.threadId);
    });
    this.running.set(binding.threadId, done);
    const until = Date.now() + this.confirmTimeoutMs;
    let endedReads = 0;
    do {
      try {
        const info = await this.read(binding);
        if (hasMarker(info, marker)) return {delivered: true, evidence: 'database-user-message', turnEnded: info.thread.status.type === 'idle'};
      } catch {}
      if (outcome?.spawnError) {
        const error = retryable('OpenCode CLI failed to start');
        error.wakeHint = outcome.spawnError === 'ENOENT' ? 'OpenCode 启动文件已失效，下次将重新查找当前安装版本'
          : outcome.spawnError === 'EACCES' ? 'OpenCode 启动文件无执行权限，请检查安装或 CLI 配置' : 'OpenCode CLI 未能启动，请检查安装或 CLI 配置';
        throw error;
      }
      if (outcome && ++endedReads >= 3) break;
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
    } while (Date.now() < until);
    const error = Error('OpenCode delivery uncertain: no matching user message in session_message; do not resend');
    if (outcome?.errorMessage) error.wakeHint = 'OpenCode CLI 返回错误：' + outcome.errorMessage;
    else if (outcome?.code != null) error.wakeHint = 'OpenCode CLI 已退出（代码 ' + outcome.code + '），未确认通知送达';
    throw error;
  }
}
module.exports = {OpenCodeWake, findOpenCodeCli, runOpenCodeCli};
