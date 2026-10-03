# 1.0.0 本地协作服务：运行与恢复

本版只使用阶段集中终审。大脑制定完整功能阶段计划，小脑逐项初审；全部初审通过后，大脑审核整个阶段。终审发现问题时追加关联修复任务，重复执行、初审和整体验收，直到阶段通过。完整 JSON 和命令见[阶段计划与终审](../skills/task-dispatch/references/stages.md)。

## 升级与数据目录

服务状态格式为 version 2，明确拒绝旧版队列。升级使用新的服务数据目录和重新接入的角色，不迁移旧工作流、不删除原数据。修改源码不会改变已经运行的服务；实际安装、停止和启动服务按用户授权执行。

新项目默认使用工作区内受保护的 `.task-dispatch/runtime/<项目路径摘要>/`。自定义 `--data` 目录必须位于业务工作区之外。状态、凭据、快照、收据和审核副本均保存在服务目录；系统缓存中的项目目录表只记录路径映射。`runtime/migrate-data.cjs` 仅用于同版本服务的目录搬迁，不能转换旧队列。

项目内 `docs/plans/`、`docs/reviews/` 和 `.task-dispatch/plan.md` 属于大脑控制面。worker 的业务修改受 allowedPaths 约束；需要提交执行证据时，只能写明确授权的 `docs/worker-results/<任务ID>/`。根目录 `tmp/` 用于临时输出，不能作为交付路径。

## 接入与启动

`start.bat` 是桌面客户端入口；`dashboard.bat` 打开统一 Web 控制台。Skill 安装器生成 `runtime-link.json` 指向本仓库客户端，不复制或启动服务。仓库移动后需重新安装更新链接。

各角色通过 `runtime/desktop-client.cjs connect --provider <真实平台>` 接入。brain/reviewer 使用 Codex、MiMo 或 Qoder；worker 可使用其他支持的平台。角色必须明确自身平台，遵守真实会话身份要求，不复用其他角色凭据。接入细节见[连接发现](../skills/task-dispatch/references/connection.md)、[桌面会话](../skills/task-dispatch/references/desktop.md)和[多执行员](../skills/task-dispatch/references/workers.md)。

连接阶段由大脑登记 staffing、展示邀请并核对角色就绪，不派发任务。计划中的 worker 和必需的 reviewer 就绪，且用户已给出开始指令后，大脑调用：

```powershell
node runtime/desktop-client.cjs start-work --confirmed --credential BRAIN.json --data DATA
```

唤醒端先 park；等待型 worker 实际执行 wait 保持接入。小脑必须在线，不支持 without-reviewer，也不会在离线时降级为逐项大脑审核。start-work 成功后的已授权执行、初审、终审和补修无需逐单要求人工确认。

## 固定阶段计划

大脑按依赖顺序用 `plan --file` 登记任务草案，随后 `stage-register --file` 提交完整阶段清单。服务仅派发当前登记轮次内的任务。项目内串行执行，多个项目可独立推进；没有匹配 worker 的任务等待接入。

阶段内依赖由小脑初审通过释放，同文件可按依赖顺序修改。初审通过的任务保持 review_ready 和 stageHeld，不提前 accepted。跨阶段依赖必须已经终结。小脑只审核原契约，可要求原任务返修，无权修改计划或降低验收标准。

全部初审通过后，服务核对执行快照与修改来源，生成当前整合候选，重新运行配置的验证。大脑领取 stage_review，阅读 `.dispatch-evidence/stage.json` 中的累计任务、原始目标、历史问题、修复关联和验证报告。整体与全部成员通过且配置检查未失败，stage-submit 才能将累计任务验收。

终审未通过时保留原任务和证据。大脑登记新的修复任务，以相同 stageId、目标和验收条件、新 roundId 提交下一轮；repairKeys 必须覆盖上一轮全部问题。下一次终审仍覆盖整个阶段，不能只审补丁。阶段通过后才可开始下一功能阶段；所有已登记任务终结后，由大脑显式 finish-project。

## 异常、契约与恢复

blocked、uncertain、越界、额度不足或审核端离线会通知大脑。优先处理 task_attention 或 scope_attention 的具体问题，再恢复阶段。attention-ack 和 scope-ack 只确认通知，不让任务通过。

- 原契约内的普通阻塞可 retry、改派执行员或追加尝试额度；uncertain 必须核实旧执行及后台进程已停止后恢复，服务不自动回滚业务文件。
- 小脑初审的 needs_fix 在原任务内返修；自动返修保护耗尽后交给大脑。手动重试不清零累计尝试次数。
- 大脑只可在项目暂停、阶段空闲时 revise-task 修订尚未执行的 ready 成员；旧契约和修订原因保留。已执行契约不可改写，configure-repair、reconcile-review 或替代任务不能绕过阶段冻结。
- 已执行任务确需变更契约时，由大脑明确处理方案；若必须重建计划，核实执行已停止后，通过管理台整体重置阶段并重新登记计划。重置包含原任务、修复任务及受影响的下游阶段，保留审计并使旧回执失效。正常终审补修不使用重置。
- reviewer 临时无心跳不会撤销已领取审核。确认原端终止后显式 detach 或安全交接，恢复在线 reviewer，再用 stage-resume 继续。
- 准备终审时中断，先确认验证子进程停止，再 `stage-resume --round ROUND --confirmed-stopped`。已领取的终审保留所有权，通过原端或正式交接继续。

恢复机制优先重放已经落盘的同一回执，不重新执行模型任务；缺少可靠回执的在途执行保持 uncertain。状态损坏或版本不匹配直接报错，不清空重建。持久化失败不会冒充业务通过。阶段原任务与历轮补修的快照证据在最终通过前受到清理保护。

pause 只停止后续派发，不会终止外部会话。停止服务也不等于宿主任务已结束。确认服务退出后才处理遗留锁，不能绕过仍存活的进程。

## 唤醒、管理与统计

唤醒端通过 claim、submit 或 stage-submit、park 往复；park 返回 job 时立即继续，返回 parked:true 时结束当前回合等待通知。无唤醒端使用 wait；空队列不是项目完成。详细协议和平台差异见[桌面接入](../skills/task-dispatch/references/desktop.md)。

服务记录发送状态和目标会话身份；发送结果不确定时不能盲目重发，已领取尝试也不能换端重复执行。自动唤醒、交接和确认停止的恢复保留原有所有权检查。管理台展示阶段、轮次、待解决问题、各成员初审状态与最终结论。

共享阶段终审在项目中计一次尝试，每个参与任务计一次终审参与；补修轮重新审核原任务也计入其额度。预算不足时由大脑显式追加，不清零历史。用量统计保留来源与覆盖情况，不把缺失用量当作零，也不承诺固定节省比例。

更多说明：[Web 控制台](admin-console.md)、[快照与存储清理](storage-usage.md)、[独立验证环境](review-validation.md)。协议角色隔离不能代替操作系统文件权限；worker 修改工作区后才进行范围校验，审核在候选副本中只读进行。

## 开发验证

```powershell
npm test
npm run verify:skill
```

测试使用本地夹具，不调用真实模型。安装验证指定临时用户目录，不安装到真实宿主。Windows 同时运行大量测试出现磁盘争用时，可用 `node --test --test-concurrency=4 tests/*.test.cjs` 执行相同的完整测试集。
