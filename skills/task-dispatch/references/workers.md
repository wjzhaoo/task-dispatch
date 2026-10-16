# 多执行员接入、断绑与换绑

## 越界退回

worker 用独立回执提交执行报告，不维护计划文档。越界提交会退回同一个 worker，scopeRecovery 包含原始和被拒快照、越界文件及精确恢复目标。只纠正本人越界增量，保留原实现，不整文件覆盖他人修改；重新通过范围检查后才生成审核候选。该恢复例外不授予计划编辑权限。连续两轮纠正失败或修改来源不明时停下交给 brain。

brain 收到 kind=scope_attention 时核对阻塞和差异，说明需要处理的事项；用 `scope-ack --task <taskId> --alert-id <alertId>`（带原 brain --credential/--data）确认通知。确认不放行任务，不扩大路径。管理员可用 `return-scope <projectId> <taskId>` 让旧版已阻塞的越界尝试进入相同流程；服务在项目空闲时逐项检查，保留每次原始证据。

除越界退回外，一切 blocked/uncertain 结算（契约冲突、缺失前提、返修超限、运行错误等）都会登记 task_attention 并自动唤醒大脑。大脑收到 kind=task_attention 时先核对 status 中的 attention 与阻塞原因，向用户说明后再处置：`assign --task <id> --retry --reason` 改派重试、管理端 retry、configure-repair、task-budget 追加额度或调整计划；处置后用 `attention-ack --task <taskId> --alert-id <alertId>`（带原 brain --credential/--data）确认。先执行 assign --retry 再 ack 也合法，ack 幂等。原因未核实前不盲目重试。等待型（无唤醒）平台会话停止时服务无法主动通知，管理台以 wait_stalled（任务已派发但执行端静默超过 5 分钟）与 connection_silent（执行端静默超过 10 分钟）提示，需人工回原会话核实或重新接入。

一个项目有一个 brain 和多个独立 worker。worker 编号如 `strong`、`economy`、`tests`；未指定编号的旧 worker 为 `default`。协议角色仍为 brain/worker，编号不改变角色权限。当前每个项目串行修改和审核，不是多个 worker 同时改原目录。

## 大脑端派发

用户说“派发某任务”时，按 connection.md 用当前目录执行 connect（继续已结束项目则 --continue），不让用户手填项目或凭据。connect 后评估本阶段人员配置，以 staff 返回的 workerInvites 将对应文案展示给用户，明确需要粘贴到另一个 worker 会话后才完成双端关联。已有匹配执行员则直接复用，无需再次粘贴。brain connect 不代表 worker 已在线。

需要新增不同执行员时，生成指定编号的文案：

```powershell
node "<client>" invite --credential "<brain凭据>" --data "<data>" --worker-id strong --capability strong
```

把输出 text 原样展示或保存为可复制文件。文案包含项目、客户端、服务目录、编号与能力要求，没有 token，不包含 brain 凭据。不要代用户向其他会话发送消息。strong/economy 是用户确认的能力标签，不是服务检测到的实际模型；接入端先核实模型配置符合要求，不能为了领取任务随意声明 strong。

worker 端按文案运行：

```powershell
node "<client>" connect --provider "<当前真实平台>" --role worker --worker-id strong --capability strong --data "<data>"
```

cwd 使用文案指定的项目目录。接收端必须显式传真实 provider。Codex 仅在 `--provider codex` 后读取 CODEX_THREAD_ID；MiMo、CodeArts 等 wake 宿主必须显式提供真实 session；Qoder 首次连接可用当前邀请的一次性 ID 核实真实 session。其他 wait-only provider 不要求真实 session ID。凭据自动生成，每个编号独立。

任务包可增加 `workerId` 和 `requiredCapability`。例如 D03 要求强模型，则指定 `workerId: "strong"`、`requiredCapability: "strong"`，不能继续默认发给经济模型。未指定 workerId 使用 default。没有匹配绑定时任务保持 ready、不增加执行尝试次数，status 返回 waitingForWorker；告诉用户“任务已登记，等待执行员接入”，不能说已经执行。服务保留具体 worker 编号、尝试和凭据身份，其他 worker 不能领取或提交它的任务。

## 主动断绑

当前会话主动退出绑定：

```powershell
node "<client>" detach --credential "<本会话凭据>" --data "<data>"
```

brain 在用户要求下断开指定 worker：

```powershell
node "<client>" detach --worker-id economy --credential "<brain凭据>" --data "<data>"
```

断绑撤销服务端令牌、会话和唤醒绑定；旧等待进程收到错误退出。已领取或已派发未结算的尝试不能直接断绑，先让原执行端提交实际结果或 blocked，再断绑。不能把未知仍在运行的进程当作停止。

## 无需手工断绑的会话交接

大脑说“我要换绑”时，在原会话执行 handoff-invite（带原 --credential/--data），将返回 text 原样交给用户。新会话粘贴后按文案执行 rebind --role brain；不要在旧会话执行 rebind，也不发送旧令牌。

