# CodeArts 原会话接入

CodeArts（`--provider codearts`，兼容 `codeartsdoer`）支持已有 brain、reviewer 和 worker 会话唤醒。它使用独立 Hook bridge，与 OpenCode 2.x 的数据库和 CLI 适配器分开。不能因 CodeArts 使用 OpenCode 内核就改传 `--provider opencode`。

## 桥接前提

已有 CodeArts Hook 环境需加载本仓库的 `skills/task-dispatch/codearts-hook.mjs`。当前 Skill 安装器支持 Codex、MiMo、Qoder/QoderCN 和 OpenCode，不自动安装 CodeArts；新环境须先按 CodeArts 的插件配置方式加载 Hook，再重新加载宿主。

Hook 通过宿主已认证的 SDK 访问会话，并建立随机 Bearer token 保护的本机 HTTP bridge。描述文件位于 `~/.codeartsdoer/task-dispatch/`：`bridge.json` 记录项目端点，`<sha256(sessionId)>.json` 记录具体会话。适配器每次请求重新读取端口和凭据，优先使用具体会话文件。凭据内容不得粘贴、记录到日志或提交仓库。

IDE 重启时，通用描述文件可能先刷新，具体会话文件仍保留旧端口。仅旧端口明确拒绝连接（`ECONNREFUSED`）时，适配器才改读同工作区的 `bridge.json`，以新端口和凭据访问原会话；新桥接尚未就绪时，待发通知保留并在后续调度重试。其他工作区的桥接、用户显式指定的描述文件、连接重置和超时均不会触发自动切换。恢复后继续用原凭据执行 `resume`。

## 首次接入

使用宿主提供的真实会话 ID；缺少时，将含 `[TASK-DISPATCH-INVITE:<uuid>]` 的邀请原文发给目标 CodeArts 会话，再通过 bridge 唯一匹配邀请：

```powershell
node "<客户端脚本>" discover-session --provider codearts --invitation-id "<uuid>" --workspace "<项目绝对路径>"
```

未命中或命中多个会话时，按回执处理；不按目录、标题或更新时间猜测，不改读 OpenCode 2.x 数据库。

```powershell
node "<客户端脚本>" connect --provider codearts --role worker --worker-id "<编号>" --session-id "<真实会话 ID>" --workspace "<项目绝对路径>" --data "<服务目录>"
```

Web 邀请还须保留原命令的 `--join-invitation` 等参数。连接只读取指定会话，验证身份与项目目录后保存绑定并自动待命。CodeArts 不需要 Codex 的 turnId；可选 `--model provider/model`，省略时沿用会话模型，不填写猜测的模型名。

返回 `parked:true` 后结束回合，返回 `job` 则处理任务。提交后执行 `resume --credential "<本端凭据路径>" --data "<服务目录>"`，复用原绑定。不要调用已移除的 `attach`、`wake-bind` 或 `wake-disable`。

服务在会话空闲时通过 bridge 的异步 prompt 接口发送通知；HTTP 204 仅表示接收，任务仍须领取、提交和审核。超时或响应不确定时核对历史标记，不盲目重发。缺失或失效的 bridge 会报告具体错误，不自动降级为 wait 或路由至其他平台。
