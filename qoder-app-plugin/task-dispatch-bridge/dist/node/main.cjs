'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const VERSION = 1;
const MAX_BODY = 64 * 1024;
const SESSION_RE = /^[A-Za-z0-9._:-]{4,200}$/;
let active = null;

function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function json(response, status, value) {
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'Cache-Control': 'no-store' });
  response.end(payload);
}
function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = crypto.createHash('sha256').update(left).digest(), b = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(a, b);
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    request.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { reject(Error('REQUEST_TOO_LARGE')); request.destroy(); } else chunks.push(chunk); });
    request.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Error('INVALID_JSON')); } });
    request.on('error', reject);
  });
}
function errorStatus(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/UNAVAILABLE|MISSING|ARCHIVED|不存在|归档|删除/.test(message)) return 404;
  if (/REJECTED|BUSY|RUNNING|运行|繁忙/.test(message)) return 409;
  if (/PERMISSION|权限|授权/.test(message)) return 403;
  if (/INVALID|TOO_LARGE/.test(message)) return 400;
  return 503;
}
async function observe(chat, sessionId) {
  return new Promise((resolve, reject) => {
    let done = false, disposable, timer;
    const finish = (error, state) => {
      if (done) return; done = true; clearTimeout(timer);
      Promise.resolve(disposable?.dispose()).catch(() => {});
      error ? reject(error) : resolve(state || {});
    };
    timer = setTimeout(() => finish(Error('QODER_SESSION_OBSERVE_TIMEOUT')), 4000);
    Promise.resolve(chat.observeTurn({ sessionId }, state => finish(null, state))).then(value => {
      disposable = value;
      if (done) Promise.resolve(disposable?.dispose()).catch(() => {});
    }, error => finish(error));
  });
}
function sessionPath(url) {
  const match = /^\/v1\/sessions\/([^/]+)\/(state|messages)$/u.exec(url.pathname);
  if (!match) return null;
  let sessionId;
  try { sessionId = decodeURIComponent(match[1]); } catch { return null; }
  return SESSION_RE.test(sessionId) ? { sessionId, action: match[2] } : null;
}
async function activate(context) {
  if (active) return;
  const pluginRoot = path.resolve(__dirname, '../..');
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'bridge-config.json'), 'utf8'));
  if (config.version !== VERSION || typeof config.descriptorPath !== 'string' || !path.isAbsolute(config.descriptorPath)) throw Error('TASK_DISPATCH_BRIDGE_CONFIG_INVALID');
  const token = crypto.randomBytes(32).toString('hex'), instanceId = crypto.randomUUID();
  const server = http.createServer((request, response) => {
    Promise.resolve().then(async () => {
      if (!equalSecret(request.headers['x-task-dispatch-key'], token)) return json(response, 401, { error: 'UNAUTHORIZED' });
      if (request.method === 'GET' && request.url === '/v1/health') return json(response, 200, { version: VERSION, instanceId });
      const url = new URL(request.url || '/', 'http://127.0.0.1'), target = sessionPath(url);
      if (!target) return json(response, 404, { error: 'NOT_FOUND' });
      if (request.method === 'GET' && target.action === 'state') {
        const state = await observe(context.api.chat, target.sessionId);
        return json(response, 200, { sessionId: target.sessionId, runtimeState: state.runtimeState || state.state || (state.activeTurnId ? 'running' : 'ready'), activeTurnId: state.activeTurnId || state.turnId || null });
      }
      if (request.method === 'POST' && target.action === 'messages') {
        const input = await readBody(request);
        if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 40000 || typeof input.requestId !== 'string' || !input.requestId.trim()) throw Error('INVALID_MESSAGE');
        const result = await context.api.chat.continueSession({ sessionId: target.sessionId, prompt: input.prompt, requestId: input.requestId });
        return json(response, 202, { accepted: true, sessionId: target.sessionId, runtimeState: result?.runtimeState || 'opening' });
      }
      return json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }).catch(error => json(response, errorStatus(error), { error: error instanceof Error ? error.message : String(error) }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  atomic(config.descriptorPath, { version: VERSION, pid: process.pid, instanceId, baseUrl: `http://127.0.0.1:${address.port}`, token, startedAt: new Date().toISOString() });
  active = { server, descriptorPath: config.descriptorPath, instanceId };
  context.subscriptions.push({ dispose: () => deactivate() });
}
async function deactivate() {
  const current = active; active = null;
  if (!current) return;
  await new Promise(resolve => current.server.close(resolve));
  try { const value = JSON.parse(fs.readFileSync(current.descriptorPath, 'utf8')); if (value.instanceId === current.instanceId) fs.rmSync(current.descriptorPath, { force: true }); } catch {}
}

module.exports = { activate, deactivate };