worker 邀请是对应逻辑编号的可复用接替提示词。在新会话粘贴后 connect 自动请求换绑；同一会话重复连接幂等。每个会话使用独立凭据文件，旧文件不覆盖，旧 token 在交接完成时撤销。显式 rebind 仍兼容。

有在途尝试时返回 handoverPending，服务持久化交接请求并停止该 worker 的新任务。旧端先提交真实结果或 blocked；原 worker 的 scopeRecovery 必须先解决。新端不得执行或接管未结算的写入。服务在安全边界自动切换，新端再次 connect 获取状态和原队列；旧端失联时不猜测它已停止，明确报告交接等待。凭据轮换不等于终止操作系统进程。

新端必须重新绑定自己的唤醒，不继承旧 threadId；历史回执、审核和任务保留。冲突的第二个接替请求被拒绝，不能静默替换第一位等候者。

返回 handoverPending 后执行输出 nextAction 中的 handover-wait 命令。等待由本地脚本轮询，不调用模型；默认最多一小时，超时仍是等待，不是接替成功。若工具返回进程ID，继续等待原进程，不重启第二个等待者。返回 attached:true 后绑定新会话唤醒并 claim；无需用户再次手工断绑或粘贴。旧端失联需要用户恢复旧会话或明确处置，不能伪造结算。

reviewer 崩溃且无法自解绑时，brain 可在核实异常退出后执行 `detach --role reviewer --credential <brain凭据> --data <服务目录>`。这是明确的终止和恢复操作：服务结算旧 reviewer client 拥有的在途初审、将任务恢复为待初审，等待新的 reviewer，并撤销旧 token。不要仅因等待时间长或一次宿主读取失败执行此命令。worker 的 `detach --worker-id` 与安全交接语义不变。

## 本阶段执行端配置

Web 目标项目直接复用页面已保存的团队：默认大脑、初审端和一名 general 执行员。大脑不再 staff 或生成邀请；如需调整，先结束活动目标，再由 Web 的「调整成员」操作保存，换会话仍显式改绑。以下 staff 流程用于非 Web 管理项目。

连接后先阅读任务及现有 worker，评估近期独立交付边界、模型能力、数量、职责、依赖和并发收益。大脑只规划和审核，实现全部交 worker。复杂的状态机、锁、恢复协议保留完整任务，定向 strong；稳定且重复的实现可交 economy。不要固定配置数量。

用 staff --file <JSON>（带 brain --credential/--data）登记：

    {"rationale":"本阶段需要完整实现恢复协议与独立整理测试数据","workers":[{"workerId":"strong-1","capability":"strong","responsibilities":"恢复协议完整实现"},{"workerId":"economy-1","capability":"economy","responsibilities":"已冻结接口下的测试数据整理"}],"concurrencyRequested":false}

返回 workerInvites，逐条展示给用户。任务必须填写对应 workerId/requiredCapability。能力是用户核实的标签，不是自动模型检测；现有合适 worker 直接复用。若无需执行工作 workers 可为空。

当前 executionMode=serial-shared-workspace：同项目仍串行。concurrencyRequested 记录评估意图，不启动并发。只有隔离工作区、候选合并和集成验收机制就绪后才能并发；共享文件、未冻结接口和依赖任务保持串行。跨独立项目沿用服务既有并发限制。

## 任务改派

assign --task <任务ID> --worker-id <编号> --capability <能力> --reason "调整原因"（带 brain --credential/--data）将 ready 任务交给另一个编号；blocked 实施任务可加 --retry。不能改派在途尝试或原 worker 的 scopeRecovery，不修改已通过历史和允许路径。换绑改变同一编号的会话，assign 改变任务接收编号。

assign 默认只更新当前执行者 currentWorkerId（workerId 为兼容别名）与当前 requiredCapability，保留 plannedWorkerId/plannedRequiredCapability。本任务后续返修继续使用当前执行者；新任务不会继承它。跨任务延续强模型时，大脑对对应未开始任务使用 assign --update-plan --reason "原因"，同时明确计划与当前分配。所有改派记录原因；旧客户端需补 --reason。

任务包可指定 maxAttempts，默认 30，执行和审核 attempt 共用该任务额度。status 的 attemptCounts 分别给出 execution/review/total，maxAttempts 是任务上限，budgetExhausted 表示无法新增 attempt，已派发 attempt 仍可领取和提交。项目 projectAttempts 是历史累计次数；projectBudgetEnabled 控制可选项目保护。

大脑需要追加额度时调用 task-budget --task <任务ID> --add 10 --reason "补充验证"（带原 brain --credential/--data）。追加数为正整数，服务保留计数并记录原因；升级和换绑不会自动追加。blocked 仍需按原重试规则处理，追加额度不会绕过恢复、越界纠正或交接边界。
