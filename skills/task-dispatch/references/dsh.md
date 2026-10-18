# DSH 原会话接入

DeepSeek Harness Desktop 使用 `--provider dsh`，支持大脑 `brain`、小脑 `reviewer` 和执行员 `worker`。三种角色都走 wake；只有执行员可使用其他非 wake 平台并持续 wait。

## 宿主与身份

DSH Desktop 必须在服务所在机器运行。服务优先读取 `DSH_WEB_URL`；Windows 未配置时，通过带 `dsh-desktop-host` 参数的 `DeepSeek Harness.exe` 进程及其回环监听端口发现地址。每次操作重新发现，不缓存随机端口。若有多个候选地址，明确配置当前宿主 URL，不按顺序猜选。

服务从 `DSH_HOME`（默认 `~/.dsh`）下的 `.credentials.yaml` 读取 `client-connection/browser-session` 密钥，生成短期签名 Cookie。只允许回环地址，不跟随重定向；密钥和 Cookie 不写入绑定、日志或邀请。自定义环境变量须提供给服务进程。

使用宿主提供的当前真实 session ID，不根据标题或工作目录猜测。缺失时可在目标会话收到邀请后执行只读发现：

```powershell
node "<客户端脚本>" discover-session --provider dsh --invitation-id "<邀请 UUID>" --workspace "<项目绝对路径>"
```

发现仅匹配该工作目录中包含邀请标识的用户回合摘要；摘要缺失、截断或匹配多个会话时，提供真实 session ID 或生成新邀请。

## 连接与续接

```powershell
node "<客户端脚本>" connect --provider dsh --role brain --session-id "<当前真实会话 ID>" --workspace "<项目绝对路径>" --data "<服务目录>"
```

小脑改为 `--role reviewer`；执行员使用 `--role worker --worker-id "<编号>"`。Web 邀请须保留原命令的 `--join-invitation` 等参数。DSH 沿用会话模型，不传 `--model`，也不需要 Codex 的 turn ID。

连接通过 `session/list` 校验会话 ID 和工作目录。返回 `parked:true` 后结束回合；收到任务或提交后执行 `resume --credential "<本端凭据路径>" --data "<服务目录>"`。

适配器使用 `session/prompt` 的 `mode: queue`，可恢复已有空闲会话。`accepted:true` 只表示宿主受理，任务仍须通过 claim/submit 完成。发送结果不确定时保留 uncertain，通过回合摘要中的通知标识核对，不自动重发。

协议依据 DSH Desktop `0.2.1-rc.2` 的跨会话通信文档；它属于宿主内部 Remote API，宿主升级后需重新验证兼容性。
