# 服务发现与接入

## Web 管理端的目标队列

用户可在 Web 主页创建目标和成员配置，随后分别发送各角色首次接入邀请。按邀请内客户端绝对路径、真实平台、角色、项目与 `--join-invitation` 执行一次 `connect`；首次邀请不能覆盖另一个已绑定客户端，换人使用改绑邀请。用户已明确指定当前平台时复用其选择，不重复询问；未指定时仍由接收端确认，不猜测平台或会话。

返回 `peerSetupManagedBy: web` 表示 Web 已保存 staffing 并提供全部成员邀请。大脑读取 `brief` 与 `staffing`，不重新配置团队、不派生或再次输出其他成员邀请。所有成员可同时接入，`parked:true` 后直接结束本回合等待唤醒。按回执补充缺项，禁止通过反复 status 或重复连接等待其他成员。

Web 默认“大脑＋初审端＋一名执行员”，创建表单将编号、能力与职责收进高级设置。用户点击「创建并开始」即明确授权，目标入队，全部成员就绪且轮到时自动开始；「仅保存」只建待开始目标，之后点击开始或由大脑按用户指令执行 `start-goal --goal <goalId> --confirmed` 才入队。新增目标复用项目及绑定，只邀请缺少成员，不改变当前目标的阶段、验收和团队。团队只能在没有活动目标时调整。

领取 `kind: planning` 后按 goalId 与 brief 处理当前目标。plan/stage-register 自动关联当前目标，任务和阶段编号使用目标前缀以免重名；禁止跨目标混入审核。完成目标并通过完整阶段终审、任务和结算检查后，实际执行 `finish-goal --goal <goalId> --summary <验收摘要>`，再 `resume`。服务顺序执行下个已授权目标；空队列保留成员待命，不能自行 finish-project。阻塞时保留当前目标和队列，报告具体原因；未开始目标可在 Web 取消。服务重启保留开始授权、队列与规划，不重复创建目标或唤醒。

## 非 Web 项目的人工启动

非 Web 目标项目采用两阶段启动：连接阶段只登记 staffing、生成邀请、核对各端，不得 plan。计划内 worker 与小脑就绪后，等待用户在大脑会话明确发出开始指令，再执行 start-work --confirmed，成功后才 plan。唤醒端须先 park；无唤醒端接入后实际 wait --seconds 60 保持可领取，宿主工具超时至少 90 秒，不把空队列当完成。小脑必须就绪，不支持跳过初审。后续已授权任务、审核、返修与唤醒自动继续，不逐单要求人工确认。已结束项目重新打开后重新等待开始；服务重启或普通重连不重置已启动项目。服务只能校验大脑提交的明确确认，不能独立识别聊天中是否为真人发令，大脑不得自行代替用户确认。

```powershell
node "<客户端脚本>" start-work --confirmed --credential "<大脑凭据>" --data "<服务目录>"
```

status.startup.state 为 waiting 时不得派单；started 表示已启动。

Skill 由当前模型读取，模型调用客户端与服务交互。connect 是启动协作入口；discover/status 仅供只读检查。

## 默认接入

用户要求派发、服务协作或继续开发时，默认当前会话为 brain、当前工作目录为项目。保留用户明确指定或宿主绑定的 worker 身份，不因本入口切换角色。只规划、解释或查看状态不启动服务。

定位客户端后，在当前项目目录执行：

```powershell
node "<client>" connect --provider "<当前真实平台>"
```

<!-- [AI-added] 2026-09-17 11:46 -->
命令默认使用 cwd、brain 和项目内 `.task-dispatch/runtime/<项目路径摘要>/` 独立服务目录；凭据也保存在该受保护且被忽略的运行目录。用户指定自定义或旧服务时追加 `--data "<data>"`。每个角色首次 connect/rebind 前必须先询问用户当前会话平台，由用户明确选择；不得根据模型、目录、环境变量或邀请来源猜测。`connect/rebind` 必须显式传 `--provider <真实平台>`，缺失和 `auto` 均会在任何服务或凭据副作用前被拒绝，并提示可选平台。brain/reviewer 支持 Codex、MiMo、Qoder、OpenCode；worker 可使用合法平台名。Codex 仅在显式 `--provider codex` 后读取 CODEX_THREAD_ID；MiMo、CodeArts、OpenCode 等 wake 平台必须由宿主提供真实 `--session-id`；Qoder 首次连接可传当前邀请的一次性 `--invitation-id`，由提示 Hook 与桥接共同核实真实 session 和 workspace。管理台生成的 `--managed-rebind --invitation-id` 对所有平台仅表示换绑授权，仍不能替代真实 session 身份。管理台改绑弹窗按平台分别给出提示词：MiMo、CodeArts、OpenCode 那份命令已带 `--session-id <当前真实会话 ID>` 占位，Codex 与 Qoder 那份不需要人工填会话 ID；接收端只复制与自己平台对应的那条，不要改用其他平台的命令或删改参数。改绑到 Qoder 时先把那条提示词原样发给目标 Qoder 会话（其中带 `[TASK-DISPATCH-INVITE:<uuid>]` 握手标识，Hook 据此记录会话身份），再执行提示词里的 `rebind` 命令；跳过粘贴会让握手文件缺失，改绑在任何服务副作用前被拒绝。其他 worker provider 直接进入 wait，不要求 session ID。OpenCode 使用真实 `ses_...` ID，安装与宿主条件见 [OpenCode 接入](opencode.md)。

