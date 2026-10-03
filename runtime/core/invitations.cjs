'use strict';

// [AI-added] 2026-09-17 09:42
const crypto = require('node:crypto');
const path = require('node:path');
const {ROLE_PROVIDERS, continuationMode} = require('./platforms.cjs');

// [AI-added] 2026-09-17 09:42
const SCHEMA_VERSION = 1;
const DISPATCH_CONTEXT = '本邀请显式使用 $task-dispatch，由 task-dispatch runtime/client 生成，仅用于进入既有协作流程；不要把接入操作当作新的功能或修复请求，不要启动 flow-entry、flow-feature 或 flow-fix，不要另建计划或再次等待用户输入 1。';
const CONTINUATION_GUIDE = '先核对宿主真实会话目录与项目一致。脚本只按接收端确认的 provider 固定选择 wake 或 wait，不探测其他平台；按返回 nextAction/nextInstruction 执行，缺项则补充真实信息，不能猜测或自行降级。空闲和提交后统一实际执行 resume --credential <本端凭据路径> --data <上述服务目录>，首次配置还要传同一 --provider。工具超时至少 90 秒，已有等待进程就续等同一进程。job 继续处理，parked:true 才结束当前回合；idle:true 不是完成，按授权再次 resume。连接成功返回 parked:true 即已自动待命，结束当前回合；其他角色无需确认开始。只有用户给大脑一次开始指令后，大脑执行 start-work --confirmed 和 plan；不得自行确认。大脑派单后同样实际 resume，不能只口头说等待。plan 只代表入队，dispatch.blocked 时必须报告原因。completed:true 才停止整个协作。';
const SESSION_REQUIREMENTS = Object.freeze({
  codex: '显式选择 codex 后可读取当前会话的 CODEX_THREAD_ID。',
  mimo: '必须使用宿主提供的当前真实 --session-id。',
  qoder: '首次连接可使用本邀请的一次性 --invitation-id，由本机提示 Hook 和桥接核实真实会话。',
  codearts: 'worker 必须使用宿主提供的当前真实 --session-id。',
  waitOnly: '其他合法 worker provider 进入 wait，不要求 session ID。'
});
const ROLE_TEMPLATES = Object.freeze({
  worker: Object.freeze({
    operation: 'connect', title: '请使用 task-dispatch 接入执行端。',
    roleGuide: '凭据自动生成，不借用其他窗口凭据。接替同一 worker 编号时必须为新会话生成新邀请，旧邀请不能复制到多个会话；新会话 connect 自动换绑，同会话重复 connect 幂等。若返回 handoverPending，等待旧端结算，不领取或重复执行；换绑后重新绑定当前会话唤醒。接入后按脚本回执领取正式任务，实际实现后 submit，再实际执行 resume。不得自审。'
  }),
  reviewer: Object.freeze({
    operation: 'connect', title: '请作为独立小脑审核员接入 task-dispatch。',
    roleGuide: '使用独立凭据。若已有离线旧审核员，核对状态后用 rebind --role reviewer 接替，不借用旧凭据。通过 resume/claim 领取初审，只读审核候选，按返回协议 submit。pass 交大脑终审，needs_fix 返修。heartbeat/progress 只用于可选进度展示，不续约或释放所有权；空闲统一调用 resume。不得实现代码或自行派单。'
  }),
  brain: Object.freeze({
    operation: 'rebind', title: '请接替 task-dispatch 大脑。',
    roleGuide: '凭据由服务创建，等待旧端在途审核结算后自动换绑；不要重复审核或修改业务代码。若旧 brain 已永久不可用，必须先让用户明确确认旧会话及其后台任务均已停止，之后才可在 rebind 命令追加 --recover --confirmed-stopped；该模式会撤销旧凭据并接管原 brain attempt，禁止模型自行确认。接入后读取 status 与 claim，继续原任务及计划；大脑只负责规划、派发和审核，缺执行员时输出相应邀请。接入后按脚本回执执行 resume，不复用旧会话唤醒。'
  })
});

