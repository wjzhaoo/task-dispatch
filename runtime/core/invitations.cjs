'use strict';

// [AI-added] 2026-09-17 09:42
const crypto = require('node:crypto');
const path = require('node:path');
const { instruction: WAIT_GUIDE } = require('./wait-policy.cjs');
const {ROLE_PROVIDERS, WAKE_PROVIDERS, continuationMode} = require('./platforms.cjs');

// [AI-added] 2026-09-17 09:42
const SCHEMA_VERSION = 1;
const DISPATCH_CONTEXT = '本邀请显式使用 $task-dispatch，由 task-dispatch runtime/client 生成，仅用于进入既有协作流程；不要把接入操作当作新的功能或修复请求，不要启动 flow-entry、flow-feature 或 flow-fix，不要另建计划或再次等待用户输入 1。';
const CONTINUATION_GUIDE = '在项目真实会话中直接执行邀请命令，服务核验真实 session 和 workspace，无需预先重复查询 status 或宿主会话。脚本只按接收端确认的 provider 固定选择 wake 或 wait，不探测其他平台；按返回 nextAction/nextInstruction 执行，缺项则补充真实信息，不能猜测或自行降级。空闲和提交后统一实际执行 resume --credential <本端凭据路径> --data <上述服务目录>，connect 已保存所选平台，resume 直接复用。工具超时至少 90 秒，已有等待进程就续等同一进程。job 继续处理。仅 wake 平台明确返回 parked:true 时可结束回合等待唤醒；wait 平台收到 idle:true 必须立即继续 resume，不等待用户再次提示；其他角色无需确认开始。Web 目标沿用用户在页面提交的开始授权，领取正式 job 后处理当前目标；仅保存的目标不得自行开始。其他项目须用户给大脑开始指令后执行 start-work --confirmed 和 plan。不得自行确认。大脑派单后同样实际 resume，不能只口头说等待。plan 只代表入队，dispatch.blocked 时必须报告原因。completed:true 才停止整个协作。';
const SESSION_REQUIREMENTS = Object.freeze({
  dsh: '使用 DSH 宿主提供的真实 --session-id；通过本机 Remote API 验证，沿用会话模型。',
  codearts: '必须使用 CodeArts 宿主提供的当前真实 --session-id；通过独立 Hook bridge 核验，不使用 OpenCode 2.x 数据库或 CLI。',
  codex: '显式选择 codex 后可读取当前会话的 CODEX_THREAD_ID。',
  mimo: '必须使用宿主提供的当前真实 --session-id。',
  qoder: '首次连接可使用本邀请的一次性 --invitation-id，由本机提示 Hook 和桥接核实真实会话。',
  opencode: '必须使用宿主提供的当前真实 ses_ 会话 ID；需要 OpenCode 2.x 和 Node.js 22.13+。',
  waitOnly: '其他合法 worker provider 进入 wait，不要求 session ID。'
});
const ROLE_TEMPLATES = Object.freeze({
  worker: Object.freeze({
    operation: 'connect', title: '请使用 task-dispatch 接入执行端。',
    roleGuide: '凭据自动生成，不借用其他窗口凭据。接替同一 worker 编号时必须为新会话生成新邀请，旧邀请不能复制到多个会话；新会话 connect 自动换绑，同会话重复 connect 幂等。若返回 handoverPending，等待旧端结算，不领取或重复执行；接入时已核验并保存真实会话；执行 resume 等待安全交接，成功后自动待命或领取任务，无需再次 connect。接入后按脚本回执领取正式任务，实际实现后 submit，再实际执行 resume。不得自审。'
  }),
  reviewer: Object.freeze({
    operation: 'connect', title: '请作为独立小脑审核员接入 task-dispatch。',
    roleGuide: '使用独立凭据。若已有离线旧审核员，核对状态后用 rebind --role reviewer 接替，不借用旧凭据。通过 resume/claim 领取初审，只读审核候选，按返回协议 submit。pass 交大脑终审，needs_fix 返修。heartbeat/progress 只用于可选进度展示，不续约或释放所有权；空闲统一调用 resume。不得实现代码或自行派单。'
  }),
  brain: Object.freeze({
    operation: 'rebind', title: '请接替 task-dispatch 大脑。',
    roleGuide: '凭据由服务创建，等待旧端在途审核结算后自动换绑；不要重复审核或修改业务代码。若旧 brain 已永久不可用，必须先让用户明确确认旧会话及其后台任务均已停止，之后才可在 rebind 命令追加 --recover --confirmed-stopped；该模式会撤销旧凭据并接管原 brain attempt，禁止模型自行确认。接入后按返回的正式 job 或 nextAction 继续原任务及计划，无需额外 status；大脑只负责规划、派发和审核，缺执行员时输出相应邀请。接入后按脚本回执执行 resume，不复用旧会话唤醒。'
  })
});

