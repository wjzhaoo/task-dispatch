'use strict';
const {bindingKey}=require('./core/bindings.cjs');
// [AI-added] 2026-09-12 11:00

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store, read, atomic } = require('./core/storage.cjs');
const { Dispatcher } = require('./core/dispatcher.cjs');
const { factory } = require('./adapters/agents.cjs');
const { Desktop } = require('./core/desktop.cjs');
function validateConfig(c) {
  if (c.version !== 1 || typeof c.enableRealCalls !== 'boolean' || !Number.isInteger(c.maxConcurrent) || c.maxConcurrent < 1 || c.maxConcurrent > 16) throw Error('Invalid config/version/maxConcurrent');
  if (!c.profiles || typeof c.profiles !== 'object' || !Object.keys(c.profiles).length) throw Error('No profiles configured');
  for (const p of Object.values(c.profiles)) {
    if (!['codex', 'zcode'].includes(p.adapter) || typeof p.command !== 'string' || !p.command || !Array.isArray(p.args) || p.args.some(x => typeof x !== 'string')) throw Error('Invalid adapter profile');
    if (p.timeoutMs !== undefined && (!Number.isInteger(p.timeoutMs) || p.timeoutMs < 1000)) throw Error('Invalid timeout');
  }
}
async function serve(root, { adapterFactory, wakeAdapter, port = 0, logger = () => {} } = {}) {
  const config = read(path.join(root, 'config.json')); validateConfig(config);
  const store = new Store(root);
  const tokenFile = path.join(root, 'admin-token');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const dispatcher = new Dispatcher(store, config, adapterFactory || factory(config));
  const serviceLog = value => { try { logger(value); } catch (error) { dispatcher.logError = error.message; } };
  const syncRegistry = () => {
    const registry = require('./core/service-registry.cjs');
    const result = registry.tryRegister(store.root, registry.workspacesOf(store.state));
    if (result.error) dispatcher.registryError = result.error;
  };
  const desktop = new Desktop(dispatcher);
  // [AI-added] 2026-09-15 18:56
/* Previous implementation:
const wake = new (require('./core/wake.cjs').Wake)(desktop, wakeAdapter || new (require('./adapters/mimo-wake.cjs').WakeProviders)());
*/
const wake = new (require('./core/wake.cjs').Wake)(desktop, wakeAdapter || new (require('./adapters/mimo-wake.cjs').WakeProviders)({qoder:{dataRoot:root}}));
  let stopping = false, timer, usageCollection = null, nextUsageCollection = 0;
  // [AI-added] 2026-09-16: Browser monitoring shares the existing service and business guards.
  const monitor = new (require('./core/monitor.cjs').Monitor)(store, dispatcher, wake);
  const admin = new (require('./admin.cjs').Admin)({ monitor, dispatcher, desktop, token, stop: () => close() });
  syncRegistry();
  try { dispatcher.recover(); } catch (e) { monitor.close(); admin.close(); store.close(); throw e; }
  const waiters = new Set();
  const server = http.createServer(async (req, res) => {
    if (await admin.handle(req, res)) return;
    let observedResult;
    const reply = (code, data) => { observedResult = data; res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    if (req.headers.origin) return reply(403, { error: 'Browser origins are not allowed' });
    if (req.method === 'POST' && req.url === '/desktop') {
      if (stopping) return reply(503, { error: 'Service stopping' });
      let identity, observedAction, observedInput;
      const requestStarted = Date.now();
      try { identity = desktop.authenticate((req.headers.authorization || '').replace(/^Bearer /, '')); }
      catch (e) { return reply(401, { error: e.message }); }
      res.once('finish', () => { if (observedAction) monitor.contact(identity, observedAction, res.statusCode, Date.now() - requestStarted, { ...observedInput, ...observedResult }); });
      try {
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) throw Error('Request too large'); }
        const v = JSON.parse(body);
        observedAction = v.action; observedInput = { taskId: v.taskId, attemptId: v.attemptId };
        desktop.assertBinding(identity);
        if (v.action === 'heartbeat') return reply(200,{ok:true});
        if (v.action === 'start-work') return reply(200,require('./core/startup.cjs').start(desktop,identity,v));
        if (v.action === 'wake-bind') return reply(200, await wake.bind(identity, v));
        if (v.action === 'configure-continuation') return reply(200, await require('./core/continuation.cjs').configure(wake, identity, v));
        if (v.action === 'park') return reply(200, wake.park(identity));
        if (v.action === 'detach') return reply(200,desktop.detach(identity,v.workerId,v.targetRole));
        if (v.action === 'assign') return reply(200,desktop.assign(identity,v));
        if (v.action === 'task-budget') return reply(200,desktop.taskBudget(identity,v));
        // [AI-added] 2026-09-21 09:38: Brain-authenticated recovery actions avoid administrator-token workarounds.
        if (v.action === 'retry') return reply(200,desktop.retry(identity,v));
        if (v.action === 'configure-repair') return reply(200,desktop.configureRepair(identity,v));
        if (v.action === 'reconcile-review') return reply(200,desktop.reconcileReview(identity,v));
        if (v.action === 'revise-task') return reply(200,desktop.reviseTask(identity,v));
        if (v.action === 'resolve-task') return reply(200,desktop.resolveTask(identity,v));
        if (v.action === 'staff') return reply(200,desktop.staff(identity,v));
          if (v.action === 'status') return reply(200, desktop.status(identity));
          // [AI-added] 2026-09-22 09:55: Brain-only activity boundaries with authentic platform usage.
          if (v.action === 'activity-start') return reply(200,require('./core/brain-activities.cjs').start(desktop,identity,v));
          if (v.action === 'activity-end') return reply(200,require('./core/brain-activities.cjs').end(desktop,identity,v));
          // [AI-added] 2026-09-22 10:20: Explicit opt-in and separate shared receipt protocol.
          if (['stage-register','stage-submit','stage-resume'].includes(v.action)) return reply(200,require('./core/stage-review.cjs')[v.action.slice(6)](desktop,identity,v));
          // [AI-added] 2026-09-22 09:20: Authenticated, non-mutating attempt inspection.
          if (v.action === 'preflight') return reply(200, desktop.preflight(identity,v));
        if (v.action === 'finish-project') return reply(200, desktop.finishProject(identity));
        if (v.action === 'scope-ack') {const result=require('./core/scope-recovery.cjs').acknowledge(desktop,identity,v);require('./core/brain-activities.cjs').autoEnd(desktop,identity,'scope:'+v.alertId);return reply(200,result);}
        if (v.action === 'attention-ack') return reply(200,require('./core/brain-attention.cjs').acknowledge(desktop,identity,v));
        if (v.action === 'claim') return reply(200, desktop.completion(identity) || {job:desktop.claim(identity)});
        if (v.action === 'submit') return reply(200, desktop.submit(identity, v));
        if (v.action === 'plan') return reply(200, desktop.plan(identity, v.task));
        if (v.action === 'closeout') return reply(200, desktop.closeout(identity, v));
        if (v.action === 'progress') return reply(200, desktop.progress(identity, v));
        if (v.action !== 'wait') throw Error('Unknown desktop action');
        const completedReply = () => {
          const completed=desktop.completion(identity);if(!completed)return false;
          // Old clients only recognize job; 410 makes their retry loop terminate.
          reply(v.acceptCompleted===true?200:410,v.acceptCompleted===true?completed:{...completed,error:completed.message});return true;
        };
        if(completedReply())return;
        if (store.state.projects[identity.projectId].bindings[bindingKey(identity)].wake) throw Error('Wake enabled: use claim/park instead of wait');
        const first = desktop.claim(identity); if (first) return reply(200, { job: first });
        // Bounded HTTP polls are renewed by the local client, not by the LLM.
        let poll, timeout;
        const cleanup = () => { clearInterval(poll); clearTimeout(timeout); waiters.delete(cancel); res.off('close', cleanup); };
        const finish = (code, value) => { cleanup(); if (!res.destroyed) reply(code, value); };
        const cancel = () => finish(503, { error: 'Service stopping' });
        waiters.add(cancel); res.once('close', cleanup);
        poll = setInterval(() => { try {
          const completed=desktop.completion(identity);
          if(completed){finish(v.acceptCompleted===true?200:410,v.acceptCompleted===true?completed:{...completed,error:completed.message});return;}
          const job = desktop.claim(identity); if (job) finish(200, { job });
        } catch (e) { finish(400, { error: e.message }); } }, 250);
        timeout = setTimeout(() => finish(200, { job: null }), 20000);
        return;
      } catch (e) { return reply(400, { error: e.message }); }
    }
    const supplied = Buffer.from(req.headers.authorization || ''), expected = Buffer.from('Bearer ' + token);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return reply(401, { error: 'Unauthorized' });
    if (req.headers.origin) return reply(403, { error: 'Browser origins are not allowed' });
    /* Previous implementation:
    if (req.method === 'GET' && req.url === '/status') return reply(200, { ...store.state, runtimeVersion: '0.3.0', usage: require('./core/usage.cjs').summary(store.state), usageError:dispatcher.usageError, storage: dispatcher.storageStatus, active: [...dispatcher.active.keys()], stopping: dispatcher.stopping, fatal: dispatcher.fatal?.message });
    */
    // [AI-added] 2026-09-14 19:48
    if (req.method === 'GET' && req.url === '/status') return reply(200, { ...store.state, runtimeVersion: require('../package.json').version, usage: require('./core/usage.cjs').summary(store.state), usageError:dispatcher.usageError, storage: dispatcher.storageStatus, active: [...dispatcher.active.keys()], stopping: dispatcher.stopping, fatal: dispatcher.fatal?.message });
    if (req.method !== 'POST' || req.url !== '/command') return reply(404, { error: 'Not found' });
    if (stopping) return reply(409, { error: 'Service stopping' });
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) throw Error('Request too large'); }
      const v = JSON.parse(body);
      switch (v.action) {
        case 'add-project': dispatcher.addProject(v.project); syncRegistry(); break;
        case 'attach-desktop': { const result = desktop.attach(v); syncRegistry(); return reply(200, result); }
        case 'add-task': dispatcher.addTask(v.projectId, v.task); break;
        case 'pause': dispatcher.pause(v.projectId, true); break;
        case 'resume': dispatcher.pause(v.projectId, false); break;
        case 'finish-project': dispatcher.finishProject(v.projectId); break;
        case 'reopen-project': dispatcher.finishProject(v.projectId,true); break;
        case 'retry': dispatcher.retry(v.projectId, v.taskId, v.confirmedStopped, v.restartWorker === true); break;
        case 'return-scope': require('./core/scope-recovery.cjs').request(dispatcher,v.projectId,v.taskId); break;
        case 'reconcile-review': dispatcher.reconcileReview(v.projectId,v.taskId,v.config); break;
        case 'budget': dispatcher.budget(v.projectId, v.maxTurns); break;
        case 'task-budget': dispatcher.taskBudget(v.projectId,v.taskId,v.additionalAttempts,v.reason); break;
        case 'configure-validation': dispatcher.configureValidation(v.projectId,v.config,v.profileName); break;
        case 'configure-snapshot': dispatcher.configureSnapshot(v.projectId, v.config); break;
        case 'prepare-review': dispatcher.prepareReview(v.projectId, v.taskId, v.evidence); break;
        case 'configure-repair': dispatcher.configureRepair(v.projectId, v.taskId, v.config); break;
        case 'usage': return reply(200, require('./core/usage.cjs').summary(store.state, v.projectId));
        case 'collect-usage': return reply(200, await require('./core/codex-usage.cjs').collect(dispatcher));
        case 'record-usage': return reply(200, require('./core/usage.cjs').record(store, v.projectId, v.taskId, v.attemptId, v.usage));
        case 'configure-storage': {
          const config = require('./core/maintenance.cjs').policy(v.config);
          store.change(s => { s.storagePolicy = config; }); break;
        }
        case 'cleanup-preview': return reply(200, require('./core/maintenance.cjs').plan(dispatcher));
        case 'cleanup-apply': return reply(200, require('./core/maintenance.cjs').apply(dispatcher, v.previewId));
        case 'stop': reply(200, { ok: true }); setImmediate(() => close()); return;
        default: throw Error('Unknown operator action');
      }
      reply(200, { ok: true }); dispatcher.tick();
    } catch (e) { reply(400, { error: e.message }); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  async function close() {
    if (stopping) return; stopping = true; clearInterval(timer);
    serviceLog({at:new Date().toISOString(),level:'info',event:'service_stopping',runtimeVersion:require('../package.json').version,instanceId:monitor.instanceId,pid:process.pid,dataRoot:root});
    monitor.close(); admin.close();
    for (const cancel of [...waiters]) cancel();
    await wake.close();
    await dispatcher.stop();
    await usageCollection;
    const closed = new Promise(resolve => server.close(resolve));
    // Also close connections accepted just before shutdown but not yet registered as waiters.
    server.closeAllConnections();
    await closed;
    const endpoint = path.join(root, 'endpoint.json');
    if (fs.existsSync(endpoint)) fs.unlinkSync(endpoint);
    store.close();
  }
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (e) { monitor.close(); admin.close(); store.close(); throw e; }
  atomic(path.join(root, 'endpoint.json'), { pid: process.pid, port: server.address().port, version: require('../package.json').version });
  serviceLog({at:new Date().toISOString(),level:'info',event:'service_started',runtimeVersion:require('../package.json').version,nodeVersion:process.version,instanceId:monitor.instanceId,pid:process.pid,port:server.address().port,dataRoot:root});
  let nextMaintenance = 0;
  const maintenance = () => {
    if (Date.now() < nextMaintenance) return;
    nextMaintenance = Date.now() + 60000;
    try {
      const m = require('./core/maintenance.cjs'), p = m.plan(dispatcher);
      let reclaimed = 0;
      if (p.policy.automatic && p.entries.length) reclaimed = m.apply(dispatcher, p.previewId).reclaimedBytes;
      dispatcher.storageBlocked = p.totalBytes - reclaimed > p.policy.maxBytes;
      dispatcher.storageStatus = { totalBytes:p.totalBytes-reclaimed,maxBytes:p.policy.maxBytes,blocked:dispatcher.storageBlocked,checkedAt:new Date().toISOString() };
    } catch (e) { dispatcher.storageBlocked = true; dispatcher.storageStatus = { blocked: true, error: e.message }; }
  };
  maintenance();
  timer = setInterval(() => {
    monitor.tick();
      // [AI-added] 2026-09-22 09:20: No agent wake while durable receipt recovery is pending.
      maintenance(); dispatcher.tick(); if(!dispatcher.pendingSettlements.size)wake.tick();
    if (!usageCollection && Date.now() >= nextUsageCollection && !stopping) {
      nextUsageCollection = Date.now() + 300000;
      usageCollection = require('./core/codex-usage.cjs').collect(dispatcher).catch(e => { dispatcher.usageError = e.message; }).finally(() => { usageCollection = null; });
    }
  }, 1000); // Local polling only; usage collection reads local logs, never calls a model.
  dispatcher.tick();
  return { server, dispatcher, store, monitor, admin, close };
}
module.exports = { serve, validateConfig };