// [AI-added] 2026-09-21: Each host resolves its real session differently, so a managed
// rebind ships one copyable prompt per platform instead of a single hand-edited template.
const REBIND_PLATFORMS = Object.freeze({
  codex: Object.freeze({ label: 'Codex', sessionIdRequired: false, hint: '客户端在显式 --provider codex 后读取本会话的 CODEX_THREAD_ID；读取不到时向用户索取宿主显示的 thread ID 再追加 --session-id。' }),
  mimo: Object.freeze({ label: 'MiMo', sessionIdRequired: true, hint: 'wake 平台必须由宿主提供真实 --session-id：先把本提示词发给目标会话，再用 discover-session --provider mimo --invitation-id <本邀请标识> 只读定位当前会话 ID。本邀请的 --invitation-id 只表示改绑授权，不能替代会话身份。' }),
  qoder: Object.freeze({ label: 'Qoder', sessionIdRequired: false, hint: '先把本提示词发给目标 Qoder 会话，UserPromptSubmit 握手 Hook 记下会话与邀请标识后，只需本邀请的一次性 --invitation-id，由 Hook 与 App Plugin 桥核实真实会话和工作区，不需要人工查 session ID。' }),
  codearts: Object.freeze({ label: 'CodeArts', sessionIdRequired: true, hint: 'wake 平台必须由宿主提供真实 --session-id：先把本提示词发给目标会话（Hook 会按会话写出本机发现文件），再用 discover-session --provider codearts --invitation-id <本邀请标识> 只读定位当前会话 ID；不要手工打开宿主数据库，也不得用同目录旧会话的 ID 顶替。' })
});
const REBIND_ANY_PLATFORM = Object.freeze({ label: '由接收端确认平台', sessionIdRequired: false, hint: '接收端先确认自己所在平台，再把 <当前真实平台> 换成真实 provider；wake 平台还要补真实 --session-id。' });
const REBIND_WAIT_PLATFORM = Object.freeze({ label: '其他等待型平台', sessionIdRequired: false, hint: '等待型平台不要求 --session-id，接入后按回执进入 wait；provider 必须是宿主实际平台名，不允许 auto。' });
function rebindPlatformOrder(role) {
  return role === 'worker' ? ['codex', 'mimo', 'qoder', 'codearts', 'wait'] : [...(ROLE_PROVIDERS[role] || [])];
}

// [AI-added] 2026-09-17 09:42
function providerChoices(role) {
  return role === 'worker' ? ['codex', 'mimo', 'qoder', 'codearts', '其他合法等待型平台'] : [...ROLE_PROVIDERS[role]];
}

// [AI-added] 2026-09-17 09:42
function requireText(name, value) {
  if (typeof value !== 'string' || !value.trim()) throw Error(`Invitation ${name} is required`);
  return value;
}

// [AI-added] 2026-09-17 09:42
function buildCommand({operation, role, workerId, capability, dataRoot}) {
  return `${operation} --provider <当前真实平台> --role ${role}${role === 'worker' ? ` --worker-id ${workerId}${capability ? ` --capability ${capability}` : ''}` : ''} --data "${dataRoot}"`;
}

// [AI-added] 2026-09-17 09:42
function buildInvitation({role, workspace, dataRoot, clientPath, referencePath, workerId, capability, invitationId = crypto.randomUUID()}) {
  const template = ROLE_TEMPLATES[role];
  if (!template) throw Error('Invitation role must be brain, reviewer or worker');
  requireText('workspace', workspace); requireText('dataRoot', dataRoot); requireText('clientPath', clientPath); requireText('referencePath', referencePath);
  if (role === 'worker') requireText('workerId', workerId);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(invitationId)) throw Error('Invitation invitationId must be a UUID v4');
  const options = providerChoices(role), operation = template.operation;
  const commandTemplate = buildCommand({operation, role, workerId, capability, dataRoot});
  const handshake = `本次邀请标识：[TASK-DISPATCH-INVITE:${invitationId}]。若接收端确认自己是 Qoder，首次 connect/rebind 追加 --invitation-id ${invitationId}，无需手工查找 --session-id；其他平台不得用该标识推断会话。`;
  const platformGuide = `平台确认只由本邀请接收端完成；发送邀请的大脑不得代问、代选或猜测。接收端执行连接前必须询问当前会话的用户“当前会话平台是什么？”，并从 ${options.join(' / ')} 中明确选择。确认后将命令中的 <当前真实平台> 替换为真实 provider；用户未选择或平台信息缺失时停止连接，不能使用 auto 或静默降级。Codex 显式选择后可读取 CODEX_THREAD_ID；MiMo、CodeArts 等 wake 平台必须使用宿主提供的真实 --session-id；Qoder 可按本邀请的一次性标识连接。不要读取或输出连接令牌、完整会话列表、进程环境或数据库。`;
  const identityGuide = role === 'worker' ? `worker 编号：${workerId}。${capability ? `本执行员要求能力 ${capability}，先核实当前模型配置符合用户要求；不符合则不要声明该能力并说明缺项。` : ''}` : '';
  const text = `${DISPATCH_CONTEXT} ${handshake} ${template.title}项目目录：${workspace}；客户端：${path.resolve(clientPath)}；服务目录：${dataRoot}。${identityGuide}读取 ${path.resolve(referencePath)}，在该项目目录执行 ${commandTemplate}。${platformGuide}${template.roleGuide}${CONTINUATION_GUIDE}`;
  return {
    schemaVersion: SCHEMA_VERSION, invitationId, role, operation,
    workspace: path.resolve(workspace), client: path.resolve(clientPath), data: path.resolve(dataRoot), reference: path.resolve(referencePath),
    platformSelectionRequired: true, platformSelectionOwner: 'receiver', platformOptions: options,
    commandTemplate, sessionRequirements: {...SESSION_REQUIREMENTS},
    ...(role === 'worker' ? {workerId, ...(capability ? {capability} : {})} : {}), text
  };
}

