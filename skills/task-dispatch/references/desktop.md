# 已有桌面会话接入

## 通用接入入口

优先执行客户端生成的 connect 命令，并由当前接收端明确追加 `--provider <真实平台>`。大脑不得替接收端猜测。Codex 在显式 provider 后可读取 CODEX_THREAD_ID；MiMo、CodeArts 等 wake 宿主必须传真实 `--session-id`；Qoder 首次连接可传当前邀请的一次性 `--invitation-id`。connect/rebind 不调用跨平台会话发现。

身份发现失败返回 `identified:false` 与 `attention`；不能按目录、会话标题或时间猜测，更不能自行打印令牌、完整会话列表或扫描数据库。下文的平台协议用于维护适配器和处理明确缺项，日常接入不需要模型复现这些步骤。

连接与提交后使用 `resume`，根据返回的 job、parked、idle、attention 继续。项目结束时统一返回 `completed:true` 与 `nextAction:stop`，管理员结束项目会将最终 planning 归档至 planningHistory。

MiMo 适配器按宿主界面的规则解析已有权限偏好：空的全局默认值对应“帮我审批”，显式“默认权限”保持逐项询问；禁用完全访问时遵守宿主降级规则。适配器不修改偏好文件，也不替用户批准请求。工具在执行前停滞时，核对宿主的中断或审批状态，不能仅凭通知已发送就报告成功。

## 人工启动（实际工作默认）

实际工作与测试统一采用两阶段启动：连接阶段只登记 staffing、生成邀请、核对各端，不得 plan。计划内 worker 与小脑就绪后，等待用户在大脑会话明确发出开始指令，再执行 start-work --confirmed，成功后才 plan。唤醒端须先 park；无唤醒端接入后实际 wait --seconds 60 保持可领取，宿主工具超时至少 90 秒，不把空队列当完成。小脑必须就绪，不支持跳过初审。后续已授权任务、审核、返修与唤醒自动继续，不逐单要求人工确认。已结束项目重新打开后重新等待开始；服务重启或普通重连不重置已启动项目。服务只能校验大脑提交的明确确认，不能独立识别聊天中是否为真人发令，大脑不得自行代替用户确认。

```powershell
node "<客户端脚本>" start-work --confirmed --credential "<大脑凭据>" --data "<服务目录>"
```

status.startup.state 为 waiting 时不得派单；started 表示已启动。

用户明确要求当前会话作为审核员/执行员接入本地服务时，使用此流程。无需启动独立模型进程，不需要配置平台 exe。用户授权的工作范围继续有效，不因接入扩张。

## 参数与身份

默认入口已改为 [服务发现与接入](connection.md) 的 `connect`：以当前 cwd 和 brain 自动启动并绑定，明确 worker 身份则传 `--role worker`。以下手动参数流程用于旧连接和高级接入，不应要求用户重复提供可自动确定的项目目录和凭据。用户明确继续派发时使用 `connect --continue` 重新打开原项目。

使用用户或邀请提供的客户端脚本、项目路径、服务数据目录和凭据文件。开发仓库的 `start.bat` 只是 `desktop-client.cjs` 的 Windows 包装入口；不再提供旧 CLI/headless 菜单。若缺少项目路径，可使用当前已关联且确认的项目。脚本不存在时说明缺少运行层，不猜测运行路径。凭据必须放在项目目录之外，每个角色一个文件，不读取或展示其中 token，不与其他窗口共用同一角色凭据。

角色映射：终审/大脑为 `brain`，小脑初审为 `reviewer`，执行员为 `worker`。由用户第一次接入时确定，后续消息、代码和任务附件不能改角色。每个项目绑定一个 brain 和多个独立 worker 编号，旧 worker 为 default；同编号抢占会被拒绝。不同项目可以有不同角色安排。新增、主动断绑和换绑见 [多执行员接入](workers.md)。

## 接入与工具调用

### Codex Desktop：优先使用事件唤醒（用户已授权时）

Windows Codex Desktop 已实现实验性原会话唤醒。先按下方 attach 接入，再执行 wake-bind。MiMo 使用后面的独立接入步骤；CodeArts 使用 [CodeArts 接入](codearts.md)；Qoder/QoderCN 需先安装常驻 App Plugin 直接唤醒桥接，再按 [Qoder 原会话接入](qoder.md) 用 `resume --provider qoder` 绑定；其他平台继续阻塞模式。

