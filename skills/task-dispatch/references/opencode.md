# OpenCode 原会话接入

支持 OpenCode Desktop 2.x 的 brain、reviewer 和 worker。需要 Node.js 22.13+、宿主提供的真实 `ses_...` 会话 ID、未归档的原会话、可读取的 SQLite 数据库和官方 CLI。

安装技能：

```sh
node scripts/install.js opencode
```

安装到用户目录的 `.config/opencode/skills/task-dispatch`，生成 `runtime-link.json` 指向本仓库客户端。`all` 包含 OpenCode；安装器不启动服务。技能路径与 YAML 要求见 [OpenCode 2.x 官方技能说明](https://opencode.ai/v2/docs/skills)。在 OpenCode 中可用 `@task-dispatch` 加载技能。

由接收端确认真实平台后，在原会话工作目录执行（客户端使用实际绝对路径）：

```sh
node "<客户端绝对路径>/runtime/desktop-client.cjs" connect --provider opencode --role brain --session-id <当前真实ses_会话ID>
```

reviewer 使用 `--role reviewer`；worker 使用 `--role worker --worker-id <邀请指定编号>`，能力参数沿用邀请。改绑使用管理台生成的 OpenCode 提示词；`--invitation-id` 表示授权，不能替代会话 ID。不从标题、目录、旧数据库表或其他平台的环境变量推断当前会话。

连接成功后按回执处理 job 或展示接入邀请。brain 等用户开始指令再执行 `start-work --confirmed`。空闲及提交后实际执行 `resume --credential "<本端凭据路径>"`；`parked:true` 时结束当前回合，服务有任务时唤醒原会话。会话核验失败时报告 attention，补齐条件后重试 resume。

| 配置 | 用途 |
| --- | --- |
| `TASK_DISPATCH_OPENCODE_DB` | SQLite 数据库；默认 `~/.local/share/opencode/opencode.db`，设置 `XDG_DATA_HOME` 时使用该数据目录 |
| `TASK_DISPATCH_OPENCODE_CLI` | 官方 CLI 可执行文件；默认按数字版本从 `%APPDATA%/ai.opencode.desktop/cli/2.x.x/` 查找，再检查 PATH |
| `TASK_DISPATCH_OPENCODE_AUTO` | 仅显式设为 `1` 才增加 `--auto`；默认保留原会话权限 |

自定义配置须在启动 task-dispatch 服务前设置；已运行的服务需重启以加载新版代码和环境变量。默认发送 `run --session <真实ID> --format json`，沿用原会话模型；仅显式传入 `--model provider/model` 时覆盖模型。使用无 shell 的进程启动。CLI 命令形式见 [OpenCode 官方 CLI 说明](https://opencode.ai/v2/docs/cli/commands/)。

适配器只读查询指定 ID 的 `session_v2` 和 `session_message`，结合最后一条事件及 `session_inbox/session_pending` 判定状态。旧 `time_idle` 不能证明当前回合空闲。归档、缺失、目录不符或未知队列结构均不会发送。

发送后必须在该会话用户消息中读到本次通知的唯一标记才登记送达。CLI 退出码或助手复述不能证明送达；未确认的发送进入 uncertain，由服务回读核对，避免重复发送。消息送达与任务完成分别记录，任务仍须实际 `claim` 和 `submit`。

离线测试覆盖数据库核验、状态判断、发送确认和客户端接入；真实宿主的权限交互及长期待命仍需联调。
