# 运行服务健康排查（2026-09-15）

> 历史排查记录：以下版本、目录、缺陷和命令仅反映 2026-09-15 的现场。现行接入统一使用 connect/resume，存储和审核规则以 [运行文档](runtime.md) 为准。

本文记录对本地服务 `C:\Users\Administrator\.task-dispatch-service` 的一次只读排查结果，包含已确认缺陷、实测数据、运维风险和修复顺序。所有数据均由只读方式取得，排查过程未修改任何代码、配置或 `state.json`。

数据目录：`C:\Users\Administrator\.task-dispatch-service`
代码仓库：`D:\wjz\ai\plugins\task-dispatch`（version 0.4.3）

## 1. 结论摘要

| 编号 | 问题 | 级别 | 当前状态 |
| --- | --- | --- | --- |
| A | 越界纠正升级后 `return-scope` / `resume` 永久失效（错误文案被当作状态判据） | P1 缺陷 | 未修复 |
| B | 运行中的服务加载的是当日 07:51 的旧代码，17 个 runtime 文件未生效 | P1 运维 | 未重启（受在途 attempt 阻塞） |
| C | 快照重复副本占 28%，小文件簇浪费 0.56 GiB，`tmp/` 被完整快照 | P2 存储 | 未处理 |
| D | `budget` 命令把"改数字"与"启用保护"焊死 | P2 设计 | 未修复 |
| E | `recover()` 跳过 desktop 在途 attempt，且无管理员逃生口 | P2 设计 | 未修复 |
| F | `scopeAlert` 不随任务接受清理 | P3 观测 | 未修复 |
| G | 管理员 `/status` 与角色 `status` 任务字段不一致 | P3 观测 | 未修复 |
| H | 遗留 `.wait.lock` 无清理命令 | P3 运维 | 未修复 |
| I | 版本元数据不一致 | — | 排查期间已由他处修复 |

## 2. P1-A：越界纠正升级后恢复入口失效

### 现象

任务第三次越界返回后，任务进入 `blocked`，`error` 为「越界纠正已连续失败两轮，需要大脑处理；不要继续重试。」。此时：

- `return-scope PROJECT_ID TASK_ID` 报 `Expected legacy scope rejection`
- 内部 `scope-recovery.resume()` 同样拒绝
- 管理员 `retry` / `reconcile-review` / `configure-repair` 是仅存的可用入口

### 根因

`runtime/core/scope-recovery.cjs` 的 `queue()`（L31）先写入 `Out-of-scope changes: ...`，随后在纠错超限时调用 `alert()`：

```js
// scope-recovery.cjs L31
if(count>2||result.status==='blocked')alert(d,p,t,count>2?'越界纠正已连续失败两轮，需要大脑处理；不要继续重试。':result.summary);

// alert() 内（L16-18）覆盖了 error
q.state='blocked';q.error=message;...
```

而两个恢复入口都以**错误字符串前缀**为判据：

```js
// scope-recovery.cjs L61（resume）
if(!t||t.state!=='blocked'||!t.error?.startsWith('Out-of-scope changes:')||...)

// scope-recovery.cjs L84（request，即 return-scope）
if(!t||t.state!=='blocked'||!t.error?.startsWith('Out-of-scope changes:')||t.scopeRecovery)throw Error('Expected legacy scope rejection');
```

`alert()` 的文案不以该前缀开头，于是**恰好在她最需要的场景（反复失败升级）下，越界恢复命令失效**。实测确认：第三次越界返回后 `resume() eligible: false`。

### 附带的权限死结

升级告警会唤醒 brain（`scopeAlert` + `armed`），但 brain 的动作表无法处理它：

- `scope-ack` 只确认收到，不解锁（`scope-recovery.cjs` `acknowledge`）
- `assign` 被拦截：`runtime/core/desktop.cjs` L84 `if(t?.scopeRecovery)throw Error('Scope correction must return to original worker')`
- brain 的 `/desktop` 动作表（`runtime/server.cjs` L46-58）不含 `retry` / `reconcile-review`

即：告警发给了无力处理的角色，最终仍需管理员介入。升级到人本身合理，但**同时堵死操作命令**不是预期设计。

### 建议修法

二选一，改动均很小：

1. 让 `alert()` 不覆盖 `error`，告警文案只写入 `scopeAlert.message`（该字段已存在且 `status` 已返回）。
2. 将两处 guard 改为判 `t.scopeRecovery`，不依赖错误文案。

倾向方案 2：**用展示文案充当状态机判据本身不稳健**，任何文案措辞调整都会改变控制流。

需补回归：第三次越界返回后确认 `return-scope` 仍可用。

## 3. P1-B：运行中的服务加载旧代码

### 证据