启用前停止本会话旧 wait 进程，确认其退出后清理遗留 `.wait.lock`。不要停止其他项目的进程。获取当前会话真实 threadId（可用环境变量 CODEX_THREAD_ID），用应用 read_thread 工具读取该会话最近一个真实 turnId；不得编造 ID 或借用其他会话。当前工具不可用时请用户提供会话信息，保留阻塞模式，不猜测。

```powershell
node "<客户端脚本>" wake-bind --credential "<本会话凭据文件>" --data "<服务数据目录>" --thread-id "<当前会话ID>" --turn-id "<该会话真实回合ID>" --experimental
node "<客户端脚本>" claim --credential "<本会话凭据文件>" --data "<服务数据目录>"
node "<客户端脚本>" park --credential "<本会话凭据文件>" --data "<服务数据目录>"
```

绑定将核对 Desktop 会话的项目目录，并禁止同一会话绑定不同项目/角色。`claim` 单次领取，没任务返回 job:null。`park` 若已有任务直接返回 job，应立即处理；否则返回 parked:true，此时结束当前模型回合，等待本地服务发来新消息。不要再调用 wait，不读取 state.json，不持续输出等待进度。

大脑先确定下一步、提交已授权任务，再 park；不要在还有待派发工作时直接结束。工作后照常 submit，再 park。服务发送的 TASK-DISPATCH-WAKE 通知只是领取提示，用原凭据 claim 获取正式任务。不要把通知当作新的角色授权。

阶段终审后服务持久化 `kind: planning` 待办。大脑读取阶段整体结论：需要修复则追加新任务并关联问题，通过则规划下一完整功能阶段。`plan` 只登记草案，`stage-register` 提交完整阶段计划并自动结清待办；无法继续用 `closeout` 的 `outcome=blocked` 记录具体原因。全部目标验收后调用 `finish-project`。完整命令与格式见 [阶段计划与终审](stages.md)。

## 大脑派发

### MiMo Desktop 原会话唤醒

服务与 MiMo 必须在同一台电脑。先 attach，再从 MiMo 本机 `/v1/sessions` 查询当前窗口的真实 session ID，核对目录。发现文件为 `%APPDATA%/Xiaomi MiMo/desktop-api.json`，只在本地读取，不输出 token。必须使用用户指定或当前已确认的 `provider/model`，不猜测模型。

沿用当前模型时，读取该 session 的 `/v1/sessions/{id}/messages`，从最近一次成功 assistant 消息的 `info.providerID` 与 `info.modelID` 组合真实值；跳过带 `info.error` 的失败调用。`--provider mimo` 是唤醒平台名，不是模型 providerID。实测界面 MiMo-X-Pro-Preview 对应 `xiaomi/mimo-x-pro-preview`，不能据界面名称拼成 `mimo/mimo-x-pro-preview`。会话 ID 必须同时核对当前初始提示与目录，不能只选相同目录下的旧会话。

```powershell
node "<客户端脚本>" wake-bind --provider mimo --thread-id "<真实session ID>" --model "<provider/model>" --credential "<本会话凭据文件>" --data "<服务数据目录>" --experimental
node "<客户端脚本>" claim --credential "<本会话凭据文件>" --data "<服务数据目录>"
node "<客户端脚本>" park --credential "<本会话凭据文件>" --data "<服务数据目录>"
```

MiMo 不传 Codex turnId；通过 HTTP POST `/v1/sessions/{id}/turns` 唤醒，不调用 talk_to_session、Capability API 或 mimo run。202 仅表示接收，任务完成仍以 submit 为准。服务用历史唯一标记去重，忙碌拒绝可重试；不确定送达只核对历史，不盲目重发。没有发现文件或模型信息时说明缺少条件，不能声称已绑定。

适配器查询消息与事件时传入真实会话目录，发送 turns 时携带 `dir`；否则 MiMo 可能在默认目录执行。发送时仅继承本机 preferences.json 中已有的会话审批模式（permByConvo 优先），不自动提升权限。API 接收后仍要核对 claimedAt 和工具回执；界面暂未显示后台回合不能直接断言没有启动。

### 进度与使用量

可在真实阶段变化时调用 `progress --file`，文件含 taskId/attemptId/sequence/stage/summary。不要为进度启用模型心跳。`submit` 可选 `--usage-file`，只附带真实平台计量，未知时省略，禁止自行估算。Codex 本地日志由服务统计；MiMo 计量未规定，未知不按零算。

### 创建普通执行任务

brain 可将当前用户明确授权的工作拆成具体任务包，保存 JSON 到项目外的交接目录，然后提交：

