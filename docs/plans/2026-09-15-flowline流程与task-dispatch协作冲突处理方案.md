# flowline 流程与 task-dispatch 协作冲突处理方案

- 日期：2026-09-15
- 类型：修复（跨插件冲突）
- 影响项目：task-dispatch（本仓库）、flowline（`D:\wjz\proj\plugins\flowline`）、用户目录 `~/.zcode`
- 状态：待审阅（收到输入 `1` 后执行）

---

## 一、问题现象

task-dispatch 的协作任务（大脑 / worker / 审核员）会被 flowline 的 flow-entry 系列流程干预，表现为：

1. worker 会话被注入「请先经过 flow-entry 建立本任务计划和日志」提示；
2. worker 的 Edit / Write / Bash 被直接阻断（退出码 2），任务无法推进；
3. worker 被误导去写 `docs/plans/`，与 task-dispatch「docs/plans/ 与 docs/reviews/ 仅大脑可写」冲突，触发 scopeRecovery；
4. 极端情况下 worker 按 flow-feature 等待用户确认，而派发场景无人应答，形成死锁。

## 二、根因

冲突分两层，两层都要处理，但**第二层才是真正的破坏点**。

```text
                    用户在大脑会话发令
                           │
                           ▼
              ┌────────────────────────────┐
   第 1 层    │  skill 描述层（软触发）     │  flow-entry.description 声明
   （软）      │  "feature/add/实现/修复…   │  "必须调用此 skill"，
              │   必须先调用此 skill"       │  对由服务派发的 worker 同样生效
              └────────────┬───────────────┘
                           │  worker 加载 flow-feature
                           ▼
              ┌────────────────────────────┐
   第 2 层    │  hook 硬闸门（真正的阻断）  │  ~/.zcode/cli/config.json
   （硬）      │  PreToolUse: Edit|Write|Bash│  → check-flow.js pre-tool-use
              └────────────┬───────────────┘
                           │
                    state.startedAt = 本次提示词提交时刻
                           │
        docs/plans 与 docs/logs 是否存在 mtime ≥ startedAt 的 .md
                    ┌──────┴───────┐
                   是              否
                    │              │
                 放行          exit 2 阻断
```

### 2.1 第 1 层：skill 描述的软触发

- `flow-entry` 的 description 写死「当用户提出新功能/新需求…或修复、bug…类请求时**必须**先调用此 skill」。
- `AGENTS.md` 第二条虽然给了例外（「除了使用 task-dispatch 技能」），但：
  - 它是自然语言约定，只覆盖「使用 task-dispatch 技能」的主会话；
  - worker / 审核员收到的是服务派发的 `job.prompt`，字面内容就是「实现 X 功能」「修复 Y 问题」，模型按描述规则会去加载 flow-entry。

### 2.2 第 2 层：hook 硬闸门（破坏点）

安装位置：`~/.zcode/cli/config.json` → `hooks.events.PreToolUse`，matcher `Edit|Write|Bash`，
命令 `node C:\Users\Lenovo\.zcode\flowline\hooks\check-flow.js pre-tool-use`（退出码协议，2 = 阻断）。

判据链（`check-flow.js`，v2.11.2 已装版）：

| 步骤 | 事件 | 行为 | 行号 |
| --- | --- | --- | --- |
| 1 | `user-prompt-submit` | 提示词命中 `REQUIRE_RE`/`FIX_RE` → 写 state，`startedAt = 当前时刻` | 527-536 |
| 2 | `pre-tool-use` | 写 `docs/**`、`PROJECT.md` → 直接放行 | 553-561 |
| 3 | `pre-tool-use` | 项目无 `docs/` 目录 → 放行 | 570 |
| 4 | `pre-tool-use` | `state.exempt` → 放行 | 571 |
| 5 | `pre-tool-use` | 要求 `docs/plans/` 与 `docs/logs/` 均有 **mtime ≥ startedAt** 的 `.md`，否则 **exit 2** | 572-579 |
| 6 | `stop` | 命中需求类且无本任务 `docs/specs/*.md` → 阻断结束 | 595-602 |

关键点：

- **豁免通道只有两个**：提示词关键词（`不走流程 / 无需计划 / 快速改…`，`check-flow.js:32`）或提示词末尾控制标记（`--` / `111`）。
- **state 按 `sha256(sessionId + projectRoot)` 存在 `%TEMP%/flowline-hook-state-v2/`**，`startedAt` 是**会话内**时间戳。
  大脑早已写好的 `docs/plans/*.md` 其 mtime 必然早于 worker 会话的 `startedAt` → 永远判为「本任务无有效计划」。
- worker 的提示词由服务生成，用户无法为其追加 `--` 控制标记；大脑会话的豁免 state 也不会共享给 worker 会话。
- **Bash 同样被闸门覆盖**：Bash 的 payload 没有 `file_path`，`targets` 为空，直接落到第 5 步通用闸门 → 审核员跑测试、worker 跑构建一并被阻断。

### 2.3 复现证据

探针脚本：`tmp/flowline-hook-repro.cjs`（直接以 stdin 喂 JSON 给已装 hook，未修改任何配置）。

命令：`node tmp/flowline-hook-repro.cjs`