用户明确要求手动接入时，不自动派生任何会话：大脑只接入并生成邀请，等用户确认各端就绪且明确发令后才 plan。brain connect 在 reviewer 或计划内 worker 尚未连接时返回 `nextAction=setup-peers`：必须向用户展示 `reviewerInvite.text`；若 `workerInviteStatus=pending-staffing`，先执行 staff，再逐条展示回执中的 `workerInvites[].text`。即使回执同时包含 `parked:true`，也不能把角色配置误报为已完成或只回复等待。用户要求测试唤醒即由 connect/resume 核实适配器并配置，不能仅因 connect 返回 wakeEnabled:false 就默认 wait。先核对宿主真实会话目录与服务 workspace 一致，不能仅切换终端目录。status.connections 返回各绑定的会话 ID、wakeEnabled、provider、armed；armed 只证明曾 park，不保证通知已被处理。

brain 正常换绑使用 `rebind --role brain`，旧端有在途审核时保持 `handoverPending`，等待旧端安全提交。只有旧 brain 已永久不可用，并且用户明确确认旧会话及其后台任务均已停止时，才允许追加 `--recover --confirmed-stopped`。确认式恢复会撤销旧 brain 凭据、替换遗留 pending handover，并把未结算 brain attempt 的所有权转给新 brain；新端随后用返回凭据执行 claim 继续同一 attempt。模型不得自行添加确认参数。worker/reviewer 不支持该恢复参数，仍走原安全交接。

brain connect 还返回 reviewerOnline、reviewerSpawnRequired 和 reviewerInvite。连接阶段若 reviewerSpawnRequired 为 true，使用宿主已授权的派生能力创建一个独立经济模型小脑审核员，将 reviewerInvite.text 原样交给它；先核实真实子会话身份和模型，不能复用大脑或执行员凭据。已有在线 reviewer 时复用，不重复派生。宿主不支持派生或无法取得真实会话 ID 时展示邀请并说明未接入；接入阶段报告缺项，小脑接入完成前不能启动。离线旧 reviewer 换绑使用 rebind --role reviewer；先核对旧端状态，不借用旧凭据。

所有候选审核请求（包括既有实现导入及返修）先交在线 reviewer，全阶段 pass 后才交 brain 集中终审；needs_fix 直接返回 worker，blocked 保留阻塞。小脑无权终审接受、派单或修改候选。初审按 artifactId 绑定，候选更新必须重新初审。规划、收尾、越界处置属于大脑管理操作，仍由大脑处理。

reviewer 使用 connect --role reviewer 接入；heartbeat 或 progress 仅用于可选进度展示，不是所有权租约。已 claim 的初审不因耗时、无心跳或暂态适配器读取失败被撤销，attemptId/clientId 校验继续阻止重复提交。审核端确定停止时由自身显式 detach；若 reviewer 已崩溃，brain 核实后明确执行 `detach --role reviewer --credential <brain凭据> --data <服务目录>`。服务只在这个显式信号下结算该端在途初审并等待新的 reviewer 恢复初审，随后旧 reviewer token 失效。服务重启后不从旧活动时间猜测在线。每次初审也计入任务尝试额度与用量。

brain connect 返回 staffingRequired、已有 staffing 和 workerInvites。首次连接先评估近期工作，使用 staff --file 登记后输出各执行员邀请，不固定假设一个 default worker 足够。多个 worker 使用独立 --worker-id 和任务 workerId 定向关联，详情及主动断绑/换绑见 [多执行员接入](workers.md)。

用户明确要求在已结束项目继续派发或开发时使用 `connect --continue`，它通过管理端重新打开当前目录对应项目。无需让 brain 用任务回执绕过关闭状态，也不用让用户手动运行 reopen-project。用户只查看状态时不能带此参数。新目录自动创建独立项目及凭据，不沿用旧目录凭据；同目录继续工作复用原项目与历史。

不询问已知的 cwd、默认 brain 或可生成的凭据路径。仅在大脑未提供换绑意图但已有不同会话占用角色、客户端不可用、真实会话 ID 不可得或用户的明确边界规则尚未授权必要写入时停止并说明具体缺项。已有启动和绑定授权覆盖相应服务数据及凭据写入，不重复索要同一授权。

