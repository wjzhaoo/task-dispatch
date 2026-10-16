// [AI-added] 2026-09-16: Read-only projections and bounded diagnostic event journal.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { bindingKey, matches } = require('./bindings.cjs');
const attempts = require('./attempts.cjs');
// [AI-added] 2026-09-17 20:21: Prevent a stale host response from pinning probe state forever.
const hostCall = require('./host-call.cjs');
const iso = () => new Date().toISOString();
function clean(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/\b[a-f0-9]{64}\b/gi, '[已隐藏]')
    .replace(/((?:token|password|secret|api[_-]?key|credential)["']?\s*[=:]\s*)["']?[^\s,;"'}]+["']?/gi, '$1[已隐藏]').slice(0, 2000);
}
function pick(value, keys) {
  return Object.fromEntries(keys.filter(k => value?.[k] !== undefined && (value[k] === null || ['string','number','boolean'].includes(typeof value[k]))).map(k => [k, clean(value[k])]));
}
const eventKeys = ['projectId','goalId','binding','clientId','provider','role','workerId','taskId','replacementTaskId','attemptId','correlationId','revision','contractRevision','stageId','roundId','stageHeld','status','stage','error','summary','reason','durationMs','action','commandId','outcome','verdict','source','businessEventId','runtimeVersion','nodeVersion','pid'];
class Monitor extends EventEmitter {
  constructor(store, dispatcher, wake, { maxBytes = 4 * 1024 * 1024, maxFiles = 8 } = {}) {
    super(); this.setMaxListeners(100);
    this.store = store; this.d = dispatcher; this.wake = wake; this.instanceId = crypto.randomUUID();
    this.startedAt = iso(); this.runtimeVersion = require('../../package.json').version; this.maxBytes = maxBytes; this.maxFiles = maxFiles;
    this.directory = path.join(store.root, 'monitor'); this.file = path.join(this.directory, 'events.jsonl');
    this.sequence = 0; this.recent = []; this.signatures = new Map(); this.contacts = new Map(); this.probes = new Map(); this.inFlight = new Map();
    this.businessIndex = store.state.events.length; this.previous = null;
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      // Each segment is bounded; ignore only a torn final record and report damaged history.
      for (const file of this.segments()) {
        for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
          try { const e = JSON.parse(line); this.sequence = Math.max(this.sequence, e.sequence || 0); this.recent.push(e); }
          catch { this.error = '事件历史含不完整记录，已跳过'; }
        }
        this.recent = this.recent.slice(-1000);
      }
      this.bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    } catch (e) { this.error = clean(e.message); }
    store.onCommit = () => this.capture();
    // Recover durable business events following the last observed business event.
    const lastBusiness = [...this.recent].reverse().find(e => e.businessEventId);
    if (lastBusiness) {
      const index = store.state.events.findIndex(e => e.id === lastBusiness.businessEventId);
      if (index >= 0) this.businessIndex = index + 1;
      else this.error ||= '历史业务游标已不可用；本次从现有快照继续';
    } else if (this.recent.length) this.error ||= '缺少可恢复的业务游标；历史可能不完整';
    this.capture(true); this.record('service_started', { summary: '服务启动；现有任务以快照呈现，未采集的旧交互不补造', runtimeVersion:this.runtimeVersion, nodeVersion:process.version, pid:process.pid });
  }
  segments() {
    return Array.from({ length: this.maxFiles }, (_, i) => i === this.maxFiles - 1 ? this.file : this.file + '.' + (this.maxFiles - 1 - i)).filter(f => fs.existsSync(f));
  }
  record(type, data = {}) {
    const e = { eventId: crypto.randomUUID(), sequence: ++this.sequence, instanceId: this.instanceId, at: iso(), type,
      level: data.error || ['blocked','uncertain'].includes(data.status) ? 'error' : 'info', ...pick(data, eventKeys) };
    const line = JSON.stringify(e) + '\n';
    try {
      if ((this.bytes || 0) + Buffer.byteLength(line) > this.maxBytes) {
        const oldest = this.file + '.' + (this.maxFiles - 1);
        if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
        for (let i = this.maxFiles - 2; i >= 1; i--) if (fs.existsSync(this.file + '.' + i)) fs.renameSync(this.file + '.' + i, this.file + '.' + (i + 1));
        if (fs.existsSync(this.file)) fs.renameSync(this.file, this.file + '.1');
        this.bytes = 0;
      }
      fs.appendFileSync(this.file, line, { mode: 0o600 }); this.bytes = (this.bytes || 0) + Buffer.byteLength(line);
    } catch (error) { this.error = clean(error.message); }
    this.recent.push(e); if (this.recent.length > 1000) this.recent.shift();
    this.emit('event', e); return e;
  }
  contact(identity, action, status, durationMs, result = {}) {
    const key = `${identity.projectId}/${bindingKey(identity)}/${identity.clientId}`;
    const binding = this.store.state.projects[identity.projectId]?.bindings?.[bindingKey(identity)];
    const provider = binding?.wake ? binding.wake.provider || 'codex' : binding?.provider || binding?.continuation?.provider || 'unknown';
    const old = this.contacts.get(key); const now = iso();
    this.contacts.set(key, { lastRequestAt: now, action, status });
    if (!['heartbeat','status','wait'].includes(action) || status >= 400 || !old || Date.parse(now) - (old.loggedAt || 0) >= 60000) {
      this.record('desktop_request', { ...identity, provider, binding: bindingKey(identity), action, status, durationMs,
        taskId: result.taskId || result.job?.taskId, attemptId: result.attemptId || result.job?.attemptId, error: result.error,
        summary: result.nextAction || (result.parked ? '已 park，等待任务' : result.job ? '返回待办' : '请求结束') });
      this.contacts.get(key).loggedAt = Date.now();
    } else this.contacts.get(key).loggedAt = old.loggedAt;
  }
  changed(key, type, value, context, initial) {
    const signature = JSON.stringify(value);
    if (!initial && this.signatures.get(key) !== signature) this.record(type, { ...context, ...value, revision: this.store.state.revision });
    this.signatures.set(key, signature);
  }
  capture(initial = false) {
    const state = this.store.state;
    for (const event of state.events.slice(this.businessIndex)) this.record(event.type, { ...event, businessEventId: event.id, revision: state.revision });
    this.businessIndex = state.events.length;
    const bindings = new Set();
    for (const p of Object.values(state.projects)) {
      this.changed(p.id, 'project_state', { status: p.completedAt ? 'completed' : p.paused ? 'paused' : p.startup?.state || 'active' }, { projectId: p.id }, initial);
      for (const [key, b] of Object.entries(p.bindings || {})) {
        const id = `${p.id}/${key}/${b.clientId}`; bindings.add(id);
        this.changed(id, 'connection_state', { status: b.wake ? b.armed ? 'armed' : 'not_parked' : b.continuation?.mode || 'unconfigured', provider: b.wake?.provider || b.provider || b.continuation?.provider || 'unknown' }, { projectId: p.id, binding: key, clientId: b.clientId }, initial);
      }
      for (const t of Object.values(p.tasks)) {
        this.changed(`${p.id}/${t.id}`, 'task_state', { status: t.state, error: t.error || null }, { projectId: p.id, goalId: t.goalId, taskId: t.id }, initial);
        for (const a of t.attempts || []) {
          const context = { projectId: p.id, goalId: t.goalId, taskId: t.id, attemptId: a.id, role: a.role, binding: bindingKey(a), workerId: a.workerId, provider: a.provider, correlationId: a.id };
          this.changed(a.id, 'attempt_state', { status: a.settled ? 'settled' : a.claimedBy ? 'claimed' : 'prepared', summary: a.progress?.summary, stage: a.progress?.stage }, context, initial);
          if (a.wakeNotice) this.changed(a.id + '/wake', 'wake_state', a.wakeNotice, context, initial);
        }
        if (t.scopeAlert?.wakeNotice) this.changed(`${p.id}/${t.id}/scope`, 'scope_wake', t.scopeAlert.wakeNotice, { projectId: p.id, taskId: t.id }, initial);
      }
      for(const round of Object.values(p.reviewStages||{}))for(const a of [...(round.attemptHistory||[]),...(round.attempt?[round.attempt]:[])]) {
        const context={projectId:p.id,goalId:round.goalId,stageId:round.stageId,roundId:round.id,attemptId:a.id,role:'brain',binding:'brain',provider:a.provider,correlationId:a.id};
        this.changed(a.id,'attempt_state',{status:a.settled?'settled':a.claimedBy?'claimed':'prepared'},context,initial);
        if(round.wakeNotice)this.changed(a.id+'/wake','wake_state',round.wakeNotice,context,initial);
      }
      if (p.planning) this.changed(p.id + '/planning', 'planning_state', { status: p.planning.state, error: p.planning.wakeNotice?.error, summary: p.planning.needsAttention ? '收尾待办尚未处理' : p.planning.wakeNotice?.status }, { projectId: p.id }, initial);
    }
    for (const key of this.contacts.keys()) if (!bindings.has(key)) this.contacts.delete(key);
    for (const key of this.probes.keys()) if (!bindings.has(key)) this.probes.delete(key);
    this.emit('change', state.revision);
  }
  async probe(p, key, b) {
    const id = `${p.id}/${key}/${b.clientId}`;
    if (!b.wake || this.inFlight.has(id)) return;
    const previous = this.probes.get(id);
    if (previous && Date.now() - Date.parse(previous.checkedAt) < 10000) return;
    const signature = JSON.stringify(b.wake); this.inFlight.set(id, true);
    try {
      const adapter = this.wake.forProvider(b.wake.provider);
      const info = await hostCall.read(adapter,b.wake,this.wake.readTimeoutMs||15000);
      const current = this.store.state.projects[p.id]?.bindings?.[key];
      if (this.closed || current?.clientId !== b.clientId || JSON.stringify(current.wake) !== signature) return;
      if (info.thread?.id !== b.wake.threadId || !info.thread.cwd || path.relative(info.thread.cwd, p.workspace) !== '') throw Error('会话身份或工作区不匹配');
      const value = { checkedAt: iso(), status: info.thread.status?.type || 'unknown', source: 'host-api' };
      this.probes.set(id, value);
      if (JSON.stringify({ ...previous, checkedAt: null }) !== JSON.stringify({ ...value, checkedAt: null })) this.record('host_observation', { projectId: p.id, binding: key, clientId: b.clientId, provider: b.wake.provider, status: value.status, source: value.source });
    } catch (e) {
      if (this.closed || this.store.state.projects[p.id]?.bindings?.[key]?.clientId !== b.clientId) return;
      const value = { checkedAt: iso(), status: 'unreachable', error: clean(e.message), source: 'host-probe' }; this.probes.set(id, value);
        if (previous?.error !== value.error) this.record('host_observation', { projectId: p.id, binding: key, clientId: b.clientId, provider: b.wake.provider || 'codex', ...value });
    } finally { this.inFlight.delete(id); }
  }
  tick() {
    if (this.closed || this.listenerCount('change') + this.listenerCount('event') < 1) return;
    // Limit probes across all projects. Host adapters own request timeouts.
    for (const p of Object.values(this.store.state.projects)) for (const [key, b] of Object.entries(p.bindings || {})) {
      if (this.inFlight.size >= 4) return;
      void this.probe(p, key, b);
    }
  }
  snapshot() {
    const projects = Object.values(this.store.state.projects).map(p => {
      const connections = Object.entries(p.bindings || {}).map(([key, b]) => {
        const id = `${p.id}/${key}/${b.clientId}`, contact = this.contacts.get(id), observation = this.probes.get(id);
        // [AI-added] 2026-09-17 11:46
        const rebindInvitation=Object.values(p.rebindInvitations||{}).filter(invite=>invite.binding===key).sort((a,c)=>Date.parse(c.createdAt)-Date.parse(a.createdAt))[0];
        const active = Object.values(p.tasks).flatMap(t => (t.attempts || []).filter(a => !a.settled && bindingKey(a) === key).map(a => ({ taskId: t.id, attemptId: a.id, claimed: !!a.claimedBy, state: t.state })));
        if(key==='brain')for(const b of Object.values(p.reviewStages||{}))if(b.attempt&&!b.attempt.settled)active.push({taskId:'阶段 '+b.stageId+' / '+b.id,attemptId:b.attempt.id,claimed:!!b.attempt.claimedBy,state:b.state});
        return { id, binding: key, clientId: b.clientId, sessionId: b.sessionId || b.wake?.threadId, provider: b.wake ? b.wake.provider || 'codex' : b.provider || b.continuation?.provider || 'unknown',
          role: ['brain','reviewer'].includes(key) ? key : 'worker', workerId: key.startsWith('worker:') ? key.slice(7) : key === 'worker' ? 'default' : undefined,
          continuationError: clean(b.continuationError), wakeEnabled: !!b.wake, armed: !!b.armed, armedAt: b.armedAt || null, contact: contact || null, observation: observation || null,
          communication: contact && Date.now() - Date.parse(contact.lastRequestAt) < 60000 ? 'recent' : 'unknown',
          observationStale: !observation || Date.now() - Date.parse(observation.checkedAt) > 30000,
          handoverPending: !!p.handovers?.[key], rebindInvitation:rebindInvitation?pick(rebindInvitation,['id','status','expiresAt','clientId','recover']):null, active };
      });
      const tasks = Object.values(p.tasks).map(t => ({ ...pick(t, ['id','goalId','title','state','error','maxAttempts','workerId','requiredCapability','blockKind','contractRevision','stageId','roundId','stageHeld']), dependsOn: t.dependsOn || [],
        supersedes:t.supersedes||[],resolution:t.resolution||null,
        attention: t.attention ? pick(t.attention, ['id','message','kind','createdAt','acknowledged']) : null,
        budgetExhausted: attempts.exhausted(t), waitingForWorker: t.state === 'ready' && !matches(p, t),
        attempts: (t.attempts || []).map(a => ({ ...pick(a, ['id','role','workerId','provider','model','startedAt','claimedAt','settled','claimedBy']),
          // [AI-added] 2026-09-17 18:43: Expose bounded reminder evidence without credentials or prompt content.
          settledAt: a.settledAt, progress: pick(a.progress, ['at','stage','summary']), wakeNotice: a.wakeNotice ? {...pick(a.wakeNotice, ['status','at','error','marker','claimStatus']),reminder:pick(a.wakeNotice.reminder,['kind','count','status','marker','requestedAt','at','error']),manualReminder:pick(a.wakeNotice.manualReminder,['kind','status','marker','requestedAt','at','error'])} : {},
          usage: a.usage || a.observedUsage || null, usageStatus: require('./usage.cjs').observation(a) })) }));
      const alerts = [];
      for(const b of Object.values(p.reviewStages||{}))if(!require('./stage-review.cjs').ended(b)&&(b.error||b.wakeNotice?.error))alerts.push({code:'stage_attention',roundId:b.id,message:clean(b.error||b.wakeNotice.error)});
      const dispatch=require('./maintenance.cjs').dispatchStatus(this.d);
      if(dispatch.blocked && !p.completedAt && !p.archivedAt)alerts.push({code:'dispatch_blocked',message:clean(dispatch.reason)});
      if (p.paused) alerts.push({ code: 'paused', message: '项目暂停，后续调度停止' });
      if (p.startup?.state === 'waiting' && !p.goals) alerts.push({ code: 'startup', message: '等待大脑完成启动门禁' });
      if (p.planning?.state === 'pending') alerts.push({ code: 'planning', message: '阶段收尾待处理' });
      if (attempts.projectExhausted(p)) alerts.push({ code: 'project_budget', message: '项目累计额度已耗尽' });
      for (const t of tasks) {
        if (t.waitingForWorker) alerts.push({ code: 'worker_missing', taskId: t.id, message: '无匹配的执行员连接' });
        if (t.budgetExhausted && !require('./task-state.cjs').terminal(t)) alerts.push({ code: 'budget', taskId: t.id, message: '任务尝试额度已耗尽' });
        if (['blocked','uncertain'].includes(t.state)) alerts.push({ code: t.state, taskId: t.id, message: t.error || '任务需要核实' });
        if (t.attention && !t.attention.acknowledged) alerts.push({ code: 'task_attention', taskId: t.id, message: t.attention.message || '任务阻塞，等待大脑处理' });
        const a = t.attempts.at(-1);
        // [AI-added] 2026-09-17 18:43: Distinguish a normal claim grace window from an actionable stalled attempt.
        // [AI-fixed] 2026-09-19: Wait-mode attempts never get a wakeNotice; unguarded reads broke capture.
        if (a && !a.settled && a.wakeNotice?.claimStatus === 'stalled' && !a.claimedBy) alerts.push({ code: 'claim_stalled', taskId: t.id, message: '通知和补提醒均已送达，任务仍未领取；可再次提醒、改派或核实原会话' });
        else if (a && !a.settled && a.wakeNotice?.status === 'sent' && !a.claimedBy) alerts.push({ code: 'unclaimed', taskId: t.id, message: a.wakeNotice.claimStatus==='reminded'?'已补提醒，等待任务领取':'通知已送达，任务尚未领取' });
        if (a?.wakeNotice?.error && !a.settled && a.wakeNotice?.claimStatus!=='stalled') alerts.push({ code: 'wake', taskId: t.id, message: a.wakeNotice.error });
        if (a && !a.settled && a.claimedAt && Date.now() - Date.parse(a.progress.at || a.claimedAt) > 300000) alerts.push({ code: 'progress_stale', taskId: t.id, message: '已领取超过 5 分钟未见新进度；请检查原会话，不代表模型已停止' });
      }
      for (const c of connections) {
        if(c.continuationError)alerts.push({code:'continuation',binding:c.binding,message:c.continuationError});
        if(!c.wakeEnabled && !c.continuationError && ['brain','reviewer'].includes(c.role))alerts.push({code:'wake_missing',binding:c.binding,message:'尚未配置自动唤醒，请在原会话执行 resume 并核对回执。'});
        // [AI-added] 2026-09-19: Wait-only platforms have no host probe, so request silence is
        // the only liveness signal. Long model turns are legitimate silence, hence the thresholds.
        if(!c.wakeEnabled && c.contact && !p.paused && !p.completedAt && !p.archivedAt && p.startup?.state!=='waiting'){
          const silentMs=Date.now()-Date.parse(c.contact.lastRequestAt);
          if(c.active.some(a=>!a.claimed) && silentMs>300000)alerts.push({code:'wait_stalled',binding:c.binding,message:'任务已派发超过 5 分钟，该等待型执行端无任何请求；会话可能已停止，请人工检查原会话或改派。'});
          else if(!c.active.length && silentMs>600000)alerts.push({code:'connection_silent',binding:c.binding,message:'该端超过 10 分钟无任何请求；长模型回合不代表已停止，但持续协作中的等待型会话不应静默如此之久，需要时请回原会话续等或重新接入。'});
        }
        if (c.observation?.error) alerts.push({ code: 'host', binding: c.binding, message: c.observation.error });
        if (c.active.length && c.wakeEnabled && !c.armed && !c.active.some(a => a.claimed)) alerts.push({ code: 'not_parked', binding: c.binding, message: '端未 park，待办尚未领取' });
      }
      return { id: p.id, workspace: p.workspace, mode: p.mode, archivedAt: p.archivedAt, paused: !!p.paused, completedAt: p.completedAt, startup: p.startup?.state,
        ...(p.webSetup ? { title: p.title, team: require('./project-setup.cjs').team(this.wake.desktop, p), ...require('./goals.cjs').summary(p) } : {}),
        usage:require('./usage.cjs').summary(this.store.state,p.id),reviewStages:require('./stage-review.cjs').summary(p),
        planning: p.planning ? { state: p.planning.state, needsAttention: !!p.planning.needsAttention } : null, connections, tasks, alerts };
    });
    return { instanceId: this.instanceId, runtimeVersion:this.runtimeVersion, pid:process.pid, revision: this.store.state.revision, cursor: this.sequence, observedAt: iso(), startedAt: this.startedAt,
      health: { status: this.closed ? 'stopping' : 'running', error: this.error || this.store.observationError || clean(this.d.fatal?.message) || null, wakeError: clean(this.wake.error), storage: this.d.storageStatus, dispatch:require('./maintenance.cjs').dispatchStatus(this.d), retention: { maxBytes: this.maxBytes, maxFiles: this.maxFiles } }, projects };
  }
  async history(params) {
    const before = Number(params.get('before')) || Infinity, limit = Math.max(1, Math.min(200, Number(params.get('limit')) || 100));
    const filters = ['projectId','binding','taskId','attemptId','provider','level','type']; const result = [];
    for (const file of this.segments().reverse()) {
      let lines; try { lines = (await fs.promises.readFile(file, 'utf8')).split('\n'); } catch { continue; }
      for (let i = lines.length - 1; i >= 0; i--) {
        let e; try { e = JSON.parse(lines[i]); } catch { continue; }
        if (e.sequence >= before || filters.some(k => params.get(k) && e[k] !== params.get(k))) continue;
        if (params.get('q') && !JSON.stringify(e).toLowerCase().includes(params.get('q').toLowerCase())) continue;
        result.push(e); if (result.length >= limit) return { events: result, nextBefore: e.sequence };
      }
    }
    return { events: result, nextBefore: null };
  }
  close() { this.record('service_stopping', { summary: '服务停止，管理台将保留最后快照', runtimeVersion:this.runtimeVersion, nodeVersion:process.version, pid:process.pid }); this.closed = true; this.store.onCommit = null; this.emit('shutdown'); }
}
module.exports = { Monitor, clean, pick };