```text
--- [1] user-prompt-submit / worker 收到含"实现"的任务包 -> exit=0
    {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":
     "[flowline hook] 检测到需求/修复类请求。请先经过 flow-entry 建立本任务计划和日志，确认后再修改代码。"}}
--- [2] pre-tool-use / worker Edit 业务代码 -> exit=2
    [flowline hook] 本任务尚无有效计划文件或任务日志（docs/plans/、docs/logs/）。请先经过 flow-entry 完成计划与日志后再修改代码。
--- [3] pre-tool-use / worker Bash 跑测试 -> exit=2
    （同上）
--- [4] pre-tool-use / 大脑写 docs/plans -> exit=0
--- [5] user-prompt-submit / 提示词带"不走流程" -> exit=0
--- [6] pre-tool-use / 同会话 Edit（对照） -> exit=0
--- [7] pre-tool-use / 无 state 的新会话（对照） -> exit=0
```

结论：`[2][3]` 复现阻断，`[4]` 说明大脑侧不受影响，`[5][6]` 证明"提示词豁免词"这条通道有效，`[7]` 说明只有命中需求/修复信号词并写入 state 的会话才被卡。

### 2.4 影响面

| 角色 | 受影响程度 | 表现 |
| --- | --- | --- |
| 大脑 | 部分 | 用户首句含「实现/修复」即写 state；写 `docs/plans/` 不受阻；结束会话时可能被要求补 `docs/specs/` |
| worker | 严重 | Edit / Write / Bash 全部阻断；被误导写 `docs/plans/` → 越界 → scopeRecovery |
| 审核员 | 严重 | 读文件不受限，但跑测试/命令的 Bash 被阻断 |
| 普通项目（非协作） | 无 | flowline 约束照常生效，属期望行为 |

## 三、方案对比

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A（推荐）** | task-dispatch 在派发提示词中注入显式豁免声明 | flowline 零改动、立即生效、不动用户目录 | 依赖 prompt 文本；若宿主不为服务注入的消息触发 UserPromptSubmit 则失效，需实测 |
| **B** | flowline 侧加协作豁免：`check-flow.js` 识别项目根 `.task-dispatch/` 标记或把 `task-dispatch` 加入 `EXEMPT_RE`，全量放行 | 不依赖提示词文本，大脑会话也自动豁免 | 跨仓库改动；需重装 hook 并在 ZCode 重新信任；项目级豁免会让该项目所有会话失去 flowline 约束 |
| **C（补充）** | 在 `flow-entry` 的 description 与正文加「由 task-dispatch 派发的协作任务除外」 | 消除第 1 层误触发 | 治不了 hook 硬阻断，单用不充分 |
| **D** | `~/.zcode/cli/config.json` 关闭 hooks 或删除 PreToolUse 条目 | 一行解决 | 普通项目的流程强制全部失效，用安全网换通畅 |

**推荐：A + C 组合。**
先由 A 让协作会话立刻不被卡（且不动用户目录），C 消除模型层误触发；若实测「服务注入消息不触发 UserPromptSubmit」，再升级到 B。

## 四、实施步骤（待输入 `1` 后执行）

1. **A-1（task-dispatch 侧）**：在 runtime 组装 `job.prompt` 的位置，于提示词开头注入一行：
   `本任务由 task-dispatch 协作服务派发：不走流程，无需计划，不产出 docs/plans、docs/logs、docs/specs 等流程产物。`
   该行命中 `check-flow.js` 的 `EXEMPT_RE`，使整场 worker 会话获得豁免（复现证据 `[5][6]`）。
2. **A-2（task-dispatch 侧）**：同步 `skills/task-dispatch/SKILL.md`、`references/desktop.md`、`references/handoff.md`，明确 worker / 审核员收到派发提示词时不得加载 `flow-entry` / `flow-feature` / `flow-fix`。
3. **C-1（flowline 侧，需跨仓库授权）**：`src/entry.md` 与两份已装 `flow-entry/SKILL.md` 的 description 增加协作任务例外。
4. **版本**：task-dispatch bump 至 0.5.2（`VERSION`、`skills/task-dispatch/SKILL.md` 内版本注释、`CHANGELOG.md`）。
5. **仅在 A 实测失效时**，执行 B：修改 flowline `scripts/check-flow.js` + `src/check-flow` 源，重装 hook，并 bump flowline 版本。

## 五、验证方式

| 用例 | 预期 |
| --- | --- |
| worker 提示词含 A-1 注入行 | hook 不注入 flowline 提示；Edit / Bash 均放行（exit 0） |
| worker 提示词不含该行（回归对照） | 复现 exit 2 阻断，确认修复点确实作用于此 |
| 审核员会话跑测试命令 | Bash 放行 |
| 普通项目（未经 task-dispatch 派发） | flowline 提示与闸门照常生效 |
| 现有 `npm test` / `npm run verify:skill` | 全部通过 |

## 六、风险与约束

- 方案 A 的生效前提是 ZCode 对服务注入消息触发 `UserPromptSubmit`；若不触发，必须转 B，不能假设已修复。
- 方案 B 属于项目级豁免，会削弱该项目所有会话的 flowline 约束，需先确定豁免范围（单项目 / 仅协作会话）。
- 修改 `~/.zcode`、`~/.agents`、`flowline` 仓库均在当前工作空间之外，按团队规则须先获授权。
- 本方案不触碰 `docs/logs/`、`docs/summaries/` 中的历史结论。

## 七、待确认问题

1. 是否接受推荐的 A + C 组合？还是直接上 B（flowline 加协作豁免）？
2. 是否授权修改工作空间外的 `flowline` 仓库与 `~/.zcode`、`~/.agents`？
3. 豁免范围按「协作会话」还是「整个项目」？