// [AI-added] 2026-09-21
function rebindPlatformSpec(provider) {
  if (provider === 'any') return { ...REBIND_ANY_PLATFORM, flag: '<当前真实平台>' };
  if (provider === 'wait') return { ...REBIND_WAIT_PLATFORM, flag: '<真实平台名>' };
  if (REBIND_PLATFORMS[provider]) return { ...REBIND_PLATFORMS[provider], flag: provider };
  // A legal wait-only host the console already knows (zcode, …) is named directly.
  if (continuationMode(provider) === 'wait') return { label: provider + ' 等待型平台', sessionIdRequired: false, hint: REBIND_WAIT_PLATFORM.hint, flag: provider };
  return undefined;
}

// [AI-added] 2026-09-21
function rebindVariant(provider, { role, workerId, capability, invitationId, dataRoot, workspace, clientPath, referencePath, recover }) {
  const spec = rebindPlatformSpec(provider);
  if (!spec) throw Error('Unsupported rebind platform ' + provider);
  const commandTemplate = `rebind --managed-rebind --provider ${spec.flag}${spec.sessionIdRequired ? ' --session-id <当前真实会话 ID>' : ''} --role ${role}${role === 'worker' ? ` --worker-id ${workerId}${capability ? ` --capability ${capability}` : ''}` : ''} --invitation-id ${invitationId} --data "${dataRoot}"${recover ? ' --recover --confirmed-stopped' : ''}`;
  const platformGuide = provider === 'any'
    ? `平台适配：${spec.hint} Codex 显式选择后读取 CODEX_THREAD_ID，MiMo、CodeArts 等 wake 平台必须使用宿主提供的真实 --session-id，Qoder 可用本邀请的一次性 --invitation-id。`
    : `平台适配（${spec.label}）：${spec.hint}接收会话若不是 ${spec.label}，改用对应平台的提示词，不要沿用本条命令或伪造会话 ID。`;
  // The Qoder handshake Hook and discover-session only recognise the INVITE marker, so a
  // managed rebind must carry it next to its own label or the receiving session cannot bind.
  const text = `${DISPATCH_CONTEXT} 这是管理台生成的一次性改绑邀请 [TASK-DISPATCH-REBIND:${invitationId}]（握手标识 [TASK-DISPATCH-INVITE:${invitationId}]，两者同指这一条邀请），30 分钟内有效，目标平台：${spec.label}。项目目录：${workspace}；客户端：${clientPath}；服务目录：${dataRoot}。读取 ${referencePath}，在项目目录执行 ${commandTemplate}。${platformGuide}${recover ? '管理台已记录旧会话停止确认，本次将转移合法的未结算任务所有权。' : '若旧端仍有在途任务，本次进入安全交接等待，不重复执行。'}${CONTINUATION_GUIDE}`;
  return { provider, label: spec.label, sessionIdRequired: spec.sessionIdRequired, sessionHint: spec.hint, commandTemplate, text };
}

// [AI-added] 2026-09-17 11:46
// [AI-added] 2026-09-21: preferredProvider only pins the variant the console shows first; the
// receiving side still confirms its own platform, and every other variant stays selectable.
function buildRebindInvitation({ role, workspace, dataRoot, clientPath, referencePath, workerId, capability, invitationId, recover = false, preferredProvider }) {
  const base = buildInvitation({ role, workspace, dataRoot, clientPath, referencePath, workerId, capability, invitationId });
  const context = { role, workerId, capability, invitationId, dataRoot: base.data, workspace: base.workspace, clientPath: base.client, referencePath: base.reference, recover };
  const order = rebindPlatformOrder(role);
  const genericWait = order.indexOf('wait');
  // A wait-only host the console already knows replaces the generic placeholder option.
  if (genericWait >= 0 && preferredProvider && !order.includes(preferredProvider) && continuationMode(preferredProvider) === 'wait') order[genericWait] = preferredProvider;
  const platforms = [...order, 'any'].map(provider => rebindVariant(provider, context));
  const chosen = platforms.find(item => item.provider === preferredProvider) || platforms.at(-1);
  return { ...base, operation: 'rebind', managedRebind: true, recover, provider: chosen.provider, platformLabel: chosen.label, platforms, commandTemplate: chosen.commandTemplate, text: chosen.text };
}

// [AI-added] 2026-09-17 09:42
// [AI-added] 2026-09-17 11:46
module.exports = {SCHEMA_VERSION, SESSION_REQUIREMENTS, providerChoices, buildInvitation, buildRebindInvitation};
