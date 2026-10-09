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
    const versions = fs.readdirSync(root, {withFileTypes: true}).filter(e => e.isDirectory() && /^2\.\d+\.\d+$/.test(e.name)).map(e => e.name).sort((a, b) => {
      const left = a.split('.').map(Number), right = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return right[i] - left[i];
      return 0;
    });
    for (const version of versions) {
      const file = path.join(root, version, process.platform === 'win32' ? 'opencode-cli.exe' : 'opencode-cli');
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
  const child = spawn(file, args, {...options, windowsHide: true, shell: false, stdio: 'ignore'});
  const done = new Promise(resolve => {
    child.once('error', error => resolve({spawnError: error.code || error.message}));
    child.once('exit', (code, signal) => resolve({code, signal}));
  });
  // Stopping the dispatcher must not terminate the participant's model turn.
  child.unref();
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
    this.cliPath ||= findOpenCodeCli(this.env);
    if (!executable(this.cliPath)) throw Error('OpenCode CLI unavailable; check TASK_DISPATCH_OPENCODE_CLI');
    return info;
  }
  async read(binding) {
    if (!/^ses_[A-Za-z0-9_-]{4,196}$/.test(binding.threadId || '')) throw Error('OpenCode requires a real ses_ session ID');
    if (!fs.existsSync(this.dbPath)) throw Error('OpenCode session database unavailable; set TASK_DISPATCH_OPENCODE_DB');
    let DatabaseSync;
    try { ({DatabaseSync} = await import('node:sqlite')); }
    catch { throw Error('OpenCode requires Node.js 22.13+ with built-in SQLite'); }
    const db = new DatabaseSync(this.dbPath, {readOnly: true});
    try {
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 250');
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
      if (!tables.has('session_v2') || !tables.has('session_message')) throw Error('OpenCode 2.x session tables are required; legacy tables are not used');
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
    } finally { db.close(); }
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
    try { file = this.cliPath || findOpenCodeCli(this.env); if (!executable(file)) throw Error('missing'); }
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
      if (outcome?.spawnError) throw retryable('OpenCode CLI failed to start');
      if (outcome && ++endedReads >= 3) break;
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
    } while (Date.now() < until);
    throw Error('OpenCode delivery uncertain: no matching user message in session_message; do not resend');
  }
}
module.exports = {OpenCodeWake, findOpenCodeCli, runOpenCodeCli};