## 定位服务

<!-- [AI-added] 2026-09-17 11:46 -->
优先使用本会话已确认的客户端、数据目录和角色凭据。否则读取安装后 Skill 根目录的 `runtime-link.json`：`client` 是开发仓库客户端绝对路径；新版 `dataMode=workspace-local-v2` 表示由客户端根据已确认工作区解析项目内私有运行目录，旧版 `data` 固定路径继续兼容。该文件不含令牌；仓库移动后重新安装即可更新。原生插件或源码直接加载没有此文件时，检查本 Skill 所属仓库的 `runtime/desktop-client.cjs`，不扫描用户磁盘或猜测其他仓库。

用户提供了自定义数据目录时优先使用该目录；已有凭据必须沿用其中记录的数据目录。不能由“项目默认目录未找到连接”推断旧全局或其他自定义服务不存在。脚本不存在、工作区不明确或自定义目录未知时说明具体缺项；不要静默扫描磁盘或猜测其他服务。

```powershell
node "<client>" discover --workspace "<当前项目绝对路径>"
```

新版工作区模式省略 `--data`；读取旧全局或用户指定服务时追加原 `--data "<data>"`。

已有明确角色可追加 `--role brain` 或 `--role worker`。结果只包含连接元数据和凭据路径，不要读取或展示凭据内容。默认规划入口使用 brain；不因空闲切换角色。用户粘贴指定 worker 邀请即授权接替该编号，connect 自动换绑；大脑必须通过 handoff-invite 生成的 rebind 提示词接替。换绑由服务完成，不借用旧凭据。

## 复用与首次接入

确认是本会话原绑定后，用返回的客户端、数据目录和凭据路径查询服务：

```powershell
node "<client>" status --credential "<credential>" --data "<data>"
```

核对项目目录、角色、已有任务、暂停及完成状态。认证失败或凭据缺失时停止复用并说明原因；服务离线时按已授权的恢复流程处理，不自动另建身份。状态仅代表查询时刻；实际可领取任务以 claim 为准。

无连接且用户要求开始协作时调用上方 connect。旧版本使用自定义凭据路径的会话传原 `--credential` 复用；自动入口检查已有会话或唤醒身份，冲突时不抢占。底层 attach 与唤醒细节见 [桌面会话接入](desktop.md)。

## 工作闭环

1. brain 先查询状态，避免重复派发已有任务。将已授权工作按任务模板拆分，用 `plan` 提交；worker 不能派单。
2. 用 `claim` 领取正式任务，按返回的身份、工作目录和提示执行，使用 `submit` 提交实际结果。
3. 实际执行 `resume`，由脚本选择 `park` 或有界 `wait`；按回执处理任务、缺项和结束，不自行猜测平台续接方式。
4. 暂停、阻塞或预算耗尽时报告原因；项目完成时结束。不要为查询进度启动模型轮询。

服务状态优先于聊天中的任务清单；`submitted` 不是审核通过。恢复时先查询和领取，不能重复实现原尝试。

## 自动待命与调度告警

非 Web 目标项目由用户在大脑会话说一次“开始”；大脑据此执行 `start-work --confirmed`，其他角色接入后自动待命，无需再次确认开始。connect 成功配置唤醒后会实际 park，返回 `parked:true` 即可结束回合；若返回 job，立即处理，不丢弃。wait 平台按 nextInstruction 实际 resume，attention 必须报告具体缺项。大脑同样配置唤醒和待命，派单后实际 resume，不能只口头说等待。Codex 自动从精确匹配的本会话日志读取真实 turnId；无法核实才要求显式提供。

`plan` 成功只表示入队，不能宣称对方已收到。核对 `dispatch.blocked/reason`、任务 attempt、wakeNotice 和 claim；存储阻塞必须向用户报告，管理台顶部和异常列表同时显示。清理缓存可双击仓库根目录 `清理缓存.bat`，自定义服务目录追加 `--data "服务目录"`，只预览追加 `--preview`。只删除当前保留策略允许清理的服务缓存；不会删除源工程、连接或任务。若剩余数据仍超限，明确报告仍阻塞。

<!-- [AI-added] 2026-09-17 11:46 -->
项目根目录 `tmp/` 只放可重建的临时文件，新快照策略默认排除；任务交付、审核证据和需长期保留的状态不得写入其中。服务自身状态、凭据、备份与诊断文件写入 `.task-dispatch/runtime/`，该目录由局部 ignore 和快照策略强制排除；权威计划仍放 `.task-dispatch/plan.md`、`.task-dispatch/tasks/` 或 `docs/plans/`，不得放入 runtime。执行证据放任务明确授权的 `docs/worker-results/<任务ID>/`。
