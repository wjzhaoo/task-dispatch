'use strict';
// [AI-added] 2026-09-14 09:43
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline/promises');
const { read, Store } = require('./core/storage.cjs');
const cli = path.join(__dirname, 'cli.cjs');
// [AI-added] 2026-09-16 16:00
function dataRoot(args, context = {}) {
  try {
    const roots = require('./core/data-root.cjs');
    const workspace = context.workspace || roots.workspaceArgument(args);
    // [AI-added] 2026-09-17 11:46
    if (!workspace && !roots.dataArgument(args) && !context.data && !roots.credentialData(context.credentialFile)) {
      const candidates = require('./core/service-registry.cjs').catalog(context.registryOptions);
      const serviceRoots = [...new Set(candidates.filter(entry => entry.dataExists).map(entry => entry.dataRoot))];
      if (serviceRoots.length === 1) return serviceRoots[0];
      throw Error(candidates.length ? '检测到多个项目；请从管理台项目清单选择，不需要传 --workspace' : '尚无已登记项目；请先在项目会话中执行 connect');
    }
    return roots.resolveDataRoot({ args, ...context, workspace });
  }
  catch (error) {
    if (error.message === '--data requires directory') throw Error('--data 后需要目录');
    if (error.message === '--workspace requires directory') throw Error('--workspace 后需要目录');
    throw error;
  }
}
// [AI-added] 2026-09-17 13:54
function catalogEntries(options = {}) { return require('./core/service-registry.cjs').catalog(options); }
// [AI-added] 2026-09-17 13:54
function bootstrapRoot(args = [], context = {}) {
  const roots = require('./core/data-root.cjs');
  if (roots.dataArgument(args) || roots.workspaceArgument(args) || context.data || context.workspace || roots.credentialData(context.credentialFile)) return dataRoot(args, context);
  const candidates = catalogEntries(context.registryOptions).filter(entry => entry.dataExists);
  const selected = candidates.find(entry => entry.online) || candidates[0];
  if (!selected) throw Error('尚无已登记项目；请先在项目会话中执行 connect');
  return selected.dataRoot;
}
function initialize(root) { return require('./core/config.cjs').initialize(root); }
function serviceClient(root) {
  const endpoint = read(path.join(root, 'endpoint.json'));
  const token = fs.readFileSync(path.join(root, 'admin-token'), 'utf8').trim();
  return { async request(body, route = body ? 'command' : 'status') {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/${route}`, {
      method:body ? 'POST' : 'GET', headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(body ? 60000 : route.startsWith('ready') ? 1000 : 5000)
    });
    const result=await response.json(); if(!response.ok)throw Object.assign(Error(result.error),{status:response.status}); return result;
  }};
}
async function request(root, body) { return serviceClient(root).request(body); }
async function online(root) { try { return await request(root); } catch { return null; } }
async function start(root, { port, connection } = {}) {
  initialize(root);
  const query = connection ? '?' + new URLSearchParams(connection) : '';
  let lastError;
  const probe = async () => {
    try {
      const client=serviceClient(root), status=await client.request(undefined,'ready'+query);
      if(status.connectionProtocol!==require('./core/connection.cjs').PROTOCOL)throw Object.assign(Error('服务 connect 接口版本不匹配；请在授权范围内重启对应项目服务。'),{protocolMismatch:true});
      return status.ready ? {...status,request:client.request} : null;
    } catch(error) {
      if(error.status===404)throw Error('运行中的服务尚不支持 connect 接口（GET /ready 返回 404）；请在授权范围内重启对应项目服务。');
      if(error.status===401||error.status===403||error.protocolMismatch)throw error;
      lastError=error;return null;
    }
  };
  const running=await probe();if(running)return running;
  return require('./core/file-lock.cjs').withFileLock(path.join(root,'startup.lock'),async()=>{
    const running=await probe();if(running)return running;
    const serviceLock=path.join(root,'service.lock');let live=false,failure;
    if(fs.existsSync(serviceLock)){const lock=read(serviceLock);live=!Number.isInteger(lock.pid)||require('./core/storage.cjs').alive(lock.pid);if(!live)Store.unlock(root);}
    if(!live){
      const log=fs.openSync(path.join(root,'service.log'),'a');let child;
      try{child=spawn(process.execPath,[cli,'start','--data',root,...(port===undefined?[]:['--port',String(port)])],{detached:true,windowsHide:true,stdio:['ignore',log,log]});}
      finally{fs.closeSync(log);}
      child.on('error',error=>{failure=error;});
      child.on('exit',(code,signal)=>{failure=Error('服务启动进程退出（'+(signal||code)+'），请查看 '+path.join(root,'service.log'));});child.unref();
    }
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      if(failure)throw failure;
      const ready=await probe();if(ready)return ready;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('服务未在 30 秒内就绪：'+(lastError?require('./core/continuation.cjs').detail(lastError):'未知原因')+'；请查看 '+path.join(root,'service.log'));
  });
}
// [AI-added] 2026-09-21 09:38: Keep CLI labels aligned with the Web console terminal states.
const labels = { ready: '待执行', running: '执行中', review_ready: '待审核', reviewing: '审核中', accepted: '已通过', resolved: '已由后续任务解决', blocked: '阻塞', uncertain: '需核实旧进程' };
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw Error('需要 Node.js 22 或更新版本');
  const args = process.argv.slice(2);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (text, fallback = '') => (await rl.question(text + (fallback ? ` [${fallback}]` : '') + '：')).trim() || fallback;
  const required = async text => { const v = await ask(text); if (!v) throw Error('此项不能为空'); return v; };
  const choose = async (title, values) => {
    if (!values.length) throw Error('没有可选项');
    console.log(title); values.forEach((v, i) => console.log(`  ${i + 1}. ${v}`));
    const n = Number(await ask('选择编号', '1')); if (!Number.isInteger(n) || n < 1 || n > values.length) throw Error('无效编号'); return values[n - 1];
  };
  // [AI-added] 2026-09-17 13:54
  let root;
  try {
    const roots = require('./core/data-root.cjs'), explicit = roots.dataArgument(args) || roots.workspaceArgument(args);
    if (explicit) root = dataRoot(args);
    else {
      // [AI-added] 2026-09-17 14:23
      let entries = catalogEntries().filter(entry => entry.dataExists);
      while (!entries.length) {
        const known = catalogEntries();
        console.log('\nTask Dispatch 项目目录\n当前没有可打开的项目。管理入口保持可用，不会创建用户级空调度服务。');
        if (known.length) console.log(`目录中有 ${known.length} 个失效项目，请核对工作目录或项目缓存。`);
        const action = await ask('1 刷新项目目录  0 退出', '1');
        if (action === '0') { rl.close(); return; }
        entries = catalogEntries().filter(entry => entry.dataExists);
      }
      // [AI-added] 2026-09-17 19:07
      const label = entry => `${entry.projectId || require('./core/storage.cjs').workspaceKey(entry.workspace)} | ${entry.workspace}${entry.online ? '（运行中）' : ''}`;
      const choice = entries.length === 1 ? entries[0] : await choose('选择项目', entries.map(label));
      const selected = typeof choice === 'string' ? entries.find(entry => label(entry) === choice) : choice;
      if (!selected) throw Error('项目目录已变化，请重新打开看板');
      root = selected.dataRoot;
    }
    initialize(root);
  } catch (error) { rl.close(); throw error; }
  const project = async () => {
    const projects = Object.values((await request(root)).projects);
    if (!projects.length) throw Error('尚无桌面项目；请在目标会话使用 start.bat connect 接入');
    console.log('选择项目');
    projects.forEach((p, i) => console.log(`  ${i + 1}. ${p.id} | ${p.workspace}`));
    const n = Number(await ask('选择编号', '1'));
    if (!Number.isInteger(n) || n < 1 || n > projects.length) throw Error('无效编号');
    return projects[n - 1].id;
  };
  console.log('\nTask Dispatch 任务看板与控制台\n数据保存在：' + root);
  console.log('桌面项目由 start.bat connect 自动接入；任务由 brain 通过 plan 登记。');
  try { while (true) {
    const status = await online(root);
    console.log(`\n服务：${status ? '运行中' : '未运行'}`);
    console.log('1 启动服务 / 恢复队列\n2 查看任务看板\n3 暂停 / 继续项目\n4 处理阻塞 / 追加任务尝试次数\n5 结束项目 / 重新开启\n6 存储 / 快照 / 消耗统计\n7 停止服务\n0 退出（后台服务继续运行）');
    const action = await ask('选择', '2');
    try {
      if (action === '0') break;
      if (action === '6') {
        if (!status) throw Error('服务未运行，请先选择 1');
        const mode = await ask('1 消耗统计  2 清理预览  3 存储策略  4 项目快照策略', '1');
        if (mode === '1') {
          await request(root, {action:'collect-usage'});
          const result = await request(root, {action:'usage'});
          for (const g of result.groups) console.log(`${g.projectId} / ${g.role} / ${g.provider} / ${g.model}\n  尝试 ${g.attempts}；完整计量 ${g.measuredAttempts}；时间窗口计量 ${g.partialAttempts}；未知 ${g.unknownAttempts}${g.unknownAttempts?'（'+Object.entries(g.unknownReasons).map(([reason,count])=>reason+' × '+count).join('，')+'）':''}\n  已知输入 ${g.knownTokens.inputTokens}（含缓存 ${g.knownTokens.cachedInputTokens}），输出 ${g.knownTokens.outputTokens}（含推理 ${g.knownTokens.reasoningOutputTokens}）`);
          // [AI-added] 2026-09-22 10:20: Do not sum overlapping reported and observed windows.
          for(const m of result.workflow||[])console.log(m.projectId+'：准备 '+m.prepared+' / 领取 '+m.claimed+' / 结算 '+m.settled+'；业务返修 '+m.businessRepairs+'；初审放行后退回 '+m.postPreReviewReturns+'/'+m.matchedCandidates+'；历史'+(m.historyComplete?'已有记录可查':'不完整'));
          for(const a of result.activityGroups||[])console.log(a.projectId+' / '+a.kind+' / '+a.source+'：输入 '+(a.usage?.inputTokens??'未知')+'，输出 '+(a.usage?.outputTokens??'未知'));
          console.log('去重观测输入 '+(result.observedUniqueTokens?.inputTokens??'未知')+'，输出 '+(result.observedUniqueTokens?.outputTokens??'未知')+'。未知不按零计算；平台上报与观测值不相加。没有真实对照数据，不能计算节省比例。');
        } else if (mode === '2') {
          const preview = await request(root,{action:'cleanup-preview'});
          console.log(`副本总量 ${(preview.totalBytes/1024**3).toFixed(2)} GiB，可释放 ${(preview.reclaimableBytes/1024**2).toFixed(1)} MiB；${preview.entries.length} 个目录。`);
          for (const e of preview.entries) console.log(`  ${e.relative} ${(e.bytes/1024**2).toFixed(1)} MiB`);
          if (preview.entries.length && (await ask('按上述预览清理？y/n','n')).toLowerCase()==='y') console.log(await request(root,{action:'cleanup-apply',previewId:preview.previewId}));
        } else if (mode === '3') {
          const config = {automatic:(await ask('自动清理已完成任务的副本？y/n','y')).toLowerCase()==='y',retainDays:Number(await ask('旧任务快照保留天数','7')),keepLatestAccepted:Number(await ask('至少保留最近几个已通过任务的快照','2')),maxBytes:Math.round(Number(await ask('服务副本容量上限 GiB','10'))*1024**3)};
          await request(root,{action:'configure-storage',config}); console.log('已保存；未完成任务的恢复文件始终保留，超限则停止派发新任务。');
        } else if (mode === '4') {
          const projectId=await project(),file=(await required('快照配置 JSON 路径')).replace(/^"(.*)"$/,'$1');
          await request(root,{action:'configure-snapshot',projectId,config:read(file)}); console.log('已更新后续快照策略。');
        }
      } else if (action === '1') { await start(root); console.log('服务已在后台启动。'); }
      else if (action === '2') {
        if (!status) { console.log('服务未运行。选择 1 可恢复。'); continue; }
        if (status.fatal) console.log('服务错误：' + status.fatal);
        const registry=require('./core/service-registry.cjs'),services=registry.discover(root),listed=[],seen=new Set();
        for(const service of services){let projects;try{projects=service.current?status.projects:registry.stateAt(service.root)?.projects||{};}catch{continue;}
          for(const p of Object.values(projects))if(!seen.has(p.id)){seen.add(p.id);listed.push({p,service});}}
        for (const {p,service} of listed) {
          const source=service.current?'当前服务':'项目/自定义缓存';
          console.log(`\n项目：${p.id} ${p.completedAt ? '（已结束）' : p.paused ? '（暂停）' : ''}${service.current?'':'（只读汇总）'}\n路径：${p.workspace}\n来源：${source} | ${service.root} | ${service.online?'运行中':'未运行'}\n项目累计次数：${p.turns} / ${p.projectBudgetEnabled?p.maxTurns:"未启用项目保护"}`);
          for (const t of Object.values(p.tasks)) console.log(`  ${t.id} 任务尝试次数 ${require('./core/attempts.cjs').counts(t).total}/${t.maxAttempts}（执行 ${require('./core/attempts.cjs').counts(t).execution}，审核 ${require('./core/attempts.cjs').counts(t).review}）${labels[t.state] || t.state}${t.blockKind==='environment'?'（验证环境）':''}：${t.title}${t.error ? '\n    ' + t.error : ''}`);
          for (const t of Object.values(p.tasks)) { const n=t.attempts.at(-1)?.wakeNotice; if(n)console.log(`    ${t.id} 唤醒通知：${n.status || '待连接'}${n.error ? ' / '+n.error : ''}`); }
          for (const t of Object.values(p.tasks)) { const progress=t.attempts.at(-1)?.progress;if(progress)console.log(`    ${t.id} 最近进度 ${progress.at}：${progress.stage} / ${progress.summary}`); }
        }
        if (!listed.length) console.log('尚无桌面项目；请在目标会话使用 start.bat connect 接入。');
      } else if (action === '3') {
        if (!status) throw Error('服务未运行，请先选择 1');
        const projectId = await project(); const p = (await request(root)).projects[projectId];
        await request(root, { action: p.paused ? 'resume' : 'pause', projectId }); console.log(p.paused ? '已继续。' : '已暂停后续调度，当前回合继续。');
      } else if (action === '4') {
        if (!status) throw Error('服务未运行，请先选择 1');
        const projectId = await project(); const p = (await request(root)).projects[projectId];
        const recovery = await ask('1 重试阻塞任务  2 追加任务尝试次数  3 配置审核验证环境', '1');
        if (recovery === '3') {
          const file=(await required('验证配置 JSON 路径（T2 可用仓库 examples/redblueprint-validation.json）')).replace(/^"(.*)"$/, '$1');
          const config=read(file);console.log(JSON.stringify(config,null,2));
          if((await ask('允许服务在独立副本复制现有依赖并运行这些检查？y/n','y')).toLowerCase()==='y')await request(root,{action:'configure-validation',projectId,config});
          console.log('配置后用菜单 4 → 1 重试审核，不要选择重新交给执行员。');
        } else if (recovery === '2') {
          const taskId=await choose('选择任务',Object.keys(p.tasks));
          const additionalAttempts=Number(await required('追加任务尝试次数'));
          const reason=await required('追加原因');
          await request(root,{action:'task-budget',projectId,taskId,additionalAttempts,reason});console.log('已追加任务额度；暂停中的项目请用菜单 3 继续。');
        } else {
          const taskId = await choose('选择任务', Object.values(p.tasks).filter(t => ['blocked', 'uncertain'].includes(t.state)).map(t => t.id));
          const t = p.tasks[taskId]; console.log(t.error || '');
          let confirmedStopped = false;
          if (t.state === 'uncertain') {
            console.log('旧平台进程 PID：' + (t.attempts.at(-1)?.pid || '未知'));
            confirmedStopped = (await ask('已检查旧执行进程及后台任务均停止？y/n', 'n')).toLowerCase() === 'y';
            if (!confirmedStopped) continue;
          }
          const restartWorker = (await ask('重新交给执行员修改？y/n（否则恢复原阶段）', 'n')).toLowerCase() === 'y';
          await request(root, { action: 'retry', projectId, taskId, confirmedStopped, restartWorker }); console.log('已重新排队。');
        }
      } else if (action === '5') {
        if (!status) throw Error('服务未运行，请先选择 1');
        const projectId=await project(),p=(await request(root)).projects[projectId];
        await request(root,{action:p.completedAt?'reopen-project':'finish-project',projectId});
        console.log(p.completedAt?'项目已重新开启；已退出的角色需重新 resume。':'项目已结束；等待中的角色将退出。');
      } else if (action === '7') {
        if (!status) { console.log('服务已停止。'); continue; }
        await request(root, { action: 'stop' }); console.log('已请求停止；正在执行的任务可能需要核实后重试。');
      } else console.log('请输入菜单编号。');
    } catch (e) { console.log('未完成：' + e.message); }
  } } finally { rl.close(); }
}
if (require.main === module) main().catch(e => { console.error(require('./core/continuation.cjs').detail(e)); process.exitCode = 1; });
module.exports = { serviceClient, dataRoot, catalogEntries, bootstrapRoot, initialize, request, online, start };