// [AI-added] 2026-09-21: Each host resolves its real session differently, so a managed
// rebind ships one copyable prompt per platform instead of a single hand-edited template.
const REBIND_PLATFORMS = Object.freeze({
  dsh: Object.freeze({ label: 'DSH', sessionIdRequired: true, hint: '使用 DeepSeek Harness 当前真实 --session-id；缺失时用 discover-session --provider dsh --invitation-id <本邀请标识> 只读核实。DSH Desktop 必须运行；服务使用 DSH_WEB_URL 或在 Windows 自动发现当前端口，并从 DSH_HOME（默认 ~/.dsh）读取本机鉴权。沿用原会话模型，不传 --model。' }),
  codearts: Object.freeze({ label: 'CodeArts', sessionIdRequired: true, hint: '使用当前 CodeArts 真实会话 ID，填写 --session-id；缺失时用 discover-session --provider codearts --invitation-id <本邀请标识> 只读核实。需要已运行的 CodeArts Hook bridge。CodeArts 与 OpenCode 2.x 是独立平台，不要改传 opencode；省略 --model 沿用原会话模型。' }),
  codex: Object.freeze({ label: 'Codex', sessionIdRequired: false, hint: '客户端在显式 --provider codex 后读取本会话的 CODEX_THREAD_ID；读取不到时向用户索取宿主显示的 thread ID 再追加 --session-id。' }),
  mimo: Object.freeze({ label: 'MiMo', sessionIdRequired: true, hint: 'wake 平台必须由宿主提供真实 --session-id：优先复用宿主已提供的真实会话 ID；缺少时再用 discover-session --provider mimo --invitation-id <本邀请标识> 只读定位。本邀请的 --invitation-id 只表示改绑授权，不能替代会话身份。' }),
  qoder: Object.freeze({ label: 'Qoder', sessionIdRequired: false, hint: '先把本提示词发给目标 Qoder 会话，UserPromptSubmit 握手 Hook 记下会话与邀请标识后，只需本邀请的一次性 --invitation-id，由 Hook 与 App Plugin 桥核实真实会话和工作区，不需要人工查 session ID。' }),
  opencode: Object.freeze({ label: 'OpenCode', sessionIdRequired: true, hint: '使用宿主提供的当前真实 ses_ 会话 ID，填写 --session-id。需要 OpenCode 2.x、Node.js 22.13+、可读取的会话数据库和官方 CLI；客户端只核验指定会话及工作目录，不按标题或目录猜测身份。省略 --model 沿用原会话模型。' })
});
const REBIND_ANY_PLATFORM = Object.freeze({ label: '由接收端确认平台', sessionIdRequired: false, hint: '接收端先确认自己所在平台，再把 <当前真实平台> 换成真实 provider；wake 平台还要补真实 --session-id。' });
const REBIND_WAIT_PLATFORM = Object.freeze({ label: '其他等待型平台', sessionIdRequired: false, hint: '等待型平台不要求 --session-id，接入后按回执进入 wait；provider 必须是宿主实际平台名，不允许 auto。' });
function rebindPlatformOrder(role) {
  return role === 'worker' ? [...WAKE_PROVIDERS, 'wait'] : [...(ROLE_PROVIDERS[role] || [])];
}

