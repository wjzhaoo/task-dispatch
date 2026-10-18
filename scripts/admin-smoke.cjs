// [AI-added] 2026-09-16: Isolated browser fixture, never connects to real model sessions.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomic } = require('../runtime/core/storage.cjs');
const { serve } = require('../runtime/server.cjs');
const registry = require('../runtime/core/service-registry.cjs');
async function main() {
  const base = path.resolve('tmp/admin-console'); fs.mkdirSync(base, { recursive: true });
  const temp = fs.mkdtempSync(path.join(base, 'browser-')), root = path.join(temp, 'data'); fs.mkdirSync(root);
  atomic(path.join(root, 'config.json'), { version: 1, maxConcurrent: 1 });
  const port = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1]) : 43187;
  const service = await serve(root, { port:0, wakeAdapter: { forProvider: () => ({ read: async () => { throw Error('隔离演示：未连接真实模型'); } }) } });
  for (const [id, title] of [['console-demo','管理台联调示例'],['assets-demo','素材任务示例']]) {
    const workspace = path.join(temp, title); fs.mkdirSync(workspace);
    service.dispatcher.addProject({ id, workspace, mode: 'desktop' });
    service.store.change(s => { const p = s.projects[id]; p.paused = true; p.startup = { state: 'started' }; });
    service.dispatcher.addTask(id, { id: 'T01', title: id === 'console-demo' ? '验证连接与任务交接过程' : '检查场景素材清单', instructions: 'fixture only', acceptance: 'fixture only', allowedPaths: ['result.txt'] });
    const roles = { brain: 'codex', worker: 'mimo', reviewer: 'qoder' };
    for (const [role, provider] of Object.entries(roles)) {
      service.store.change(s => { s.projects[id].bindings ||= {}; s.projects[id].bindings[role] = { clientId: id + '-' + role, sessionId: id + '-' + role, armed: role !== 'worker', wake: { provider, threadId: id + '-' + role, workspace }, tokenHash: 'fixture-not-a-credential' }; });
      service.monitor.contact({ projectId: id, role, clientId: id + '-' + role }, 'park', 200, 23, { parked: true });
    }
    service.store.change(s => {
      const task = s.projects[id].tasks.T01; task.state = id === 'console-demo' ? 'reviewing' : 'blocked';
      if (id === 'assets-demo') task.error = '演示：通知尚未领取，请核实执行端是否 park';
      task.attempts.push({ id: id + '-attempt', role: 'worker', provider: 'mimo', model: 'fixture/low', startedAt: new Date(Date.now()-90000).toISOString(), claimedAt: new Date(Date.now()-70000).toISOString(), claimedBy: id+'-worker', settled: true, settledAt: new Date().toISOString(), progress: { stage: 'testing', summary: '隔离演示数据：已提交检查结果', at: new Date().toISOString() }, wakeNotice: { status: 'sent', at: new Date(Date.now()-80000).toISOString() } });
    });
  }
  service.monitor.record('demo_notice', { summary: '当前是隔离演示数据，无真实模型调用。真实联调应显式设置低思考强度。' });
  const file=path.join(temp,'registry.json');registry.register(root,registry.workspacesOf(service.store.state),{file});
  const catalog=await require('../runtime/catalog-console.cjs').serve({port,registryOptions:{file,home:path.join(temp,'home')},stateFile:path.join(temp,'console.json')});
  console.log(JSON.stringify({root,url:catalog.createTicket(),mode:'isolated-fixture-no-model-calls'}));
  const close=async()=>{await catalog.close();await service.close();fs.rmSync(temp,{recursive:true,force:true});};
  process.once('SIGINT',close);process.once('SIGTERM',close);
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