| 检查项 | 结果 |
| --- | --- |
| 服务进程 PID 26756 启动时间 | 2026-09-14 07:51:47 |
| `endpoint.json` mtime | 2026-09-14 07:51:48 |
| 07:52 之后被修改的 runtime 文件 | **17 个** |
| 运行中服务 `GET /status` 的 `runtimeVersion` | `0.3.0` |
| 源码 `server.cjs` L91 应为 | `require('../package.json').version`（0.4.3） |

`'0.3.0'` 字面量在当前源码中**只存在于 L88 的 `/* Previous implementation: */` 注释块内**，而服务返回的正是该值，证明进程仍持有旧模块。Node 的 `require()` 模块缓存不会热加载。

受影响的 17 个文件（07:52 之后修改）：

```
runtime/adapters/agents.cjs          runtime/core/planning.cjs
runtime/adapters/codearts-wake.cjs   runtime/core/pre-review.cjs
runtime/adapters/mimo-wake.cjs       runtime/core/scope-recovery.cjs
runtime/cli.cjs                      runtime/core/snapshot.cjs
runtime/core/attempts.cjs            runtime/core/wake.cjs
runtime/core/bindings.cjs            runtime/desktop-client.cjs
runtime/core/contracts.cjs           runtime/server.cjs
runtime/core/desktop.cjs             runtime/wizard.cjs
runtime/core/dispatcher.cjs
```

旁证：`snapshot.cjs` L10 在 19:48 把 `.codeartsdoer` 加入 `EXCLUDED`，但 23:40 生成的快照 `7765263b` 中**仍含 `.codeartsdoer`**。用当前源码重算 manifest 时该目录已被排除，可确认差异来自模块缓存而非逻辑。

`README.md` 已明确该规则：「修改运行时代码后需重启服务才生效」。**因此 2026-09-14 下午至深夜的全部代码改动均未生效。**

### 重启前置条件（重要）

**不可在存在 desktop 在途 attempt 时重启。** 见第 6 节 P2-E：`recover()` 会主动跳过错失回执的 desktop attempt，导致项目被串行门禁永久锁死且无合法解。

排查时现场有两个在途项，重启须等其结算：

- `desktop-b8b46b182b3726e1` / `D05-5-redo-scene` / `running`（attempt `0288d20e`，已 claim 未提交）
- `desktop-90d5c8cda1993096` / `raincourt-A2` / `reviewing`

重启前应重新确认无 `running` / `reviewing` / `uncertain`。

## 4. P2-C：存储占用与浪费

### 总量（实测，2026-09-15 00:0x）

| 目录 | 大小 | 条目 |
| --- | --- | --- |
| artifacts | 1.55 GiB | 119 份 |
| reviews | 0.52 GiB | 50 份 |
| validations | 0.27 GiB | 13 份 |
| **合计（逻辑）** | **2.34 GiB** | |
| `du` 报磁盘占用 | **2.9 GiB** | |
| `state.json` | 13.5 MiB | revision 1418 |

当前策略：`retainDays 7`、`keepLatestAccepted 2`、`maxBytes 10 GiB`（`automatic: true`）。

### 浪费一：快照重复副本 28%

按 `manifest.json` 内容哈希分组：

- 119 份副本，**仅 79 种不同内容**
- **40 份为完全冗余重复**
- 去重后 1.55 GiB → 1.11 GiB，**可省 0.43 GiB（28%）**

原因：同一工作区状态被反复快照（每次 attempt 的 `baselineId`、审核用的 `reviewBaselineId`、被拒候选的 `scopeRejectedArtifactId` 各自完整存一份）。`docs/storage-usage.md` 已声明「尚未实现内容去重或增量存储」。

### 浪费二：小文件簇开销 0.56 GiB

- 总文件数 **211,074**，其中 **145,502（69%）小于 4 KiB**
- 每个小文件至少占用一个 4 KiB 簇 → 逻辑 2.34 GiB 对应磁盘 2.9 GiB

**小文件海比大文件更吃盘**，而这类文件大量来自被误纳入快照的缓存目录（见下）。

### 浪费三：构建/日志目录被完整快照

| 项目 | `snapshotPolicy` | 被快照的垃圾目录 |
| --- | --- | --- |
| `desktop-e435bdfd1004fe43`（RedBluePrint） | **无（`"none"`）** | `tmp/` **76,293 文件 / 289.5 MiB**（其中 `tmp/node-compile-cache` 16,901 文件 / 56.1 MiB）、`logs/` 31 文件 |
| `desktop-90d5c8cda1993096`（codex_roge1） | 排除 `.godot/`、`assets/gen/src/` | `tmp/` 133 文件 / 9.1 MiB |
| `desktop-b8b46b182b3726e1`（novel2comic） | 排除 `.pytest_cache/`、`data/`、`frontend/dist/`、`tmp/` | 无 |

