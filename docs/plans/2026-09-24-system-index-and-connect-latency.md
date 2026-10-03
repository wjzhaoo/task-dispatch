# 计划：系统索引归位与各端连接提速

## 背景与目标

系统目录保留在用户主目录 `~/.task-dispatch-service`，只存控制台与项目索引；每个项目在该目录有独立元数据子目录。服务状态、凭据、快照和 diff 副本仍在该项目工作目录的 `.task-dispatch/runtime/<项目键>/`。连接时减少重复的宿主校验。

## 当前代码锚点

| 位置 | 现状 |
|---|---|
| `runtime/core/service-registry.cjs` | 系统索引默认写入 `AppData/Local/task-dispatch/service-registry.json`；项目缓存已使用工作目录 |
| `runtime/catalog-console.cjs` | 控制台运行记录写入 `AppData/Local/task-dispatch/console.json` |
| `runtime/core/continuation.cjs` 与 `runtime/core/wake.cjs` | 连接时先读取宿主会话，然后绑定时再次读取 |
| `runtime/adapters/mimo-wake.cjs` | 一次完整读取包含最长 800 ms 的事件状态等待 |

构建目录与验证方式见 `PROJECT.md`。

## 方案与决策

用户已指定用户目录保留系统总目录、缓存分散在项目工作目录；此前明确要求直接修改代码。本次采用：总目录下的注册表、控制台状态和 `projects/<项目键>/project.json` 均为轻量元数据；旧 AppData 索引只读导入；宿主会话核实结果在同一次连接中复用。备选方案是继续将元数据放在 AppData，或把快照集中到用户目录；前者不符合目录偏好，后者重新占用系统盘。连接备选方案是跳过宿主核实，存在错误绑定风险，不采用。

## 任务

### T1 系统索引

- 文件：`runtime/core/service-registry.cjs`、`runtime/catalog-console.cjs` 及相关测试。
- 改动：将新元数据写入用户总目录，首次写入时兼容旧 AppData 索引，创建项目元数据子目录；项目缓存路径保持工作目录内。
- 验收：迁移后目录清单不丢项目，系统总目录无快照树。
- 结果：新注册表和 `projects/<项目键>/project.json` 已写入用户目录；旧 AppData 两个项目和服务记录完整导入；控制台记录也写入用户目录。
- 状态：[x]

### T2 连接路径

- 文件：`runtime/core/continuation.cjs`、`runtime/core/wake.cjs`、`runtime/adapters/mimo-wake.cjs` 及相关测试。
- 改动：一次连接只核实一次宿主会话；MiMo 连接身份核实不等待活动事件，监控读取维持原行为。
- 验收：身份和目录错误仍拒绝，宿主读取次数下降，现有连接测试通过。
- 结果：唤醒型连接时宿主核实只调用一次；MiMo 核实不再等待事件流；直接 `wake-bind` 仍独立核实。最近 `zcode` 试跑为等待型端，实际延迟来自绑定后等待开工和任务登记，不受此优化影响。
- 状态：[x]

### T3 验证与现有数据切换

- 运行相关测试及 `npm test`；核对实际目录结构及服务状态。
- 结果：261/261 测试通过；现有项目服务与控制台重启后在线，两个项目子目录已创建，项目服务无在途任务。旧 AppData 元数据删除被自动审批策略拒绝，保留两个已导入的小文件。
- 状态：[x]

## 约束

不读取历史对话和旧任务总结；所有代码新增处用英文 `[AI-added]` 加精确到分钟的日期。文档写 UTF-8 无 BOM。临时文件位于仓库 `tmp/`。

## 生成/修改记录

| 时间 | 模型 | 操作 | 摘要 |
|---|---|---|---|
| 2026-09-24 13:23 | GPT-6 | 创建 | 记录已获授权的目录和提速方案 |
| 2026-09-24 13:36 | GPT-6 | 更新 | 记录实施、回归和旧元数据清理限制 |
| 2026-09-24 13:44 | GPT-6 | 更新 | 更正最近试跑的连接耗时归因 |
