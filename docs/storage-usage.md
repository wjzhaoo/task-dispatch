# 快照、磁盘清理与消耗统计

## 历史返工与大脑活动（未发布）

`usage` 和桌面 `status.usage` 保留原 groups，并增加 workflow、activityGroups、totals、observedUniqueTokens。管理台项目页与菜单 10 同步展示这些口径。

- workflow 从去重的事件 ID 和 attempt 身份统计累计 needs_fix、越界退回、明确的存储异常/恢复和未分类重试；不会读取可清零的 repairs 来代表历史返工。
- “初审通过后终审退回”只配对同一 taskId 和 artifactId，必须先有 reviewer pass。分母是实际匹配的候选数，同时列出任务数。缺失旧事件、重置后丢失的领取细节保持覆盖不完整。
- prepared、claimed、settled 分别是准备、领取、结算记录数，不是模型调用数。共享批次审核在项目层只记一次，在成员预算中各记一次参与。
- Codex 采集会随日志追加刷新已观测的运行中记录，也可在结算后补采最后窗口。完整平台 usage 优先于 observedUsage；不能把两者相加。
- 增量以来源会话和计量事件 ID 去重。相邻窗口边界也可能重叠：同时属于多个记录的事件列为 conflicting，无归属事件列为 unallocated，不任选一个活动归账。跨项目共用会话的事件也只在顶层 observedUniqueTokens 累计一次；各项目的来源事件不可再相加。
- 无计量字段为 null，未覆盖的首次沟通不能补造。观测总计只覆盖已记录窗口之间可查的来源事件，既不是完整账单，也不能换算订阅额度或费用节省。

规划领取与 closeout、异常领取与确认自动记录活动。首次规划或额外沟通可由当前 brain 用已绑定凭据显式记录：

```powershell
node runtime/desktop-client.cjs activity-start --activity first-plan --kind planning --source "首次方案设计" --credential BRAIN.json --data SERVICE
node runtime/desktop-client.cjs activity-end --activity first-plan --credential BRAIN.json --data SERVICE
```

kind 为 planning / troubleshooting / other。结束时可加 `--usage-file REAL-USAGE.json` 导入真实平台计量，格式沿用 usage（scope=attempt 或 attempt-window）；不接受模型估算。活动 ID 幂等，冲突计量拒绝。会话换绑保留原来源；未结束活动显示未结束，不把等待时长当推理时长。

共享批次沿用持久回执与有界恢复：回执落盘后状态写入失败，全局暂停派发/领取并重试同一回执。批次原候选在成员仍未完成时受已有引用保护；公共基线、复合候选和批次审核目录属于保守保留对象，当前自动清理不回收这些未知目录，避免误删审计证据。使用前应预留磁盘容量。

## 回执结算的存储故障恢复（2026-09-22）

原子文件替换在 rename 遇到 EPERM/EBUSY 时最多追加三次等待，分别为 20、60、120ms；其他错误不自动重试。始终先写完整临时文件并 fsync，再替换目标，落盘成功后才发布新的内存状态。不会先删除旧 state.json。失败但已完整写入的临时文件保留供诊断；不完整的本次临时文件尝试清理。

回执已保存而结算遇到存储错误时，服务保留同一 attempt 和候选，暂停服务内派发、任务领取与定时唤醒。下一次 tick 在至少 1 秒后尝试重新结算同一回执，每次服务运行最多三轮自动恢复；恢复仍重新验证回执身份、候选及范围，不新增模型 attempt。成功记录 settlement_recovered，含原因、错误码和恢复次数。

持续失败或非暂态错误保持暂停，桌面 status 的 storageRecovery 展示 attemptId、reason、retries、receiptPersisted、exhausted。暂停标志存在于服务内存，不依赖再次写入损坏或被占用的 state.json；存储不可用期间的完整错误仅能在当前进程状态读取。应先保存诊断、解决占用或磁盘问题，再在授权的安全边界重启服务。重启会从持久回执重新验证结算，自动恢复次数按新进程重新计算。

submit 在该状态返回 ok=false、receiptPersisted=true、settlementPending=true，不能把已存回执描述为任务通过。同一内容的重复提交复用原回执和候选，冲突内容拒绝覆盖；已结算的重复回执仍幂等。尚未持久化的回执不可推断为已提交，也不能重放猜测的结果。服务全局暂停属于保守恢复策略，不是跨项目并发写入优化。

2026-09-12 实现。菜单 10 提供消耗统计、清理预览、存储策略和项目快照设置。