RedBluePrint 的 `.gitignore` 含 `tmp/`，但**快照不读取 `.gitignore`**（`storage-usage.md` 明确该设计）。其默认排除仅 `.git`、`node_modules`、`.venv`、`__pycache__`（`snapshot.cjs` L10）。

另有 `.codeartsdoer` 出现在 **115 份快照**中、共 1,446 文件 / 23.0 MiB；该目录已于 19:48 加入排除表，**重启后开始生效**。

按项目归因（artifacts 占用 / 文件数）：

| 项目 | 占用 | 文件数 |
| --- | --- | --- |
| codex_roge1 | 837 MiB | 9,951 |
| novel2comic | 390 MiB | 42,142 |
| RedBluePrint | 355 MiB | 81,678 |

codex_roge1 单份最大快照 220 MiB / 2,505 文件，内容为美术二进制资产（`.glb`、`.blend`、`.blend1`）。其策略未排除 `assets/review/`、`art_sources/`。

### 浪费四：`state.json` 中 `delivery` 占 8.2 MB

`state.json` 13.5 MiB 中以 `attempt.delivery` 为主：

| 字段 | 大小 |
| --- | --- |
| `attempt.delivery`（108 个 attempt 全带） | ~8.2 MB |
| ├─ `reviewManifest` | **7.56 MiB**（每次 brain 审核存 522~529 个文件的完整清单） |
| └─ `prompt` | 0.61 MiB |

`Store.change()`（`storage.cjs` L61-68）每次状态变更都 `structuredClone` 整棵树 + 全量 JSON 重写 + `fsync`，revision 1418 即 1418 次全量重写。

`GET /status` 响应体 **9.0 MiB**（返回完整 `state`，含全部 delivery）。管理员 `/status` 与角色 `status` 都受影响。

`maintenance.cjs` L85 已有 `delete r.delivery` 的先例，但仅针对已通过任务且只在清理时执行。

### 可选措施（按性价比）

1. **仅改配置（零代码）**：给 RedBluePrint 补 `snapshotPolicy` 排除 `tmp/`、`logs/`；给 codex_roge1 排除 `assets/review/`、`art_sources/`；调整 `retainDays` 或 `maxBytes`。
2. **重启服务**：让 `.codeartsdoer` 排除生效（回收 23 MiB 且此后不再增长）。
3. 内容去重（按 manifest 哈希硬链接或引用计数）：省 0.43 GiB，需处理引用计数归零。
4. `state.json` 瘦身：`reviewManifest` 审毕即删，或只存 `{path: hash}`。

注：`cleanup-preview` 当前报 `reclaimableBytes: 0`，因最老的已接受任务仅 2.3 天、未达 `retainDays 7`。这是「尚未到期」而非「无物可清」，容量将在第 7 天开始首次下降。按当前增速，7 天窗口内稳态约 5～8 GiB，逼近 10 GiB 上限。

## 5. P2-D：`budget` 命令耦合

`runtime/core/dispatcher.cjs` L70-72：

```js
budget(projectId, maxTurns) {
  if (maxTurns !== null) attempts.limit(maxTurns);
  this.store.change(s => { ...; p.maxTurns = maxTurns; p.projectBudgetEnabled = maxTurns !== null; ... });
}
```

`projectBudgetEnabled` 完全由 `maxTurns` 是否非空决定，**无独立开关**。后果：

- 对 `turns 63 / maxTurns 60` 但 `projectBudgetEnabled: false` 的项目，**无法只调大数字**——一旦调用 `budget` 即启用历史项目保护，直接暂停
- 这是「回合数不够」误判的直接来源：worker 看到 `63/60` 报预算耗尽，而该保护实际未生效（`attempts.cjs` L14 `projectExhausted` 要求 `projectBudgetEnabled === true`）

`desktop.status` 已返回 `projectBudgetEnabled` 与 `budgetExhausted`（`desktop.cjs` L162）可供自证，但把 `maxTurns` 与 `projectAttempts` 并排输出且不标记是否生效，容易诱导误读。`wizard.cjs` L147 的打印（`项目累计次数 63 / 未启用项目保护`）表达更清楚，可作参考。

建议：增加独立开关，或在未启用时不回显 `maxTurns`。

## 6. P2-E：`recover()` 跳过 desktop 在途 attempt

`runtime/core/dispatcher.cjs` L169-176：

```js
recover() {
  for (const p of Object.values(this.store.state.projects)) for (const t of Object.values(p.tasks)) {
    if (!['running', 'reviewing'].includes(t.state)) continue;
    const run = t.attempts.at(-1), receiptPath = this.receiptPath(run.id);
    if (fs.existsSync(receiptPath)) this.settle(p.id, t.id, run.id, read(receiptPath));
    else if (p.mode === 'desktop' && run.delivery) continue;   // ← 主动跳过
    else this.block(p.id, t.id, run.id, 'uncertain', '...');
  }
}
```

