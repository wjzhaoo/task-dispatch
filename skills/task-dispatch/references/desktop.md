# 桌面会话接入

日常接入统一使用 `connect`；接收端复用用户已明确指定的平台或本端凭据记录的平台，仅缺少平台信息时才询问。不得根据模型名称、目录或邀请来源猜测平台和会话身份。平台、会话及工作目录核验失败时展示具体错误并补充真实信息，不切换其他平台或静默降级。

```powershell
node "<客户端脚本>" connect --provider codex --role brain
node "<客户端脚本>" connect --provider mimo --role reviewer --session-id "<宿主真实会话 ID>"
node "<客户端脚本>" connect --provider qoder --role worker --worker-id "<编号>" --invitation-id "<邀请中的一次性 ID>"
node "<客户端脚本>" connect --provider opencode --role worker --worker-id "<编号>" --session-id "<宿主真实 ses_ ID>"
node "<客户端脚本>" connect --provider codearts --role worker --worker-id "<编号>" --session-id "<CodeArts 真实会话 ID>"
```

在项目真实工作目录执行邀请命令，保留邀请中的角色、执行员编号、能力、工作区、服务目录和邀请 ID。普通接入以当前 cwd 为工作区，自动保存独立凭据至受保护的 `.task-dispatch/runtime/`；显式 `--data` 仍可覆盖服务目录。凭据和 token 不向聊天或其他角色展示，不共用其他会话的凭据。

Codex 仅在已明确选择 codex 后读取 CODEX_THREAD_ID；服务从该真实会话记录定位当前 turnId，核实会话工作目录；也可显式补充真实 `--turn-id`。MiMo 使用宿主真实 session ID，自动读取成功消息中的模型信息；缺失时补充已确认的 `--model provider/model`。MiMo 适配器遵守宿主已有权限偏好，不替用户批准请求。Qoder/QoderCN 使用当前邀请的握手记录与常驻 App Plugin，见 [Qoder 原会话接入](qoder.md)；OpenCode 使用真实 ses_ ID、可读本地会话数据和官方 CLI，见 [OpenCode 原会话接入](opencode.md)。CodeArts 的所有角色使用独立 Hook bridge，见 [CodeArts 原会话接入](codearts.md)，不能改传 opencode。DSH 使用本机 Remote API 和真实 session ID，沿用会话模型，见 [DSH 接入](dsh.md)。其他合法 worker 平台使用 wait，不支持 wake 的 brain/reviewer 平台会明确拒绝。

connect 自动完成真实会话核验、注册、续接配置和待命，返回最终结果；无需再手工配置唤醒或重复查询 status。服务已启动时，客户端只请求轻量 `/ready` 和一次 `connect`；绑定和待命在一个同步事务中提交。宿主核验在事务前执行，失败不会发布新绑定。相同有效绑定的重连复用核验结果和凭据，不重复写入状态、凭据和连接描述。

- `job` / `nextAction:work`：立即处理正式任务，按角色协议提交，然后实际 `resume`。
- `parked:true`：已待命，结束当前回合，等待服务唤醒。
- `nextAction:wait`：实际执行 `resume --seconds 60`，由本地进程阻塞等待；宿主工具超时至少 90 秒。有进程会话 ID 就续等原进程，不重复启动等待。
- `nextAction:attention`：展示具体错误，只补缺项，不循环重试。
- `completed:true`：项目已结束，停止协作。用户明确继续原项目时，由大脑 `connect --continue` 重新打开。

```powershell
node "<客户端脚本>" resume --credential "<本端凭据文件>" --data "<服务目录>"
```

Web 管理端已提供团队、邀请和目标；创建和接入后先待命，全员就绪后等用户在 Web 点击「开始」并确认；已明确加入队列的目标顺序执行。不重复 staff、生成邀请或索要已有授权。非 Web 项目先完成 staffing、初审端和执行员接入，用户向大脑明确发出开始指令后，大脑执行 `start-work --confirmed`。小脑必需，不能跳过初审。任务统一走 [阶段计划与终审](stages.md)，提交、预检和回执见 [任务与验收模板](handoff.md)。

换会话使用 `rebind` 或管理台改绑邀请，沿用接入时的真实平台及会话核验，不覆盖旧端凭据。仍有在途任务时进入安全交接等待；新端执行 resume，完成后直接处理回执，无需再次 connect 或核验；旧会话永久不可用时，只能在用户确认旧会话和后台任务均已停止后，按邀请执行带 `--recover --confirmed-stopped` 的恢复。已有 wait 进程或遗留锁时先核实原进程，不能同时启用唤醒或启动第二个等待。新增和改派见 [多执行员接入](workers.md)。