菜单 10 → 5 或 `finish-project PROJECT_ID` 显式结束项目，只允许非空队列全部通过后操作。阻塞 wait 立即返回结束，新客户端正常退出并移除自己的等待锁；旧客户端收到终止重试的 HTTP 410 提示。claim/park 同样返回 completed。`reopen-project PROJECT_ID` 允许登记新工作，角色需重新接入等待。不会因为分批任务暂时全部通过就自动结束项目。

## 项目快照

快照是源码和必要资料的完整固定副本，不是 Git 提交。v2 策略默认排除 `.git`、`node_modules`、`.venv`、`__pycache__`、工作目录根部的所有点开头目录（IDE/代理缓存，如 `.workbuddy-ai`、`.zcode`、`.trae`、`.godot`），以及项目根目录 `tmp/`；不自动照搬 `.gitignore`。`.task-dispatch` 与 `.dispatch-evidence` 保持可见。只支持 v2 策略，每次新尝试冻结 `.taskignore`；存储快照必须包含冻结的 `taskIgnoreRules`、`monitoredHash` 和完整性摘要，缺少字段时明确拒绝加载。

目录职责固定如下：

| 位置 | 用途 | 是否进入业务快照 |
| --- | --- | --- |
| `<服务目录>/` | 状态、凭据描述、回执和审计 | 不属于项目 |
| `<服务目录>/tmp/` | 服务瞬时文件 | 不属于项目，可安全重建 |
| `<服务目录>/artifacts/`、`reviews/`、`validations/`、`task-resets/` | 可追溯候选、审核、验证和重置记录 | 由服务保留策略管理 |
| `<项目>/.task-dispatch/` | 计划、契约和任务记录 | 进入快照，属于权威资料 |
| `<项目>/tmp/` | 构建缓存、测试输出、诊断副本等临时文件 | version 2 起默认排除 |
| `<项目>/docs/worker-results/<任务ID>/` | 任务明确要求保留的执行证据 | 进入快照，须列入 allowedPaths |

任务交付路径不得放在 `tmp/`。服务在登记任务和修改快照策略时会检查 `allowedPaths` 与排除目录是否重叠，避免任务声称交付了实际未审核的文件。

```powershell
node runtime/cli.cjs configure-snapshot PROJECT_ID examples/novel2comic-snapshot.json
```

配置中的 `exclude` 采用精确相对文件名或结尾为 `/` 的目录前缀，不支持通配符。只为已经确认的缓存添加排除。每个新执行尝试固定当时的策略，修改前、提交后、审核前都用同一规则；快照清单记录策略及哈希。审核证据不能被排除。已进入审核的任务不能中途改规则。

项目根目录还可放置 UTF-8 编码的 `.taskignore`，按行列出快照排除规则。空行和 `#` 注释会跳过；支持 `*`、`?`、`**`、结尾 `/` 的目录规则、开头 `/` 的根路径规则，以及 `!` 反选。没有内部 `/` 的名称会匹配任意层级；反选被排除目录内的文件前，须先反选该目录。路径统一用 `/`。例如：

```gitignore
# Generated binaries
bin/
*.dll
!required.dll
```

`.taskignore` 本身进入快照；每次执行尝试和批次会固定当时的规则，修改规则文件会被当成工作区变化。`.task-dispatch/`、`.dispatch-evidence/` 不能通过 `.taskignore` 隐藏。服务会拒绝直接指向被忽略文件的任务交付路径；授权整个目录时，目录内被忽略的文件仍不参与备份、diff 与审核，请只忽略确定无需交付的产物。既有 `snapshot.exclude` 仍生效，旧快照按其保存的范围复现。

`maxTotalBytes` 默认 256 MiB，`maxFileBytes` 默认 32 MiB。大型源码项目可以提高这两个限制；超限报错包含具体路径、文件字节数、累计量和限制，不会静默丢文件。生成的审核证据可能复制修改前内容，因此不再套用项目源码大小限制，仍受服务容量检查约束。

排除意味着该路径不参与完整性和越界检查，也不会出现在审核副本。不要排除本次验收需要的测试数据。当前仍保存完整副本，尚未实现内容去重或增量存储。

## 清理与容量

```powershell
node runtime/cli.cjs configure-storage examples/storage-policy.json
node runtime/cli.cjs cleanup-preview
node runtime/cli.cjs cleanup-apply PREVIEW_ID
```

新服务默认不自动删除旧资料；明确配置 `automatic:true` 后，每分钟在本地检查一次。策略：