desktop 模式下带 `delivery` 的在途 attempt 在重启后被**主动跳过**，状态原样停在 `running`。而全部管理员命令均要求 `blocked`：

- `retry`（`dispatcher.cjs` L157-160）
- `reconcile-review`（L126）
- `configure-repair`（L148）

叠加串行门禁（`dispatcher.cjs` L255：项目内存在 `running`/`reviewing` 即跳过），**一旦原 worker 会话丢失，该项目会被锁死且无合法解**，只能手改 `state.json`。`docs/runtime.md` 的恢复表「执行记录存在，缺少回执 → 标记 uncertain」描述的是非 desktop 路径。

排查期间曾出现一个悬空 attempt 长达约 13 小时（`7bf6bb43`），该窗口最终自行恢复才未触发。

建议：增加管理员级命令（如 `abandon-attempt --confirmed-stopped`），将无回执的 `running` attempt 显式结算为 blocked/uncertain。这是上述场景唯一缺少的逃生口。

## 7. P3：观测与运维小项

### F. `scopeAlert` 不随接受清理

`settle()` 的接受路径不清理 `scopeAlert`；仅 `reconcileReview`（L139）会置 `acknowledged = true`。实测一个已 `accepted` 的 `error: null` 任务仍挂着「不要继续重试」的 `scopeAlert`。功能上无害（`job()` 判 `!acknowledged`），但读起来像未解决。

### G. 两种 `status` 的任务字段不一致

| 来源 | `attemptCounts` | `budgetExhausted` |
| --- | --- | --- |
| 角色 `status`（`desktop.cjs` L162） | 有 | 有 |
| 管理员 `/status`（`server.cjs` L91，直出 `state`） | **无** | **无** |

`wizard.cjs` 因此需自行 `attempts.counts(t)` 现算。同一对象两套形状，易出错。

### H. 遗留 `.wait.lock` 无清理命令

`runtime/core/storage.cjs` 的 `Store.unlock` 仅处理 `service.lock`；`.wait.lock` 只能按文档手工删除（`skills/task-dispatch/references/desktop.md`）。实测存在 3 个 PID 已死的遗留锁：

```
90d5c8cda1993096-worker-architecture.json.wait.lock   pid 39784  已死
90d5c8cda1993096-worker-foliage.json.wait.lock         pid 29832  已死
e435bdfd1004fe43-worker.json.wait.lock                 pid 45312  已死
```

遗留锁会硬挡 `wake-bind` / `park`（`desktop-client.cjs` L158 报「先停止本会话旧 wait 进程并核实等待锁」）。`Store.unlock` 已具备拒绝存活 PID 的逻辑，扩展至 `.wait.lock` 是自然补齐。

## 8. 已消除项

### I. 版本元数据不一致（排查期间已修复）

排查开始时 `VERSION` 为 `0.4.3`，而 `package.json`、`.codex-plugin/plugin.json`、`skills/task-dispatch/SKILL.md` 标记、`CHANGELOG.md` 均停在 `0.4.2`，导致 `tests/codearts.test.cjs` 的版本一致性用例失败（当时全量 85 通过 / 1 失败）。

当前已全部对齐至 `0.4.3`（`CHANGELOG.md` 含 `## 0.4.3 — 2026-09-15` 条目），全量测试 **91/91 通过**。

## 9. 建议动作顺序

1. **等待在途 attempt 结算**（`D05-5-redo-scene`、`raincourt-A2`）。此刻重启会把项目锁死（第 6 节）。
2. **重启服务**加载当日代码，使 17 个文件的改动生效，并启动 `.codeartsdoer` 排除。
3. **补 `snapshotPolicy`**：RedBluePrint 排除 `tmp/`、`logs/`；codex_roge1 排除 `assets/review/`、`art_sources/`。零代码，收益最大。
4. **修复 P1-A**（两处 guard 改判 `t.scopeRecovery`），并补第三次越界后 `return-scope` 可用的回归。
5. 视需要处理 P2-D、P2-E、P3 各项。

## 10. 排查方法说明

全部结论仅通过只读方式取得：读取 `state.json`、`manifest.json`、`receipts/`、进程信息、`GET /status`，以及在本机对当前源码执行 `manifest()` 与哈希计算作对照。未修改代码、配置或状态文件，未重启服务。

## 生成/修改记录

| 时间 | 模型 | 操作 | 摘要 |
|------|------|------|------|
| 2026-09-15 00:05 | Claude | 创建 | 汇总对运行服务的只读排查：1 个 P1 缺陷、1 项 P1 运维风险、4 项 P2、3 项 P3，含实测数据与修复顺序 |
