// [AI-added] 2026-09-12 11:00
'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
class Transport extends EventEmitter {
  constructor(profile, cwd, onProcess) {
    super(); this.pending = new Map(); this.next = 0; this.buffer = ''; this.closed = false;
    if (typeof profile.command !== 'string' || !Array.isArray(profile.args)) throw Error('Profile requires executable command and args array');
    // No shell, no command interpolation, no permission bypass flags injected.
    const env = { ...process.env, ...profile.env };
    for (const k of Object.keys(env)) if (k.startsWith('TASK_DISPATCH_')) delete env[k];
    this.child = spawn(profile.command, profile.args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', e => this.fail(e));
    this.child.once('spawn', () => { try { onProcess?.(this.child.pid); } catch (e) { this.fail(e); } });
    this.child.on('error', e => { e.safeToRetry = !this.child.pid; this.fail(e); });
    this.child.stderr.on('data', () => {}); // Drain without leaking provider credentials/log contents to admin clients.
    this.exit = new Promise(resolve => this.child.once('close', (code, sig) => {
      this.closed = true;
      const e = Error(`Agent transport closed (${code ?? sig})`);
      for (const req of this.pending.values()) { clearTimeout(req.timer); req.reject(e); }
      this.pending.clear(); this.emit('closed', e); resolve();
    }));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      try {
        this.buffer += chunk;
        if (this.buffer.length > 8 * 1024 * 1024) throw Error('Agent frame exceeds limit');
        let i;
        while ((i = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, i).trim(); this.buffer = this.buffer.slice(i + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.id !== undefined && !msg.method) {
            const req = this.pending.get(msg.id); if (!req) continue;
            clearTimeout(req.timer); this.pending.delete(msg.id);
            msg.error ? req.reject(Error(msg.error.message || 'RPC error')) : req.resolve(msg.result);
          } else this.emit('message', msg);
        }
      } catch (e) { this.fail(e); }
    });
  }
  fail(e) {
    this.failure = e;
    for (const req of this.pending.values()) { clearTimeout(req.timer); req.reject(e); }
    this.pending.clear(); this.emit('failure', e);
  }
  send(method, params, request = false) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(Error('Transport is closed'));
    if (!request) { this.child.stdin.write(JSON.stringify({ method, params }) + '\n'); return; }
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('RPC timeout: ' + method)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  request(method, params) { return this.send(method, params, true); }
  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 1500);
    const hard = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    try { await this.exit; } finally { clearTimeout(timer); clearTimeout(hard); }
  }
}
module.exports = { Transport };
