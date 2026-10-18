# 任务尝试次数与分配

每个任务默认允许 30 次尝试，可在创建任务时填写 maxAttempts。一次新执行 attempt 或新审核 attempt 各计一次，共用任务额度；按唯一 attempt ID 从保留的 attempts 计算 execution、review、total。失败、返修、恢复和越界纠正产生的新 attempt 也计数。重复领取、提交去重、内部工具调用、规划、人员配置和交接等待不增加次数。额度耗尽不终止在途 attempt，仍可领取及提交。

项目 turns 保存累计尝试次数，status 同时提供 projectAttempts。保留累计值，不用现存回执重新覆盖历史统计。任务额度耗尽只阻止它的新 attempt；项目内仍串行，依赖、在途执行、uncertain 工作区锁及规划门禁保持原规则。

## 操作

大脑客户端（带原 brain --credential/--data）：

```text
task-budget --task T01 --add 10 --reason "补充回归验证"
assign --task T01 --worker-id strong --capability strong --reason "需要强模型修复"
assign --task T02 --worker-id strong --capability strong --update-plan --reason "下一任务也涉及恢复协议"
```

task-budget 追加正整数额度，要求原因并记事件，不重置计数、不自动重试 blocked。assign 默认只修改当前任务的 currentWorkerId 和当前能力要求；任务状态使用 currentWorkerId，不再提供 workerId 别名。plannedWorkerId/plannedRequiredCapability 保存计划；重复提交原任务计划不会因当前执行者升级而冲突。update-plan 只允许未开始的对应任务，由大脑明确记录原因。模型选择仍由计划和既有 worker 能力分配决定，不自动选择模型；升级不增加额度。大脑只规划、派发和审核，不实现业务代码。

管理端（带 --data <服务目录>）：

```text
node runtime/cli.cjs task-budget PROJECT TASK 10 --reason "补充验证"
node runtime/cli.cjs budget PROJECT 100
node runtime/cli.cjs budget PROJECT off
```

budget 的数字是可选项目累计上限，显式调用即启用；off 关闭保护，不清零累计。项目因保护暂停后，仍需显式 resume。新项目不设置 maxTurns 即不启用项目保护。菜单优先展示任务尝试次数及执行/审核拆分，追加操作面向单个任务。

## 初始化与数据校验

服务数据保持 version 2。项目创建时初始化累计次数和预算开关；任务创建及重置共用初始化逻辑，写入 maxAttempts、plannedWorkerId、currentWorkerId、plannedRequiredCapability 和当前能力要求。加载和保存不再补齐历史字段；结构不完整的旧数据会被拒绝，原文件不被改写。

## 部署安全边界

本次维护不直接修改真实 state.json，不接入业务项目身份。部署前用现有只读 status 核对真实服务根目录、进程、running/reviewing/uncertain、pending handovers 和 scopeRecovery。暂停后续派发，让旧端在原身份提交在途 attempt；有未结算或恢复不明状态时不强行切换、断绑或清锁。安全边界停止旧服务，备份整个服务数据目录，再加载新代码，核对 attempt、历史累计和分配、选择是否启用项目保护，最后显式继续。

开发测试使用工作区 tmp 中的独立数据目录，无真实模型调用。代码修改不会替已运行的服务自动完成升级；旧服务运行期间不复制安装文件或重启部署。若需回退，停止新版并使用部署前完整备份与匹配的旧代码，不让旧版写入含新增分配字段的新版状态。

## 批次审核预算补充（未发布）

默认逐项路径不变。显式启用的低风险批次把 brain 审核 attempt 保存在项目 reviewBatches 一次；成员的 batchReviewRefs 只引用该 ID。每项的 maxAttempts 消耗一次参与，项目 turns 和 token 来源记录只增加一次，不能把成员引用相加当作多个调用。

登记时检查 worker、reviewer 和共享审核的最低可用预算；准备共享审核前再次检查并先落盘占用。验证失败、取消未领取审核也保留已准备记录，不退回预算或伪造未发生。没有领取的记录不计入 claimed。预算不足阻塞整批，须显式追加后恢复；不会在结算时补扣或自动加额。
