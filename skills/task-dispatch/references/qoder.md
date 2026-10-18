# Qoder / QoderCN 原会话直接唤醒

Qoder 使用随 IDE 启动的 task-dispatch App Plugin 桥接。桥接调用 Qoder 的 `chat.continueSession`，与 builtin MCP 的跨会话发送能力共用底层会话服务。目标会话不运行 Stop Hook、不轮询文件，也没有 60～600 秒监听期限。

状态中的 `armed: true` 表示该绑定最近已执行 `park`，服务持久保留“允许下一项任务唤醒”的授权；它不表示 Qoder 当前在线。管理台把这项状态显示为“待命授权”，并用独立的宿主观测显示桥接是否实时可达。管理台通过 SSE 每 2 秒更新，同时提供手动“刷新”按钮。

## 安装

```powershell
node scripts/install.js qoder
node scripts/install.js qodercn
```

安装器完成四项工作：

1. 安装 task-dispatch Skill。
2. 将桥接插件写到 `~/.qoder/app/dev-extensions/task-dispatch-bridge`，CN 版写到 `~/.qoder-cn/app/dev-extensions/task-dispatch-bridge`。
3. 安装轻量 `UserPromptSubmit` 首次握手 Hook，只在用户提交的邀请中提取一次性邀请 ID、当前 `session_id` 和工作区；不读取历史、不轮询任务。
4. 启用 Qoder 本地开发插件加载环境。当前只安装 UserPromptSubmit 邀请握手 Hook，任务唤醒由 App Plugin 桥接完成。

安装或升级后重启 Qoder 一次。桥接在 Qoder 启动时监听随机本机端口，并把带随机令牌的发现文件写到配置目录下的 `task-dispatch-bridge.json`。发现文件和令牌不得输出、复制到项目或提交版本库。

## 接入

新邀请自带一次性 invitation ID。接收端在当前 Qoder 会话提交邀请后，可直接用该 ID 完成首次连接：

```powershell
node "<客户端脚本>" connect --provider qoder --invitation-id "<邀请 ID>"
```

客户端只读取该 ID 对应的本机握手记录，要求工作区精确一致、记录未过期且唯一；服务再通过记录所属的桥接 `chat.observeTurn` 核验一次真实会话，并保存桥接位置供后续唤醒。重复提交同一邀请不刷新记录；一个邀请用于不同会话会明确拒绝，需生成新邀请。也可显式提供宿主已知的真实 session ID：

```powershell
node "<客户端脚本>" connect --provider qoder --session-id "<真实 session ID>"
node "<客户端脚本>" resume --credential "<凭据文件>" --data "<服务目录>"
```

已有绑定继续使用：

```powershell
node "<客户端脚本>" resume --credential "<凭据文件>" --data "<服务目录>"
```

Qoder 不支持按目录、标题、文件时间或“最新会话”猜测身份。直接通道不读取完整会话历史；首次连接必须使用当前提示产生的一次性 invitation ID，或宿主明确提供的真实 session ID。绑定时桥接通过 `chat.observeTurn` 核实会话存在；项目工作区来自本次角色凭据和服务项目绑定。

`parked:true` 表示角色已允许接收下一项任务，可以结束当前回合。worker 运行数小时不会使 Qoder 待命失效，只要 Qoder 应用和桥接仍在运行。

## 投递语义

服务发送的通知包含唯一 `TASK-DISPATCH-WAKE:<attemptId>` marker。桥接把该 marker 同时作为 Qoder `requestId`，随后调用：

```text
chat.continueSession({ sessionId, prompt, requestId })
```

成功返回只表示新消息已被 Qoder 接收。目标会话仍须执行 `claim` 获取正式任务，完成后 `submit`，再 `park`。

桥接状态映射：

| Qoder 状态 | 调度状态 | 行为 |
| --- | --- | --- |
| `ready` / `idle` | `idle` | 可以投递 |
| `opening` / `running` / `queued` | `active` | 暂缓投递 |
| 会话不存在或已归档 | `unavailable` | 显示错误并要求重新绑定 |
| 桥接暂时不可达 | `unknown` | 保留任务，不静默改派 |

发送响应丢失时记为 `uncertain`，不自动重发。用户核对目标会话后，可在原会话手动 `claim`；未领取任务仍保留在服务队列中。

## 安全边界

- 桥接只监听 `127.0.0.1` 的随机端口。
- 每次 Qoder 启动生成新的 256 位随机令牌，使用常量时间比较鉴权。
- 桥接仅暴露会话状态读取与向指定 session ID 发送消息，不读取任务正文或调度凭据。
- 正式任务继续由目标会话自己的 task-dispatch credential 领取。
- Qoder 应用关闭后无法唤醒；重新启动 Qoder 后桥接自动恢复，无需重新 park。
- 不保留旧 Stop Hook 降级路径，避免双通道重复投递和过期监听造成虚假在线。

## 排错

- `Qoder direct wake bridge unavailable`：重新运行安装器并重启 Qoder，确认 `QODER_APP_PLUGIN_ALLOW_UNVERIFIED=true` 对新进程生效。
- `APP_PLUGIN_SESSION_UNAVAILABLE`：session ID 不存在、已归档或属于另一 Qoder 产品实例，使用当前真实 session ID 重新连接。
- `APP_PLUGIN_TURN_REJECTED` / busy：目标正在处理其他回合，服务保留 pending，空闲后重试。
- HTTP 401：发现文件与正在运行的桥接实例不一致；重启 Qoder，让桥接重写发现文件。

跨会话能力依据与人工验证步骤见 `docs/hook-wake/qoder会话自动唤醒方法.md`。
