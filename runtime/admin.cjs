// [AI-added] 2026-09-16: Loopback browser session, SSE replay and operator command boundary.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomic } = require('./core/storage.cjs');
const { clean } = require('./core/monitor.cjs');
const json = (res, code, data, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(data)); };
async function body(req) {
  let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 32768) throw Error('请求超过 32 KiB'); }
  return JSON.parse(text);
}
class Admin {
  constructor({ monitor, dispatcher, desktop, token, stop, registryFile }) {
    Object.assign(this, { monitor, d: dispatcher, desktop, token, stop, registryFile });
    this.root = path.dirname(monitor.directory);
    this.tickets = new Map(); this.sessions = new Map(); this.streams = new Set(); this.commands = new Map();
    this.receiptFile = path.join(monitor.directory, 'commands.json');
    try { for (const [id, receipt] of Object.entries(JSON.parse(fs.readFileSync(this.receiptFile, 'utf8')))) this.commands.set(id, receipt); }
    catch (e) { if (e.code !== 'ENOENT') this.receiptError = '管理命令收据无法读取；控制暂不可用'; }
    this.onEvent = e => { for (const stream of this.streams) stream.send('event', e, e.sequence); };
    this.onShutdown = () => { for (const stream of this.streams) stream.res.end(); };
    monitor.on('event', this.onEvent); monitor.on('shutdown', this.onShutdown);
    this.heartbeat = setInterval(() => {
      for (const [key, v] of this.sessions) if (v.expires < Date.now()) this.sessions.delete(key);
      for (const [key, v] of this.tickets) if (v < Date.now()) this.tickets.delete(key);
      const snapshot = this.streams.size ? this.overview() : null;
      for (const stream of this.streams) {
        if (stream.expires < Date.now()) { stream.res.end(); continue; }
        stream.send('snapshot', snapshot);
      }
    }, 2000); this.heartbeat.unref();
  }
  overview() { return require('./core/dashboard.cjs').aggregateSnapshot(this.monitor.snapshot(), this.root, { file: this.registryFile }); }
  bearer(req) {
    const a = Buffer.from(req.headers.authorization || ''), b = Buffer.from('Bearer ' + this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  session(req) {
    const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('td_admin='))?.slice(9);
    const s = this.sessions.get(cookie); return s && s.expires > Date.now() ? s : null;
  }
  persist() { atomic(this.receiptFile, Object.fromEntries(this.commands)); }
  async command(v) {
    if (this.receiptError) throw Error(this.receiptError);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(v.commandId || '')) throw Error('需要唯一 commandId');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
    const prior = this.commands.get(v.commandId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw Error('同一命令编号不能用于不同参数');
      if (prior.state === 'pending') throw Error('旧命令结果不确定，请先核实当前状态；不会自动重做');
      return { ...prior.result, duplicate: true };
    }
    if (v.instanceId !== this.monitor.instanceId || v.revision !== this.monitor.store.state.revision) throw Error('状态已变化，请刷新后重试');
    // [AI-added] 2026-09-17 18:54: Include bounded task reminder recovery in guarded admin commands.
    const allowed = ['start-goal','cancel-goal','configure-team','start-work','pause','resume','retry','task-budget','finish-project','reopen-project','cleanup-preview','cleanup-apply','stop','detach','assign','wake-retry','wake-remind','rebind-invite','rebind-cancel','lifecycle-preview','archive-project','restore-project','delete-project','reset-task'];
    if (!allowed.includes(v.action)) throw Error('不支持的管理操作');
    const p = this.monitor.store.state.projects[v.projectId];
    if (!['cleanup-preview','cleanup-apply','stop'].includes(v.action) && !p) throw Error('项目不存在');
    if (p?.archivedAt && !['restore-project','delete-project','lifecycle-preview'].includes(v.action)) throw Error('请先恢复已归档项目');
    if (['start-goal','cancel-goal','configure-team','start-work','pause','resume','task-budget','assign','reopen-project','stop','cleanup-apply','detach','retry','finish-project','wake-retry','wake-remind','rebind-invite','rebind-cancel'].includes(v.action) && v.confirmed !== true) throw Error('必须确认此操作影响');
    const receipt = { fingerprint, state: 'pending', at: new Date().toISOString() };
    this.commands.set(v.commandId, receipt);
    // Keep completed receipts bounded; never evict an unresolved operation.
    if (this.commands.size > 2000) for (const [id, old] of this.commands) if (old.state === 'completed') { this.commands.delete(id); break; }
    this.persist();
    this.monitor.record('operator_started', { action: v.action, projectId: v.projectId, goalId: v.goalId, taskId: v.taskId, commandId: v.commandId, summary: v.reason });
    let result;
    try {
      switch (v.action) {
        case 'start-goal': result = require('./core/goals.cjs').authorize(this.d, p.id, v.goalId, v.confirmed); break;
        case 'cancel-goal': result = require('./core/goals.cjs').cancel(this.d, p.id, v.goalId); break;
        case 'configure-team': result = require('./core/project-setup.cjs').configureTeam(this.desktop, p.id, v.workers); break;
        case 'start-work': {
          if (p.goals) {
            const drafts = Object.values(p.goals).filter(goal => goal.state === 'draft');
            const goalId = v.goalId || p.activeGoalId || p.goalQueue[0] || (drafts.length === 1 ? drafts[0].id : null);
            result = require('./core/goals.cjs').authorize(this.d, p.id, goalId, v.confirmed); break;
          }
          const team = require('./core/project-setup.cjs').team(this.desktop, p);
          if (!team.canStart) throw Error('暂不能开始，请核对所有成员已就绪、项目未暂停且尚未开始');
          result = require('./core/startup.cjs').start(this.desktop, { projectId: p.id, role: 'brain', clientId: p.bindings.brain.clientId }, { confirmed: true });
          this.monitor.wake.next = 0;
          break;
        }
        case 'lifecycle-preview': result = require('./core/lifecycle.cjs').preview(p, v); break;
        case 'archive-project': case 'restore-project': case 'delete-project': case 'reset-task':
          result = require('./core/lifecycle.cjs').apply(this, v); break;
        case 'pause': this.d.pause(v.projectId, true); break;
        case 'resume': this.d.pause(v.projectId, false); break;
        case 'retry': this.d.retry(v.projectId, v.taskId, v.confirmedStopped === true, v.restartWorker === true); break;
        case 'task-budget': this.d.taskBudget(v.projectId, v.taskId, v.additionalAttempts, v.reason); break;
        case 'finish-project': this.d.finishProject(v.projectId); break;
        case 'reopen-project': this.d.finishProject(v.projectId, true); break;
        case 'cleanup-preview': result = require('./core/maintenance.cjs').plan(this.d); break;
        case 'cleanup-apply': result = require('./core/maintenance.cjs').apply(this.d, v.previewId); break;
        case 'detach': {
          const b = p.bindings?.[v.binding];
          if (!b || b.clientId !== v.clientId) throw Error('绑定已变化');
          // Explicit operator authority uses the same unfinished-attempt guard as self-detach.
          const role = ['brain','reviewer'].includes(v.binding) ? v.binding : 'worker';
          result = this.desktop.detach({ projectId: p.id, clientId: b.clientId, role, ...(role === 'worker' ? { workerId: v.binding === 'worker' ? 'default' : v.binding.slice(7) } : {}) }); break;
        }
        case 'assign': {
          if (!p.bindings?.brain) throw Error('没有已绑定的大脑，不能改派');
          result = this.desktop.assign({ projectId: p.id, role: 'brain', clientId: p.bindings.brain.clientId }, v); break;
        }
        // [AI-added] 2026-09-17 11:46
        case 'rebind-invite': result=require('./core/rebind-invitations.cjs').create(this.monitor.store,this.root,v);break;
        case 'rebind-cancel': result=require('./core/rebind-invitations.cjs').cancel(this.monitor.store,v.projectId,v.invitationId);break;
        case 'wake-retry': {
          const t = p.tasks[v.taskId], a = t?.attempts.at(-1);
          if (!a || a.id !== v.attemptId || a.settled || a.claimedBy) throw Error('任务已变化或已领取');
          if (a.wakeNotice?.status !== 'pending') throw Error('只允许重试明确可重试的 pending 通知；送达不确定时请在原端核实并 claim/park');
          this.monitor.wake.next = 0; this.monitor.wake.tick(); result = { scheduled: true, message: '已请求按原投递保护检查，等待唤醒事件确认结果' }; break;
        }
        // [AI-added] 2026-09-17 18:43: Explicitly authorize one reminder for the current unclaimed attempt.
        case 'wake-remind': {
          const t=p.tasks[v.taskId],a=t?.attempts.at(-1),key=a&&require('./core/bindings.cjs').bindingKey(a),b=key&&p.bindings?.[key];
          if(!a||a.id!==v.attemptId||a.settled||a.claimedBy)throw Error('任务已变化、已领取或已结算');
          if(!a.delivery||!b?.wake)throw Error('当前角色没有可用的唤醒绑定');
          if(a.wakeNotice?.status==='uncertain'||a.wakeNotice?.reminder?.status==='uncertain'||a.wakeNotice?.manualReminder?.status==='uncertain')throw Error('存在送达不确定记录，请先在原会话核实，不能重复提醒');
          if(typeof v.reason!=='string'||!v.reason.trim())throw Error('再次提醒必须填写原因');
          const now=new Date().toISOString(),marker=`TASK-DISPATCH-WAKE:${a.id}:MANUAL:${v.commandId}`;
          this.monitor.store.change(s=>{const q=s.projects[v.projectId],run=q.tasks[v.taskId].attempts.at(-1),binding=q.bindings[key];binding.armed=true;binding.armedAt=now;run.wakeNotice||={};run.wakeNotice.claimStatus=run.wakeNotice.status==='sent'?'manual_requested':'initial_requested';if(run.wakeNotice.status==='sent')run.wakeNotice.manualReminder={kind:'manual',status:'pending',marker,requestedAt:now,reason:v.reason};this.monitor.store.event(s,'wake_reminder_requested',{projectId:v.projectId,taskId:v.taskId,attemptId:a.id,binding:key,commandId:v.commandId});});
          this.monitor.wake.next=0;this.monitor.wake.tick();result={scheduled:true,message:'已为当前未领取任务补充一次待命授权并请求再次提醒'};break;
        }
        case 'stop': result = { scheduled: true, message: '停止请求已接收' }; break;
      }
      result = { ok: true, ...(result || {}) };
      if (v.action !== 'lifecycle-preview') this.d.tick();
    } catch (e) { result = { ok: false, error: clean(e.message) }; }
    this.commands.set(v.commandId, { ...receipt, state: 'completed', result });
    this.persist();
    this.monitor.record('operator_completed', { action: v.action, projectId: v.projectId, goalId: v.goalId, taskId: v.taskId, commandId: v.commandId, status: result.ok ? 'completed' : 'failed', error: result.error });
    if (v.action === 'stop' && result.ok) setImmediate(() => this.stop());
    return result;
  }
  async handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return false;
    const host = `127.0.0.1:${req.socket.localPort}`, origin = `http://${host}`;
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin)) { json(res, 403, { error: '仅允许本机同源访问' }); return true; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (url.pathname === '/admin/ticket' && req.method === 'POST') {
        if (req.headers.origin || !this.bearer(req)) { json(res, 401, { error: '需要本地启动器' }); return true; }
        if (this.tickets.size >= 100) this.tickets.clear();
        const ticket = crypto.randomBytes(32).toString('hex'); this.tickets.set(ticket, Date.now() + 60000);
        json(res, 200, { ticket }); return true;
      }
      if (url.pathname === '/admin/login' && req.method === 'POST') {
        if (req.headers.origin !== origin) throw Error('需要同源登录');
        const { ticket } = await body(req), expires = this.tickets.get(ticket); this.tickets.delete(ticket);
        if (!expires || expires < Date.now()) { json(res, 401, { error: '登录票据已失效，请重新运行 web-console.bat' }); return true; }
        const id = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
        if (this.sessions.size >= 50) this.sessions.delete(this.sessions.keys().next().value);
        this.sessions.set(id, { csrf, expires: Date.now() + 8 * 3600000 });
        json(res, 200, { csrf }, { 'Set-Cookie': `td_admin=${id}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=28800` }); return true;
      }
      if (!url.pathname.startsWith('/admin/api/') || url.pathname === '/admin/api/open-project') { json(res, 404, { error: 'Not found' }); return true; }
      const session = this.session(req);
      if (!session) { json(res, 401, { error: '请运行 web-console.bat 登录管理台' }); return true; }
      if (req.method === 'POST') {
        if (req.headers.origin !== origin || req.headers['x-csrf-token'] !== session.csrf) { json(res, 403, { error: '同源控制校验失败' }); return true; }
        if (url.pathname === '/admin/api/commands') { json(res, 200, await this.command(await body(req))); return true; }
      }
      if (req.method === 'GET') {
        if (url.pathname === '/admin/api/join-invite') {
          const project = this.monitor.store.state.projects[url.searchParams.get('projectId')];
          json(res, 200, require('./core/project-setup.cjs').invitation(this.desktop, project, this.root, url.searchParams.get('binding'))); return true;
        }
        if (url.pathname === '/admin/api/session') { json(res, 200, { csrf: session.csrf }); return true; }
        if (url.pathname === '/admin/api/overview') { json(res, 200, this.overview()); return true; }
        if (url.pathname === '/admin/api/events') { json(res, 200, await this.monitor.history(url.searchParams)); return true; }
        if (url.pathname === '/admin/api/diagnostics') {
          const snapshot = this.overview(), projectId = url.searchParams.get('projectId');
          if (projectId) snapshot.projects = snapshot.projects.filter(p => p.id === projectId);
          json(res, 200, { exportedAt: new Date().toISOString(), snapshot, ...(await this.monitor.history(url.searchParams)), note: '仅包含保留期内最多 200 条匹配事件，不含凭据和对话正文' }, { 'Content-Disposition': 'attachment; filename="task-dispatch-diagnostics.json"' }); return true;
        }
        if (url.pathname === '/admin/api/stream') {
          if (this.streams.size >= 30) { json(res, 429, { error: '实时订阅数量已满' }); return true; }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          const stream = { res, expires: session.expires, drainTimer: null, send(type, data, id) {
            if (res.destroyed || res.writableEnded) return;
            // A legitimate snapshot can exceed Node's high-water mark in one write.
            // Bound sustained backpressure, not a single large frame.
            if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
            if (!res.write(`${id === undefined ? '' : 'id: ' + id + '\n'}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`) && !this.drainTimer) {
              this.drainTimer = setTimeout(() => res.destroy(), 10000);
              res.once('drain', () => { clearTimeout(this.drainTimer); this.drainTimer = null; });
            }
          } };
          const cursor = Number(req.headers['last-event-id'] || url.searchParams.get('cursor')) || 0;
          const earliest = this.monitor.recent[0]?.sequence || 0;
          if (url.searchParams.get('instanceId') !== this.monitor.instanceId || cursor < earliest - 1 || cursor > this.monitor.sequence) stream.send('reset', { reason: '服务已重启或游标过期，正在重建快照' });
          else for (const e of this.monitor.recent) if (e.sequence > cursor) stream.send('event', e, e.sequence);
          stream.send('snapshot', this.overview()); this.streams.add(stream);
          res.once('close', () => { clearTimeout(stream.drainTimer); this.streams.delete(stream); }); return true;
        }
      }
      json(res, 404, { error: '管理接口不存在' });
    } catch (e) { json(res, 400, { error: clean(e.message) }); }
    return true;
  }
  close() { clearInterval(this.heartbeat); this.onShutdown(); this.monitor.off('event', this.onEvent); this.monitor.off('shutdown', this.onShutdown); }
}
module.exports = { Admin };