- 正在运行或状态不确定的项目不清理。未通过、返修、阻塞任务及共享引用一直保护。
- 已通过且验证进程退出的任务，可以删除 `validations/尝试ID/tree`，保留外层 `report.json` 和审核证据里的报告。
- 过期的已通过任务可清理快照和审核树，至少保留每项目最近 `keepLatestAccepted` 个已通过任务的完整快照。默认期限 7 天、最近 2 个任务。
- 回执、审核结论、使用量记录和清理事件保留。未被任务引用的未知目录不自动删除，容量上限仍会阻止无限继续派发。
- 预览带状态及文件大小指纹；状态变化后需重新预览。删除只限服务目录指定子树，拒绝路径逃逸和符号链接／目录联接，不删除业务项目。

`maxBytes` 默认 10 GiB，统计 artifacts/reviews/validations 三类副本。派发前定期检查，源码、审核副本和验证依赖复制前再次估算，预留并发验证复制空间，检查可用磁盘空间。超限保留恢复材料，停止新派发；清理或提高限制后恢复。

这不是操作系统磁盘配额：测试程序运行时仍可能写入超过估算的输出，元数据、回执和外部项目不包括在上述副本预算内。应给系统盘留余量。不要在审核中手工删除候选或验证目录。

## 使用量

```powershell
node runtime/cli.cjs collect-usage
node runtime/cli.cjs usage
node runtime/cli.cjs usage PROJECT_ID
node runtime/cli.cjs record-usage examples/attempt-usage.json
```

Codex 桌面会话自动读取本机 `$CODEX_HOME/sessions`（未设置时为用户 `.codex/sessions`）中与绑定会话一致的唯一日志，每五分钟刷新，不调用模型。按任务领取／开始至提交回执的时间窗口统计 `token_count.total_token_usage` 的相邻差值，重复事件不重复累计。累计计数下降时不猜测增量。记录实际模型和来源；混用模型标为 mixed。

统计不可用时不再只显示空值或把未知当成零。每个尝试会保留明确状态与原因，包括尚未采集、会话 ID 无效、日志目录不存在、未找到唯一日志、同名日志歧义、日志没有可用 token 增量、尝试时间窗内没有计量事件，以及平台未随回执上报且没有自动采集来源。管理台任务详情和 CLI 汇总都会显示该原因；后续采集到真实计量后再替换为完整计量或时间窗口计量。

自动统计标为 `attempt-window`，不覆盖提交后的聊天，历史任务缺少领取时间时使用派发时间，可能包含派发至领取间的活动；跨窗口的单次调用只能按计量事件时间归属。这是观测量，不是精确账单。没有日志、日志不唯一、平台不报告计量、没有可靠计数基线时保持未知。

平台提供完整尝试计量时，可由管理员导入 `record-usage`，或由桌面客户端 `submit --usage-file` 附带真实平台数据。格式见示例；必须注明 provider/model/source 和 scope。不要让模型估算自己的 token，不把会话终身累计量冒充单任务用量。相同记录幂等，冲突记录拒绝覆盖。

报告按项目、角色、平台、模型分组，区分完整计量、时间窗口计量和未知尝试。缓存输入包含在输入中，推理输出包含在输出中，不能重复相加。brain/worker 是角色，不保证实际使用强弱模型。MiMo 接入文档尚未规定 token 返回格式，故当前 MiMo 不自动解析其用量，支持规范化真实计量导入。没有同等任务的单模型对照记录，不计算强模型节省百分比，也不将 token 映射为订阅额度百分比。

## 审核已有实现

已有实现也必须登记为阶段任务，由执行员按真实基线核对或修复并提交候选，再逐项初审和阶段终审。不能直接导入候选进入大脑终审，也不伪造修改前副本或执行记录。操作见 [阶段计划与终审](../skills/task-dispatch/references/stages.md)。

## 验证方案与进度

`configure-validation PROJECT_ID FILE.json --profile NAME` 登记命名方案；任务可指定 `validationProfile`。省略则沿用项目默认。`{"mode":"static","reason":"仅修改文档"}` 必须用命名方案，且只允许 md/txt/rst 差异；不复制依赖、不运行测试，不伪造测试通过。

桌面客户端 `progress --file FILE.json` 接收 taskId、attemptId、递增 sequence、stage、summary。stage 为 reading/implementing/testing/preparing-report/blocked。只在实际阶段变化时上报，不启动模型心跳，不据沉默自动重派。

任务预算和执行/审核次数详见 [任务尝试次数与分配](attempt-budgets.md)。