// [AI-added] 2026-09-17 09:42
function providerChoices(role) {
  return role === 'worker' ? [...WAKE_PROVIDERS, '其他合法等待型平台'] : [...ROLE_PROVIDERS[role]];
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
  const commandTemplate = buildCommand({operation, role, workerId, capability, dataRoot})+` --invitation-id ${invitationId}`;
  const handshake = `本次邀请标识：[TASK-DISPATCH-INVITE:${invitationId}]。若接收端确认自己是 Qoder，connect/rebind 使用命令中的 --invitation-id ${invitationId}，无需手工查找 --session-id；其他平台不得用该标识推断会话。`;
  const platformGuide = `平台确认只由本邀请接收端完成；发送邀请的大脑不得代问、代选或猜测。接收端复用用户已经明确指定的真实平台，不重复询问；仅缺少平台信息时，询问用户并从 ${options.join(' / ')} 中选择。确认后将命令中的 <当前真实平台> 替换为真实 provider；用户未选择或平台信息缺失时停止连接，不能使用 auto 或静默降级。Codex 显式选择后可读取 CODEX_THREAD_ID；MiMo、CodeArts、OpenCode、DSH 等 wake 平台必须使用宿主提供的真实 --session-id；Qoder 可按本邀请的一次性标识连接。不要读取或输出连接令牌、完整会话列表、进程环境或数据库。`;
  const identityGuide = role === 'worker' ? `worker 编号：${workerId}。${capability ? `本执行员要求能力 ${capability}，先核实当前模型配置符合用户要求；不符合则不要声明该能力并说明缺项。` : ''}` : '';
  const text = `${DISPATCH_CONTEXT} ${handshake} ${template.title}项目目录：${workspace}；客户端：${path.resolve(clientPath)}；服务目录：${dataRoot}。${identityGuide}在该项目目录直接执行 ${commandTemplate}；协议或缺项说明见 ${path.resolve(referencePath)}。${platformGuide}${template.roleGuide}${CONTINUATION_GUIDE}\nwait 平台续等规则：${WAIT_GUIDE}`;
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
    ? `平台适配：${spec.hint} Codex 显式选择后读取 CODEX_THREAD_ID，MiMo、CodeArts、OpenCode、DSH 等 wake 平台必须使用宿主提供的真实 --session-id，Qoder 可用本邀请的一次性 --invitation-id。`
    : `平台适配（${spec.label}）：${spec.hint}接收会话若不是 ${spec.label}，改用对应平台的提示词，不要沿用本条命令或伪造会话 ID。`;
  // The Qoder handshake Hook and discover-session only recognise the INVITE marker, so a
  // managed rebind must carry it next to its own label or the receiving session cannot bind.
  const text = `${DISPATCH_CONTEXT} 这是管理台生成的一次性改绑邀请 [TASK-DISPATCH-REBIND:${invitationId}]（握手标识 [TASK-DISPATCH-INVITE:${invitationId}]，两者同指这一条邀请），30 分钟内有效，目标平台：${spec.label}。项目目录：${workspace}；客户端：${clientPath}；服务目录：${dataRoot}。在项目目录直接执行 ${commandTemplate}；协议或缺项说明见 ${referencePath}。${platformGuide}${recover ? '管理台已记录旧会话停止确认，本次将转移合法的未结算任务所有权。' : '若旧端仍有在途任务，本次进入安全交接等待，不重复执行。'}${CONTINUATION_GUIDE}\n${provider === 'any' ? '若实际为 wait 平台：' + WAIT_GUIDE : continuationMode(provider)==='wait' ? WAIT_GUIDE : '仅在明确返回 parked:true 时结束本回合等待唤醒。'}`;
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
function buildJoinInvitation(options) {
  const base = buildInvitation(options);
  const quote = value => "'" + value.replaceAll("'", process.platform === 'win32' ? "''" : "'\"'\"'") + "'";
  const platforms = [...rebindPlatformOrder(options.role), 'any'].map(provider => {
    const spec = rebindPlatformSpec(provider);
    const session = spec.sessionIdRequired ? ' --session-id <当前真实会话 ID>' : '';
    const handshake = ['qoder','wait','any'].includes(provider) ? ` --invitation-id ${base.invitationId}` : '';
    const commandTemplate = `connect --provider ${spec.flag}${session} --role ${base.role}${base.role === 'worker' ? ` --worker-id ${base.workerId}${base.capability ? ` --capability ${base.capability}` : ''}` : ''}${handshake} --join-invitation ${base.invitationId} --workspace ${quote(base.workspace)} --data ${quote(base.data)}`;
    const command = `node ${quote(base.client)} ${commandTemplate}`;
    const text = `[TASK-DISPATCH-INVITE:${base.invitationId}] 使用 $task-dispatch 加入 Web 管理端的项目「${options.title || ''}」。角色：${base.role}${base.workerId ? ' / ' + base.workerId : ''}${base.capability ? '，能力要求：' + base.capability : ''}。${options.responsibilities ? '职责：' + options.responsibilities + '。' : ''}\n项目：${base.workspace}\n平台：${spec.label}。先确认本会话真实平台；用户已明确指定时直接复用，不重复提问，不猜测平台或会话 ID。${spec.hint}不能借用其他会话凭据。\n在该项目的真实会话中执行：\n${command}\n接入阶段只处理本角色配置。服务自动保存独立凭据并配置续接；${provider === 'wait' ? WAIT_GUIDE : provider === 'any' && base.role === 'worker' ? '若实际为 wait 平台：' + WAIT_GUIDE + '若实际为 wake 平台，仅在返回 parked:true 时结束回合。' : '明确返回 parked:true 才结束本回合等待唤醒，无需额外 status 或 park。返回 job 就处理；nextAction 提示缺项时仅补缺项。'}大脑读取返回的 brief 和 staffing；所有邀请已由 Web 管理端提供，无需再次 staff 或生成其他角色邀请。创建目标和成员接入都不代表开始授权。所有成员就绪后，等待用户在 Web 点击「开始」并确认；已明确加入队列的目标轮到时执行，不重复索要已有授权。按正式 job 的 goalId 与 brief 处理当前目标，完成全部验收后由大脑执行 finish-goal --goal <goalId> --summary <验收摘要> 再 resume，空队列保留待命，不自行结束整个项目。接到正式 job 后按协议处理、submit，再实际 resume；completed:true 才结束协作。此提示词只用于未绑定成员，换人请使用管理端改绑邀请。`;
    return { provider, label: spec.label, sessionIdRequired: spec.sessionIdRequired, sessionHint: spec.hint, commandTemplate, text };
  });
  const chosen = platforms.at(-1);
  return { ...base, operation: 'connect', kind: 'join', platforms, provider: chosen.provider, commandTemplate: chosen.commandTemplate, text: chosen.text };
}
module.exports = {SCHEMA_VERSION, SESSION_REQUIREMENTS, providerChoices, buildInvitation, buildRebindInvitation, buildJoinInvitation};
