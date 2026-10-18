'use strict';
// Qoder direct continuation through the onStartup App Plugin bridge.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// [AI-added] 2026-09-20: When the bridge is down, the wake loop may repair it by starting or
// restarting the Qoder app; the plugin reloads on startup and rewrites the descriptor.
const { listProcesses, restartApp, installCandidates, registryLookup } = require('../core/app-restart.cjs');

const BRIDGE_VERSION = 1;
const DESCRIPTOR_NAME = 'task-dispatch-bridge.json';
const MAX_MESSAGE_CHARS = 40000;
const INVITATION_MAX_AGE_MS = 30 * 60 * 1000;
const INVITATION_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{4,200}$/;
const PROBE_TTL_MS = 30_000;
const REPAIR_INTERVAL_MS = 10 * 60_000;
const REPAIR_MAX_FAILURES = 3;
const QODER_PROCESS_NAMES = ['Qoder'];

function isSessionId(value) { return typeof value === 'string' && SESSION_ID_RE.test(value); }
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function configDirectories(env = process.env, home = os.homedir(), override) {
  const values = [override, env.QODER_CONFIG_DIR, env.QODERCN_CONFIG_DIR, env.QODER_HOME,
    path.join(home, '.qoder-cn'), path.join(home, '.qoder')];
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => path.resolve(value)))];
}
function descriptorFile(configDir) { return path.join(path.resolve(configDir), DESCRIPTOR_NAME); }
function pluginInstalled(configDir) {
  const root = path.join(path.resolve(configDir), 'app', 'dev-extensions', 'task-dispatch-bridge');
  return fs.existsSync(path.join(root, '.qoder-app-plugin', 'plugin.json')) && fs.existsSync(path.join(root, 'dist', 'node', 'main.cjs'));
}
function readDescriptor(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!value || value.version !== BRIDGE_VERSION || typeof value.baseUrl !== 'string' ||
      typeof value.token !== 'string' || value.token.length < 32 || !pidAlive(value.pid)) return null;
  let url;
  try { url = new URL(value.baseUrl); } catch { return null; }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  return { ...value, baseUrl: url.origin };
}
function runtimeState(value) {
  const state = String(value || '').toLowerCase();
  if (['ready', 'idle', 'completed'].includes(state)) return 'idle';
  if (['opening', 'running', 'active', 'queued', 'waiting', 'needs_attention'].includes(state)) return 'active';
  return 'unknown';
}
// [AI-added] 2026-09-20: Versioned installs run the app from .qoder-versions/<ver>/; the stable
// launcher sits one level up, so prefer it when relaunching a discovered process path.
function qoderLauncherFrom(file) {
  const rewritten = file.replace(/[\\/]\.qoder-versions[\\/][^\\/]+/, '');
  return rewritten !== file && fs.existsSync(rewritten) ? rewritten : file;
}
function qoderCandidates(env = process.env) {
  return installCandidates(env, [['Programs', 'Qoder CN', 'Qoder CN.exe'], ['Qoder CN', 'Qoder CN.exe']]);
}
function repairFailure(message, action) {
  const error = Error(message);
  if (action) { error.restartable = true; error.repairAction = action; }
  return error;
}
class QoderWake {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = options.timeoutMs || 5000;
    this.directories = configDirectories(options.env, options.home, options.configDir);
    this.descriptorPath = options.descriptorPath;
    this.env = options.env || process.env;
    this.probeQoder = options.probeQoder || (() => listProcesses(QODER_PROCESS_NAMES));
    this.restartApp = options.restartApp || (opts => restartApp(opts));
    this.now = options.now || (() => Date.now());
  }
  async bridge(descriptorOverride) {
    const files = descriptorOverride ? [path.resolve(descriptorOverride)] : this.descriptorPath ? [path.resolve(this.descriptorPath)] : this.directories.map(descriptorFile);
    for (const file of files) {
      const descriptor = readDescriptor(file);
      if (descriptor) return { ...descriptor, file };
    }
    throw await this.bridgeDownError();
  }
  // Diagnose why no live descriptor was found so the reminder names the actual fix, and mark
  // the errors the wake loop may auto-repair: start Qoder when closed, restart when its plugin
  // did not load. An inconclusive probe reports unavailability without auto-repair.
  async bridgeDownError() {
    if (!this.directories.some(pluginInstalled)) return Error('Qoder direct wake bridge unavailable; install the task-dispatch Qoder bridge and restart Qoder');
    const state = await this.qoderState();
    if (state === 'stopped') return repairFailure('Qoder is not running; start Qoder and the pending wake is retried automatically', 'launch');
    if (state === 'running') {
      const stale = this.staleDescriptor();
      const exited = stale?.pid ? ` (previous bridge pid ${stale.pid} exited)` : '';
      return repairFailure(`Qoder is running but the task-dispatch App Plugin bridge is not loaded${exited}; restart Qoder to load it and the pending wake is retried automatically`, 'restart');
    }
    return Error('Qoder direct wake bridge is installed but not running; start or restart Qoder once to load the App Plugin');
  }
  async qoderState() {
    const at = this.now();
    if (this._probe && at - this._probe.at < PROBE_TTL_MS) return this._probe.state;
    let state = null;
    try {
      const procs = await this.probeQoder();
      state = Array.isArray(procs) && procs.length ? 'running' : 'stopped';
    } catch { state = null; }
    this._probe = { at, state };
    return state;
  }
  staleDescriptor() {
    const files = this.descriptorPath ? [path.resolve(this.descriptorPath)] : this.directories.map(descriptorFile);
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      if (readDescriptor(file)) return null;
      let pid = null;
      try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (Number.isInteger(value?.pid)) pid = value.pid; } catch {}
      return { file, pid };
    }
    return null;
  }
  // Rate-limited auto-repair for restartable bridge failures: one action per interval, and it
  // disables itself after repeated failures so a broken install cannot loop app restarts.
  async repairBridge(error) {
    this._repair ||= { at: 0, failures: 0 };
    if (this._repair.disabled) return { attempted: false, reason: 'disabled-after-repeated-failures' };
    if (this._repair.at && this.now() - this._repair.at < REPAIR_INTERVAL_MS) return { attempted: false, reason: 'rate-limited' };
    const action = error?.repairAction;
    if (action !== 'launch' && action !== 'restart') return { attempted: false, reason: 'no-repair-action' };
    this._repair.at = this.now();
    const result = await this.restartApp({
      names: QODER_PROCESS_NAMES, kill: action === 'restart', launcherFrom: qoderLauncherFrom,
      candidates: [this.env.TASK_DISPATCH_QODER_EXE, ...qoderCandidates(this.env)].filter(Boolean),
      fallback: () => registryLookup(['Qoder CN.exe']),
    }).catch(e => ({ attempted: false, reason: 'restart-error', error: e.message }));
    if (!result?.attempted) {
      this._repair.failures++;
      if (this._repair.failures >= REPAIR_MAX_FAILURES) this._repair.disabled = true;
    }
    return result;
  }
  async request(route, options = {}, descriptorOverride) {
    const bridge = await this.bridge(descriptorOverride), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(bridge.baseUrl + route, {
        ...options, signal: controller.signal,
        headers: { 'X-Task-Dispatch-Key': bridge.token, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
      });
      let body = null;
      try { body = await response.json(); } catch {}
      if (!response.ok) {
        const error = Error(body?.error || `Qoder bridge rejected request: HTTP ${response.status}`);
        if ([409, 429, 503].includes(response.status)) error.safeToRetry = true;
        throw error;
      }
      return body || {};
    } catch (error) {
      // [AI-added] 2026-09-20: A descriptor whose port no longer answers means the plugin host
      // died after registration; classify as restartable instead of a bare network error.
      if (error.name === 'AbortError') throw repairFailure('Qoder bridge request timed out; restart Qoder to reload the App Plugin bridge', 'restart');
      if (!error.repairAction && (error.cause?.code || error.code === 'ERR_INVALID_URL' || (error instanceof TypeError))) {
        throw repairFailure(`Qoder bridge is not responding: ${error.cause?.code || error.message}; restart Qoder to reload the App Plugin bridge`, 'restart');
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
  async read(binding, descriptorOverride) {
    if (!isSessionId(binding?.threadId)) throw Error('Qoder session ID required');
    if (typeof binding.workspace !== 'string' || !path.isAbsolute(binding.workspace)) throw Error('Qoder binding workspace required');
    const result = await this.request('/v1/sessions/' + encodeURIComponent(binding.threadId) + '/state', {}, descriptorOverride || binding.descriptorPath);
    if (result.sessionId !== binding.threadId) throw Error('Qoder bridge returned a different session');
    return { thread: { id: result.sessionId, cwd: path.resolve(binding.workspace), reachable: true,
      status: { type: runtimeState(result.runtimeState) } }, turns: [] };
  }
  async send(binding, prompt) {
    if (!isSessionId(binding?.threadId)) throw Error('Qoder session ID required');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_MESSAGE_CHARS) throw Error('Qoder wake message required');
    const marker = /\[(TASK-DISPATCH-[A-Z]+:[^\]\s]+)\]/.exec(prompt)?.[1];
    if (!marker) throw Error('Qoder wake requires a task-dispatch marker');
    const result = await this.request('/v1/sessions/' + encodeURIComponent(binding.threadId) + '/messages', {
      method: 'POST', body: JSON.stringify({ prompt, requestId: marker })
    }, binding.descriptorPath);
    if (result.sessionId !== binding.threadId || result.accepted !== true) throw Error('Qoder bridge response uncertain');
    return { delivered: true, runtimeState: result.runtimeState };
  }
  async sessions() { throw Error('Qoder direct wake requires an explicit session ID'); }
  async messages() { throw Error('Qoder direct wake does not expose conversation history'); }
  resolveInvitation({ invitationId, workspace, now = Date.now() }) {
    if (!INVITATION_ID_RE.test(invitationId || '')) throw Error('A generated Qoder invitation ID is required');
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw Error('Qoder invitation workspace required');
    const matches = [];
    for (const configDir of this.directories) {
      const file = path.join(configDir, 'task-dispatch-invitations', invitationId.toLowerCase() + '.json');
      let value;
      try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (value?.ambiguous) throw Error('Qoder invitation was used by multiple sessions; generate a new invitation');
      const createdAt = Date.parse(value?.createdAt);
      if (value?.version !== 1 || value.invitationId !== invitationId.toLowerCase() ||
          !isSessionId(value.sessionId) || typeof value.workspace !== 'string' || !path.isAbsolute(value.workspace) ||
          path.relative(path.resolve(workspace), path.resolve(value.workspace)) !== '' || !Number.isFinite(createdAt) ||
          createdAt > now + 60_000 || now - createdAt > INVITATION_MAX_AGE_MS) continue;
      matches.push({id:value.sessionId,directory:path.resolve(value.workspace),descriptorPath:descriptorFile(configDir)});
    }
    return matches;
  }
  async discoverInvitation(input) {
    const matches = []; let firstBridgeError;
    for (const record of this.resolveInvitation(input)) {
      try {
        await this.read({threadId:record.id,workspace:record.directory,descriptorPath:record.descriptorPath});
        matches.push({id:record.id,directory:record.directory});
      } catch (error) { firstBridgeError ||= error; }
    }
    if (!matches.length && firstBridgeError) throw firstBridgeError;
    return matches;
  }

}

module.exports = { QoderWake, BRIDGE_VERSION, DESCRIPTOR_NAME, MAX_MESSAGE_CHARS,
  INVITATION_MAX_AGE_MS, isSessionId, pidAlive, configDirectories, descriptorFile, pluginInstalled, readDescriptor, runtimeState };
