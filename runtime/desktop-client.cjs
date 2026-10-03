#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomic, read } = require('./core/storage.cjs');
const { dataRoot, initialize, start, request } = require('./wizard.cjs');
const {bindingKey,workerId:validateWorkerId}=require('./core/bindings.cjs');
// [AI-added] 2026-09-17 09:42
const {buildInvitation,providerChoices}=require('./core/invitations.cjs');
// [AI-added] 2026-09-17 09:42
function createInvitation(role,workspace,root,extra={}) {
  return buildInvitation({role,workspace,dataRoot:root,clientPath:__filename,referencePath:path.resolve(__dirname,'../skills/task-dispatch/references/connection.md'),...extra});
}
async function call(root, credential, body, signal) {
  const endpoint = read(path.join(root, 'endpoint.json'));
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/desktop`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + credential.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: signal || AbortSignal.timeout(25000)
  });
  const result = await response.json();
  if (!response.ok) { const e = Error(result.error); e.status = response.status; throw e; }
  return result;
}
async function main() {
  const args = process.argv.slice(2);
  const option = (flag, fallback) => { const i = args.indexOf(flag); if (i < 0) return fallback; if (!args[i+1]) throw Error(flag+' requires a value'); return args[i+1]; };
  let command = args[0], file = option('--credential');
  if (!command || command === 'help' || command === '--help') {
    console.log(`Task Dispatch 桌面会话客户端（Node.js 22+）

常用入口：
  在项目工作目录中运行 start.bat connect --provider codex --role brain
  在项目工作目录中运行 start.bat connect --provider mimo --role reviewer --session-id SESSION_ID
  在项目工作目录中运行 start.bat connect --provider zcode --role worker --worker-id WORKER

后续操作使用连接结果中的凭据文件：
  start.bat status --credential "凭据文件"
  start.bat resume --credential "凭据文件"
  start.bat finish-project --credential "大脑凭据文件"
  start.bat retry --task TASK --reason "原因" --credential "大脑凭据文件"
  start.bat resolve-task --task OLD --replacement NEW --reason "已由替代任务解决" --credential "大脑凭据文件"

正常使用不需要 --workspace；客户端从当前会话真实工作目录登记项目。所有命令可追加 --data "服务数据目录" 作为兼容/诊断覆盖；新项目默认使用工作区内的独立服务目录，已有凭据沿用原目录。
删除项目服务目录前必须先停止该项目服务；不会自动迁移或删除旧的用户目录数据。
connect/rebind 必须显式传真实 --provider。wake 平台还必须核实真实 session；Codex 仅在 --provider codex 后可读取 CODEX_THREAD_ID，Qoder 首次连接可传邀请的一次性 --invitation-id。discover-session 是显式 provider 的只读诊断；Qoder connect 可用同一握手记录完成首次绑定。
平台 Skill 安装仅支持 codex、mimo、qoder、qodercn。`);
    return;
  }
  let rebinding = command === 'rebind';
  const connecting = command === 'connect' || rebinding;
  const selectedWorker = option('--worker-id','default');
  validateWorkerId(selectedWorker);
  const capability=option('--capability');if(capability)validateWorkerId(capability);
  const role = connecting ? option('--role','brain') : undefined;
  if(connecting&&!['brain','worker','reviewer'].includes(role))throw Error('Role must be brain, worker or reviewer');
  // [AI-added] 2026-09-16 21:34
  const recoveryRequested=args.includes('--recover'),recoveryConfirmed=args.includes('--confirmed-stopped');
  if(recoveryRequested!==recoveryConfirmed)throw Error('Brain recovery requires both --recover and --confirmed-stopped');
  // [AI-added] 2026-09-17 11:46
  const managedRebind=args.includes('--managed-rebind');
  if(managedRebind&&!rebinding)throw Error('--managed-rebind is only valid for rebind');
  if((recoveryRequested||recoveryConfirmed)&&(!rebinding||(role!=='brain'&&!managedRebind)))throw Error('Non-brain recovery requires a managed rebind invitation');
  const platform=require('./core/platforms.cjs');
  const rawConnectProvider=connecting?option('--provider'):undefined;
  // [AI-added] 2026-09-16 18:11
  if(connecting&&(!rawConnectProvider||rawConnectProvider==='auto'))throw Error(`connect/rebind requires explicit --provider <actual host>. Ask the user to choose the current platform before connecting. Allowed for ${role}: ${providerChoices(role).join(', ')}`);
  const requestedConnectProvider=connecting?platform.assertRoleProvider(role,rawConnectProvider):undefined;
  const logicalWait=connecting&&role==='worker'&&requestedConnectProvider&&platform.continuationMode(requestedConnectProvider)==='wait';
  let sessionId = connecting ? option('--session-id',requestedConnectProvider==='codex'?(process.env.CODEX_THREAD_ID||undefined):undefined) : undefined;
  const connectInvitationId = connecting ? option('--invitation-id') : undefined;
  // [AI-added] 2026-09-16 16:00
  const workspaceForData = ['connect','rebind','attach','discover','discover-session'].includes(command)
    ? option('--workspace', process.cwd()) : undefined;
  const root = dataRoot(args, { workspace: workspaceForData, credentialFile: file });
  // [AI-added] 2026-09-17 11:46
  if (workspaceForData) require('./core/data-root.cjs').ensureProjectLayout(workspaceForData, root);
  if(command==='discover-session'){
    const provider=option('--provider');if(!provider||provider==='auto')throw Error('discover-session requires an explicit --provider');
    const {WakeProviders}=require('./adapters/mimo-wake.cjs');
    const discovered=await require('./core/session-discovery.cjs').discover({workspace:require('./core/storage.cjs').plainDirectory(option('--workspace',process.cwd())),invitationId:option('--invitation-id'),provider},new WakeProviders({qoder:{dataRoot:root}}));
    console.log(JSON.stringify(discovered));if(!discovered.identified)process.exitCode=1;return;
  }
  if (connecting) {
    const workspace = require('./core/storage.cjs').plainDirectory(option('--workspace', process.cwd()));
    if (!sessionId && requestedConnectProvider === 'qoder' && connectInvitationId) {
      const {WakeProviders}=require('./adapters/mimo-wake.cjs');
      const discovered=await require('./core/session-discovery.cjs').discover({workspace,invitationId:connectInvitationId,provider:'qoder'},new WakeProviders({qoder:{dataRoot:root}}));
      if (!discovered.identified) throw Error(discovered.nextInstruction);
      sessionId=discovered.sessionId;
    }
    // [AI-added] 2026-09-17 11:46
    if (connectInvitationId && requestedConnectProvider !== 'qoder' && !logicalWait && !managedRebind) throw Error('--invitation-id cannot replace the real session ID for this wake provider');
    if(managedRebind&&!connectInvitationId)throw Error('Managed rebind requires --invitation-id');
    if (!sessionId&&!logicalWait) throw Error(`${requestedConnectProvider} wake requires a host-provided real --session-id`);
    if (args.includes('--continue') && role !== 'brain') throw Error('Only brain connect can reopen a project');
    const projectKey = require('./core/storage.cjs').workspaceKey(workspace);
    const identityKey=sessionId||`wait:${requestedConnectProvider}:${option('--invitation-id','direct')}`;
    file ||= path.join(root, 'clients', projectKey + '-' + role + (role==='worker'&&selectedWorker!=='default'?'-'+selectedWorker:'') + '-' + require('./core/storage.cjs').sha(identityKey).slice(0,8) + '.json');
    args.push('--workspace', workspace);
    if (!args.includes('--role')) args.push('--role', role);
    command = 'attach';
  }
  if (command === 'discover') {
    const workspace = path.resolve(option('--workspace', process.cwd())), role = option('--role');
    if (role && !['brain', 'worker', 'reviewer'].includes(role)) throw Error('Role must be brain, worker or reviewer');
    const directory = path.join(root, 'connections');
    const connections = [];
    for (const entry of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
      if (!entry.endsWith('.json')) continue;
      const c = read(path.join(directory, entry));
      if (c.version !== 1 || c.workspace !== workspace || c.data !== root || (role && c.role !== role)) continue;
      // Output only connection metadata, never credential contents or arbitrary descriptor fields.
      connections.push({ version: 1, workspace: c.workspace, data: c.data, role: c.role,
        workerId:c.workerId, projectId: c.projectId, client: path.resolve(__filename), credential: c.credential,
        credentialExists: typeof c.credential === 'string' && fs.existsSync(c.credential) });
    }
    console.log(JSON.stringify({ connections, selectionRequired: connections.length > 1 })); return;
  }
  if (!file) throw Error('需要 --credential 凭据文件路径；新连接默认凭据严格保存在项目内运行目录');
  if (command === 'attach') {
    initialize(root); await start(root);
    const role = option('--role'), workspace = path.resolve(option('--workspace', process.cwd()));
    const newClientId = () => `${require('./core/storage.cjs').workspaceKey(workspace).slice(0,41)}-${role}-${crypto.randomUUID().slice(0,8)}`;
    let credential = fs.existsSync(file) ? read(file) : { clientId: newClientId(), token: crypto.randomBytes(32).toString('hex'), role, workspace, data: root, ...(role==='worker'?{workerId:selectedWorker,capabilities:capability?[capability]:[]}:{}) };
    if (credential.role !== role || credential.workspace !== workspace || credential.data !== root) throw Error('Credential already belongs to a different role/workspace/service');
    if (role==='worker' && (credential.workerId||'default')!==selectedWorker) throw Error('Credential belongs to another worker');
    const currentBinding = connecting ? Object.values((await request(root)).projects).find(p=>path.relative(p.workspace,workspace)==='')?.bindings?.[bindingKey({role,workerId:selectedWorker})] : undefined;
    const ownerSession=currentBinding?.sessionId||currentBinding?.wake?.threadId;
    if(connecting && currentBinding && ownerSession===sessionId && currentBinding.clientId!==credential.clientId) {
      const descriptor=path.join(root,'connections',currentBinding.clientId+'.json');
      if(fs.existsSync(descriptor)) {
        const prior=read(descriptor);
        if(prior.workspace===workspace && prior.role===role && fs.existsSync(prior.credential)) {
          file=prior.credential;credential=read(file);
        }
      }
    }
    if(connecting && currentBinding && ownerSession!==sessionId) {
      if(role==='worker')rebinding=true;
      if(!rebinding)throw Error('Role belongs to another session; use the brain handover invitation');
    }
    // Never overwrite a credential that an old wait/worker can still read.
    if(connecting && fs.existsSync(file) && ((credential.sessionId && credential.sessionId!==sessionId) || (rebinding && credential.clientId===currentBinding?.clientId && ownerSession!==sessionId))) {
      file=path.join(path.dirname(file),path.basename(file,'.json')+'-'+require('./core/storage.cjs').sha(sessionId).slice(0,16)+'.json');
      credential=fs.existsSync(file)?read(file):{clientId:newClientId(),token:crypto.randomBytes(32).toString('hex'),role,workspace,data:root,sessionId,...(role==='worker'?{workerId:selectedWorker,capabilities:capability?[capability]:credential.capabilities||[]}:{})};
    }
    if (connecting && !currentBinding && fs.existsSync(file)) {
      credential={clientId:newClientId(),token:crypto.randomBytes(32).toString('hex'),role,workspace,data:root,...(role==='worker'?{workerId:selectedWorker,capabilities:capability?[capability]:credential.capabilities||[]}:{})};
      atomic(file,credential);
    }
    if(capability && role==='worker' && !credential.capabilities?.includes(capability)) throw Error('Existing worker capabilities differ; use rebind to change configuration');
    if (connecting && sessionId && credential.sessionId && credential.sessionId !== sessionId) throw Error('Role belongs to another session; do not take over its credential');
    const { overlaps } = require('./core/storage.cjs');
    // [AI-added] 2026-09-17 11:46
    const roots=require('./core/data-root.cjs'),protectedLocal=path.resolve(root)===roots.projectDataRoot(workspace)&&roots.inside(root,path.resolve(file));
    if (overlaps(workspace, path.resolve(file)) && !protectedLocal) throw Error('Credential inside workspace must stay under the protected .task-dispatch/runtime service directory');
    if (!fs.existsSync(file)) atomic(file, credential);
    const registered = await request(root, { action: 'attach-desktop', ...credential, ...(connecting ? {sessionId} : {}),
      ...(recoveryRequested?{recover:true,confirmedStopped:true}:{}),
      // [AI-added] 2026-09-17 11:46
      ...(managedRebind?{managedRebind:true,rebindInvitationId:connectInvitationId}:{}),
      ...(rebinding && currentBinding && currentBinding.clientId!==credential.clientId ? {replaceClientId:currentBinding.clientId}:{}) });
    if (connecting && sessionId) credential.sessionId = sessionId;
    credential = { ...credential, ...registered }; atomic(file, credential);
    atomic(path.join(root, 'connections', credential.clientId + '.json'), {
      version: 1, client: path.resolve(__filename), data: root, workspace, role,
      workerId:credential.workerId, projectId: credential.projectId, credential: path.resolve(file)
    });
    if (connecting) {
      if(registered.handoverPending){console.log(JSON.stringify({attached:false,credential:path.resolve(file),...registered,nextAction:'使用 handover-wait --credential "'+path.resolve(file)+'" --data "'+root+'" 等待服务交接；返回 attached:true 后继续当前会话接入与唤醒，不重复执行旧任务。'}));return;}
      let status = await call(root, credential, {action:'status'});
      if (status.completed && args.includes('--continue')) {
        await request(root, {action:'reopen-project',projectId:credential.projectId});
        status = await call(root, credential, {action:'status'});
      }
      const workers=status.staffing?.workers||[];
      let continuation = fs.existsSync(path.resolve(file)+'.wait.lock')
        ? {mode:'attention',nextAction:'attention',nextInstruction:'已有 wait 进程或遗留锁，先核对并续等原进程；不能同时配置唤醒或启动第二个等待。'}
        : await call(root,credential,{action:'configure-continuation',provider:requestedConnectProvider,turnId:option('--turn-id'),model:option('--model'),noWake:args.includes('--no-wake')},AbortSignal.timeout(60000));
      if (continuation.nextAction === 'park') {
        const standby = await call(root,credential,{action:'park'});
        continuation = {...continuation,...standby,nextAction:standby.job?'work':standby.parked?'standby':continuation.nextAction,
          nextInstruction:standby.job?'立即处理返回的正式 job，完成后 submit 和 resume。':'已自动待命；结束当前回合。只有大脑接收用户的开始指令并执行 start-work --confirmed，其他角色无需确认。'};
      }
      status = await call(root,credential,{action:'status'});
      // [AI-added] 2026-09-16 18:11
      const workerInvites=workers.map(w=>({...w,...createInvitation('worker',workspace,root,{workerId:w.workerId,capability:w.capability})}));
      const connectedWorkers=new Map((status.workers||[]).map(w=>[w.workerId,w]));
      const workerConnectRequired=!status.staffing||workers.length===0||workers.some(w=>!connectedWorkers.has(w.workerId));
      const peerSetupRequired=role==='brain'&&(!status.reviewerOnline||workerConnectRequired);
      const effectiveContinuation=peerSetupRequired&&continuation.nextAction==='standby'?{
        ...continuation,continuationNextAction:continuation.nextAction,nextAction:'setup-peers',
        nextInstruction:'连接尚未完成：必须向用户展示 reviewerInvite.text；若 staffingRequired 先完成 staff，再逐条展示 workerInvites[].text。大脑不要询问或选择其他角色的平台；邀请接收端会在自己的会话中确认真实平台。不能只回复等待或把 parked:true 当作角色配置已完成。'
      }:continuation;
      console.log(JSON.stringify({attached:true,client:path.resolve(__filename),data:root,credential:path.resolve(file),recovered:registered.recovered===true,recoveredAttempts:registered.recoveredAttempts||[],...status,continuation,...effectiveContinuation,...(role==='brain'?{
        peerSetupRequired,reviewerSpawnRequired:!status.reviewerOnline,reviewerSpawnInstruction:'若未在线，必须向用户展示 reviewerInvite.text；不要在大脑会话询问 reviewer 平台，接收邀请的 reviewer 会话负责确认自身平台，再通过宿主已授权派生能力建立独立经济模型 reviewer。宿主不支持则保留邀请供用户粘贴；小脑接入并在线后才可 start-work --confirmed。已领取的审核不会因无心跳自动改派；确定终止时显式 detach。',reviewerInvite:createInvitation('reviewer',workspace,root),
        staffingRequired:!status.staffing,staffingInstruction:'先评估本阶段独立交付边界、所需模型类型和数量、现有worker及并发条件；用 staff --file 登记评估。staff 回执中的每条 workerInvites[].text 都必须展示给对应接收端；大脑不询问 worker 平台，由邀请接收端确认自身真实平台。难任务完整交强worker，大脑不实现；当前同项目串行。',
        workerInviteStatus:!status.staffing?'pending-staffing':workerConnectRequired?'connection-required':'connected',workerInvites}:{})})); return;
    }
    console.log(JSON.stringify({ attached: true, role, projectId: credential.projectId, credential: path.resolve(file) })); return;
  }
  const credential = read(file);
  if (credential.data !== root) throw Error('Use the same --data directory as attach');
  if(command==='resume') {
    if(fs.existsSync(path.resolve(file)+'.wait.lock')) throw Error('已有 wait 进程或遗留锁；核对并续等原进程，不能重复 resume。');
    // [AI-added] 2026-09-15 18:56
/* Previous implementation:
const continuation = await call(root,credential,{action:'configure-continuation',provider:option('--provider',process.env.CODEX_THREAD_ID===credential.sessionId?'codex':undefined),turnId:option('--turn-id'),model:option('--model')},AbortSignal.timeout(60000));
*/
const requestedProvider=option('--provider');
    let continuation = await call(root,credential,{action:'configure-continuation',provider:requestedProvider,turnId:option('--turn-id'),model:option('--model'),noWake:args.includes('--no-wake')},AbortSignal.timeout(60000));
    if(continuation.nextAction==='claim') { console.log(JSON.stringify(await call(root,credential,{action:'claim'})));return; }
    if(!['park','wait'].includes(continuation.nextAction)) {console.log(JSON.stringify(continuation));return;}
    command=continuation.nextAction;
  }
  if(command==='handover-wait') {
    const seconds=Number(option('--seconds','3600'));
    if(!Number.isFinite(seconds)||seconds<1||seconds>43200)throw Error('seconds must be 1..43200');
    const deadline=Date.now()+seconds*1000;
    do {
      const state=await request(root),p=state.projects[credential.projectId],key=bindingKey(credential);
      if(p?.bindings?.[key]?.clientId===credential.clientId) {
        console.log(JSON.stringify({attached:true,credential:path.resolve(file),...(await call(root,credential,{action:'status'}))}));return;
      }
      if(p?.handovers?.[key]?.clientId!==credential.clientId)throw Error('Handover no longer belongs to this session');
      await new Promise(r=>setTimeout(r,Math.min(1000,Math.max(0,deadline-Date.now()))));
    }while(Date.now()<deadline);
    console.log(JSON.stringify({attached:false,handoverPending:true,message:'交接仍等待旧端结算；未接管任务，可继续 handover-wait。'}));return;
  }
  if(command==='scope-ack'){console.log(JSON.stringify(await call(root,credential,{action:'scope-ack',taskId:option('--task'),alertId:option('--alert-id')})));return;}
  if(command==='attention-ack'){console.log(JSON.stringify(await call(root,credential,{action:'attention-ack',taskId:option('--task'),alertId:option('--alert-id')})));return;}
  if(command==='invite') {
    const status=await call(root,credential,{action:'status'});if(status.role!=='brain')throw Error('Only brain can invite workers');
    console.log(JSON.stringify(createInvitation('worker',status.workspace,root,{workerId:selectedWorker,capability})));return;
  }
  if(command==='handoff-invite') {
    const status=await call(root,credential,{action:'status'});if(status.role!=='brain')throw Error('Only brain can issue brain handover invitation');
    console.log(JSON.stringify(createInvitation('brain',status.workspace,root)));return;
  }
  if(command==='staff') {
    const result=await call(root,credential,{action:'staff',staffing:read(option('--file'))});
    const status=await call(root,credential,{action:'status'});
    console.log(JSON.stringify({...result,workerInvites:result.staffing.workers.map(w=>({...w,...createInvitation('worker',status.workspace,root,{workerId:w.workerId,capability:w.capability})}))}));return;
  }
  if(command==='detach') {const targetRole=option('--role');console.log(JSON.stringify(await call(root,credential,{action:'detach',...(args.includes('--worker-id')?{workerId:selectedWorker}:{}),...(targetRole?{targetRole}:{})})));return;}
  if(command==='task-budget') {console.log(JSON.stringify(await call(root,credential,{action:'task-budget',taskId:option('--task'),additionalAttempts:Number(option('--add')),reason:option('--reason')})));return;}
  if(command==='assign') {console.log(JSON.stringify(await call(root,credential,{action:'assign',taskId:option('--task'),workerId:selectedWorker,requiredCapability:capability,retry:args.includes('--retry'),updatePlan:args.includes('--update-plan'),reason:option('--reason')})));return;}
  // [AI-added] 2026-09-21 09:38: Expose guarded brain recovery and contract-management commands.
  if(command==='retry') {console.log(JSON.stringify(await call(root,credential,{action:'retry',taskId:option('--task'),reason:option('--reason'),confirmedStopped:args.includes('--confirmed-stopped'),restartWorker:args.includes('--restart-worker')})));return;}
  if(command==='configure-repair') {console.log(JSON.stringify(await call(root,credential,{action:'configure-repair',taskId:option('--task'),config:read(option('--file'))})));return;}
  if(command==='reconcile-review') {console.log(JSON.stringify(await call(root,credential,{...read(option('--file')),action:'reconcile-review',taskId:option('--task')})));return;}
  if(command==='revise-task') {console.log(JSON.stringify(await call(root,credential,{action:'revise-task',taskId:option('--task'),task:read(option('--file')),reason:option('--reason')})));return;}
  if(command==='resolve-task') {console.log(JSON.stringify(await call(root,credential,{action:'resolve-task',taskId:option('--task'),replacementTaskId:option('--replacement'),reason:option('--reason')})));return;}
  if(command==='start-work'){console.log(JSON.stringify(await call(root,credential,{action:'start-work',confirmed:args.includes('--confirmed'),withoutReviewer:args.includes('--without-reviewer')})));return;}
  if (['heartbeat','wake-bind','wake-disable','park','claim','status','finish-project'].includes(command)) {
    if (['wake-bind','park'].includes(command) && fs.existsSync(path.resolve(file)+'.wait.lock')) throw Error('先停止本会话旧 wait 进程并核实等待锁，不能同时阻塞等待和自动唤醒');
    // [AI-added] 2026-09-14 09:43
/* Previous implementation:
const provider=option('--provider','codex');
*/
// [AI-added] 2026-09-14 09:43
// Previous: const body = command==='wake-bind' ? {action:'wake-bind',provider,threadId:option('--thread-id',provider==='codex'?process.env.CODEX_THREAD_ID:undefined),turnId:option('--turn-id'),model:option('--model'),experimentalAcknowledged:args.includes('--experimental')} : command==='wake-disable' ? {action:'wake-bind',enabled:false} : {action:command};
    let body;
    if(command==='wake-bind'){
      const rawProvider=option('--provider');if(!rawProvider)throw Error('wake-bind requires explicit --provider <actual host>');
      const provider=require('./core/platforms.cjs').normalizeProvider(rawProvider);
      body={action:'wake-bind',provider,threadId:option('--thread-id',provider==='codex'?process.env.CODEX_THREAD_ID:undefined),turnId:option('--turn-id'),model:option('--model'),experimentalAcknowledged:true};
    }else body=command==='wake-disable'?{action:'wake-bind',enabled:false}:{action:command};
    console.log(JSON.stringify(await call(root,credential,body,AbortSignal.timeout(60000))));
  } else if (command === 'wait') {
    // Only this process repeats HTTP polls; it does not generate model turns.
    const lock = path.resolve(file) + '.wait.lock';
    let fd;
    try { fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, String(process.pid)); }
    catch { throw Error('Another wait may be running. Check/remove the stale .wait.lock only after that process stops.'); }
    const seconds = Number(option('--seconds', '60'));
    try {
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 43200) throw Error('seconds must be 1..43200');
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline) {
        try {
          const result = await call(root, credential, { action: 'wait', acceptCompleted:true }, AbortSignal.timeout(Math.max(1, Math.min(25000, deadline-Date.now()))));
          if (result.job || result.completed) { console.log(JSON.stringify(result)); return; }
        } catch (e) {
          if (e.status && e.status < 500) throw e;
          if (Date.now() < deadline) await new Promise(r => setTimeout(r, Math.min(1000, deadline-Date.now())));
        }
      }
      console.log(JSON.stringify({ idle: true, message: '等待期限已到；未领取任务，不代表完成。' }));
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  } else if (command === 'closeout') {
    console.log(JSON.stringify(await call(root, credential, {...read(option('--file')),action:'closeout'})));
  } else if (command === 'progress') {
    console.log(JSON.stringify(await call(root, credential, {...read(option('--file')),action:'progress'})));
  } else if (command === 'plan') {
    console.log(JSON.stringify(await call(root, credential, { action: 'plan', task: read(option('--file')) })));
    // [AI-added] 2026-09-22 09:20: Preflight does not claim or submit work.
    } else if (command === 'activity-start') {
      console.log(JSON.stringify(await call(root,credential,{action:command,activityId:option('--activity'),kind:option('--kind'),source:option('--source')})));
    } else if (command === 'activity-end') {
      console.log(JSON.stringify(await call(root,credential,{action:command,activityId:option('--activity'),usage:option('--usage-file')?read(option('--usage-file')):undefined})));
    } else if (command === 'stage-register') {
      console.log(JSON.stringify(await call(root,credential,{...read(option('--file')),action:command})));
    } else if (command === 'stage-submit') {
      const result=read(option('--file'));console.log(JSON.stringify(await call(root,credential,{action:command,roundId:result.roundId,attemptId:result.attemptId,result,usage:option('--usage-file')?read(option('--usage-file')):undefined})));
    } else if (command === 'stage-resume') {
      console.log(JSON.stringify(await call(root,credential,{action:command,roundId:option('--round'),confirmedStopped:args.includes('--confirmed-stopped')})));
    } else if (command === 'preflight') {
      console.log(JSON.stringify(await call(root,credential,{action:'preflight',taskId:option('--task'),attemptId:option('--attempt')})));
    } else if (command === 'submit') {
    const result = read(option('--file'));
    const usageFile = option('--usage-file');
    console.log(JSON.stringify(await call(root, credential, { action: 'submit', taskId: result.taskId, attemptId: result.attemptId, result, usage: usageFile ? read(usageFile) : undefined })));
    } else throw Error('Commands: resume, start-work, connect, rebind, detach, invite, handoff-invite, handover-wait, staff, assign, task-budget, retry, configure-repair, reconcile-review, revise-task, resolve-task, discover, discover-session, status, attach, wait, claim, plan, closeout, preflight, submit, progress, wake-bind, wake-disable, park, finish-project, scope-ack, attention-ack, activity-start, activity-end, stage-register, stage-submit, stage-resume');
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { call };