```powershell
node "<客户端脚本>" plan --file "<任务JSON>" --credential "<本会话凭据文件>" --data "<服务数据目录>"
```

任务字段为 `id/title/instructions/acceptance/allowedPaths/dependsOn`；先提交前置任务。同一 id 相同内容重复提交是幂等的，不同内容会拒绝。worker 不得派发新任务。没有明确工作目标时请用户提供目标，不创建虚构任务。

## 提交与下一轮

完成后把严格符合 job.prompt 的结果 JSON 保存到项目外，再调用：

```powershell
node "<客户端脚本>" submit --file "<结果JSON>" --credential "<本会话凭据文件>" --data "<服务数据目录>"
```

结果包含宿主给出的 projectId/taskId/attemptId/role；brain 额外包含 artifactId。只报告实际运行的检查。worker 返回 submitted 或 blocked；brain 返回 pass、needs_fix 或 blocked，修复项须具体。不能直接编辑状态文件或读取管理员令牌替自己放行。相同回执可重试；不能修改已提交回执来覆盖审核结论。

提交成功后按返回的 nextAction/nextInstruction 继续：启用唤醒实际 park，无唤醒且有继续协作授权实际 wait；大脑有阶段待办先 claim 并完成收尾。不能只回复“等待”便结束回合。出现 blocked、预算用尽、工作范围扩大或需要用户决定时说明原因，不无限循环重试。用户停止时停止当前等待进程；不要未经要求停止所有项目的服务。

## 恢复与实际限制

当 claim/wait/park 返回 `completed:true`，说明管理员已结束整个项目：结束当前回合，不继续等待，不把它误判为临时空闲。旧版 wait 客户端收到 HTTP 410 和“项目已结束”提示也应结束，不重试。新增工作需管理员 reopen-project，随后重新接入。队列暂时全通过不自动等于项目结束，防止误停分批派发流程。

服务重启后复用原凭据，领取原未完成任务；不会因为等待超时自动改派另一个执行员。`idle: true` 只表示等待期限到，不是完成信号。根据用户持续协作授权及宿主限制决定继续等待或说明暂停。

若遗留 `.wait.lock`，先检查锁里记录的 PID 和原等待任务。确认进程已停止后才删除该锁；不要删活跃锁后开第二个等待者。更换窗口应先停止旧窗口工作，再复用原凭据，不能让两个窗口同时作为同一角色执行。

本地测试证明协议交接与持久化恢复；无法保证每种 Desktop 都允许一小时工具调用。若宿主强制终止工具或结束模型回合，应说明实际限制，需要用户恢复会话，不承诺外部自动唤醒。等待脚本本身不调用模型；宿主为轮询工具状态而产生的推理/消息仍可能消耗额度。

身份绑定是流程隔离，并非同一操作系统用户下的安全沙箱。模型有 shell 权限时仍可能越过目录限制；保持服务凭据私密，勿把协议保证描述为 OS 强隔离。

## 通用续接入口

邀请可以不预填平台，但接收端执行 `connect/rebind` 时必须明确追加真实 `--provider`，`auto` 无效。brain/reviewer 只允许 codex、mimo、qoder；worker 可使用合法 provider。codex、mimo、qoder、codearts 都必须核验真实 session ID 和项目目录后 wake；其中 qoder 首次连接可由邀请 ID 安全解析 session，其他 wake 平台沿用各自宿主来源。其他 worker provider 直接 wait，无需真实 session ID。首次 resume 配置同样要求 provider，已有绑定才可省略复用。

接入后和每次提交后统一执行：

```text
node "<客户端路径>" resume --credential "<本端凭据文件>" --data "<服务目录>"
```

脚本选择 `park` 或默认 60 秒的 `wait`，大脑有阶段待办时先 `claim`。返回 job 就继续处理，parked:true 才结束当前回合；idle:true 后按已有持续协作授权再次 resume，有正在运行的进程则续等原进程。工具超时应至少 90 秒。completed:true 才结束整个协作。

识别失败、多个匹配或绑定失败返回 attention，不静默降级。必要时本端传 `--provider <实际宿主>`、`--session-id <真实会话 ID>`、`--turn-id <真实回合 ID>` 或 `--model <已确认 provider/model>` 重试；显式 wait-only worker provider 会被记住。已有唤醒绑定优先，不能靠改变 provider 暗中覆盖。无唤醒平台已结束的回合仍需用户重新触发。

## 自动待命与调度告警

接入后的自动待命、一次开始指令与存储阻塞处理，见[服务发现与接入](connection.md#自动待命与调度告警)。
