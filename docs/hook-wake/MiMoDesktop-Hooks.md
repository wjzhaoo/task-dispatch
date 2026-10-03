# MiMo Desktop Hooks 说明

MiMo Desktop 内嵌 MiMoCode 引擎，支持通过 **Hooks（钩子）** 拦截并改写工具调用、LLM 请求、会话与子代理生命周期等行为。

- 口诀：**tools 加能力（verbs），hooks 加反射（reflexes），skills 加记忆（memories）**
- 热加载：hooks 文件写入后，**下一轮对话**自动生效，无需重启

---

## 1. 文件位置

| 类型 | 路径 | 热加载时机 |
|------|------|-----------|
| Hooks | `.mimocode/hooks/*.ts` | 下一轮对话 |
| Tools | `.mimocode/tools/*.ts` | 下一轮对话 |
| Skills | `.mimocode/skills/*/SKILL.md` | 下一轮对话 |
| Workflows | `.mimocode/workflows/*.js` | 调用时 |
| TUI 插件 | `.mimocode/tui/*.tsx` | 重启后 |

路径相对于**项目根目录**。全局配置在 `~/.config/mimocode/`。

每个 hooks 文件默认导出一个 Hooks 对象；一个文件可注册多个事件。

```ts
import type { Hooks } from "@mimo-ai/plugin"

const hooks: Hooks = {
  "event.name": async (input, output) => {
    // 修改 output 以改变行为
  },
}

export default hooks
```

---

## 2. 事件总览

| 类别 | 事件 |
|------|------|
| 工具 | `tool.execute.before` · `tool.execute.after` · `tool.definition` |
| LLM 请求 | `chat.params` · `chat.headers` · `experimental.chat.system.transform` · `experimental.chat.messages.transform` |
| 消息 | `chat.message` · `experimental.text.complete` |
| 会话生命周期 | `session.pre` · `session.post` · `session.userQuery.pre` · `session.userQuery.post` |
| 子代理生命周期 | `actor.preStop` · `actor.postStop` |
| 压缩/上下文 | `experimental.session.compacting` · `experimental.compaction.autocontinue` |
| 环境 | `shell.env` · `command.execute.before` · `permission.ask`（尚未接入） |

---

## 3. 事件详解

### 3.1 `tool.execute.before`

工具执行前触发。可改参数，或取消执行。

```ts
"tool.execute.before": async (input, output) => {
  // input（只读）:
  //   input.tool: string       — 工具 id（bash / write / edit 等）
  //   input.sessionID: string
  //   input.callID: string

  // output（可变）:
  //   output.args: any         — 工具参数，可改写
  //   output.cancel?: boolean  — true 则拦截
  //   output.cancelReason?: string — 作为工具结果回传给模型
}
```

### 3.2 `tool.execute.after`

工具执行后触发。可改写返回文本。

```ts
"tool.execute.after": async (input, output) => {
  // input: tool, sessionID, callID, args（实际使用的参数）

  // output（可变）:
  //   output.title: string
  //   output.output: string    — 工具文本输出
  //   output.metadata: any
}
```

注意：改的是 `output.output`，**不是** `output.result`（写错字段会静默失效）。

### 3.3 `tool.definition`

改写发给模型的工具描述/参数 schema。

```ts
"tool.definition": async (input, output) => {
  // input.toolID: string
  // output.description: string
  // output.parameters: any   — JSON Schema
}
```

### 3.4 `chat.params`

改写 LLM 请求参数。

```ts
"chat.params": async (input, output) => {
  // input: sessionID, agent, model, provider

  // output:
  //   output.temperature, topP, topK
  //   output.maxOutputTokens
  //   output.options: Record<string, any>
}
```

### 3.5 `chat.headers`

给 LLM 请求加自定义 HTTP 头。

```ts
"chat.headers": async (input, output) => {
  // output.headers: Record<string, string>
}
```

### 3.6 `experimental.chat.system.transform`

改写系统提示词。

```ts
"experimental.chat.system.transform": async (input, output) => {
  // output.system: string[]  — 系统提示词分段
  // push 追加，splice 插入，整体替换可覆盖
  output.system.push("Always respond concisely.")
}
```

### 3.7 `experimental.chat.messages.transform`

改写发给模型的消息列表。

```ts
"experimental.chat.messages.transform": async (input, output) => {
  // output.messages: Array<{ info: Message, parts: Part[] }>
  // 可过滤、重排、改写
}
```

### 3.8 `session.pre` / `session.post`

会话 runLoop 生命周期。`pre` 在第一次 LLM 步骤前触发（可取消）；`post` 在循环结束时触发（即使出错/中断也会触发）。

```ts
"session.pre": async (input, output) => {
  // input.sessionID, input.agentID, input.task_id?
  // output.cancel?, output.cancelReason?
},
"session.post": async (input, output) => {
  // input.outcome: "completed" | "error" | "cancelled"
  // input.error?, input.finalText?
  // input.trajectory: TrajectoryMessage[]  — 完整轨迹（用户输入、工具调用、推理）
}
```

### 3.9 `session.userQuery.pre` / `.post`

单个 LLM 步骤生命周期（一次用户回合可能包含多步：工具往返、重试）。

```ts
"session.userQuery.pre": async (input, output) => {
  // input.step, input.messageID, input.query
  // output.cancel?, output.cancelReason?
},
"session.userQuery.post": async (input, output) => {
  // input.step, input.assistantMessageID, input.finish?, input.error?
  // input.finalText?, input.trajectory
}
```

### 3.10 `actor.preStop` / `actor.postStop`

子代理交付生命周期。

- `preStop`：最终文本交付给调用方**之前**触发；可 `output.continue = true` + `output.reason`，强制子代理再跑一轮
- `postStop`：交付**之后**触发；continue 仍可再跑，但新的 finalText **不会**再传回调用方

注册时可传裸函数，或 `{ matcher, run }`。默认 matcher 排除内置代理（main、general、explore、summary、title、checkpoint-writer、dream、distill、compaction）。

```ts
"actor.preStop": {
  matcher: { agentType: { include: ["general"] }, mode: "subagent" },
  run: async (input, output) => {
    // input.actorID, agentType, task, finalText?, iteration
    if (!input.finalText?.includes("**Status**:")) {
      output.continue = true
      output.reason = "Your reply is missing the required Status header. Add it."
    }
  },
},
"actor.postStop": async (input, output) => {
  // input.outcome: "success" | "failure" | "cancelled"
  // input.error? (失败时)
  // input.canWrite? (false 表示代理没有 Write 工具)
}
```

### 3.11 `permission.ask`

自动放行/拒绝权限请求。

> **注意**：已在 Hooks 接口中定义，但权限系统**尚未接入**，目前是 no-op（写了安全，暂不生效）。

```ts
"permission.ask": async (input, output) => {
  // input.permission: string
  // output.status: "ask" | "deny" | "allow"
}
```

### 3.12 `shell.env`

给 shell 执行注入环境变量。

```ts
"shell.env": async (input, output) => {
  // input.cwd, input.sessionID?
  // output.env: Record<string, string>
  output.env.NODE_ENV = "development"
}
```

### 3.13 `command.execute.before`

slash 命令执行前注入内容。

```ts
"command.execute.before": async (input, output) => {
  // input.command, input.sessionID, input.arguments
  // output.parts: Part[]
}
```

### 3.14 `chat.message`

新消息到达时触发。

```ts
"chat.message": async (input, output) => {
  // output.message: UserMessage
  // output.parts: Part[]
}
```

### 3.15 `experimental.text.complete`

文本流式输出完成时触发（只读检查）。

```ts
"experimental.text.complete": async (input, output) => {
  // input.sessionID, messageID, partID
  // output.text: string
}
```

### 3.16 压缩相关

```ts
"experimental.session.compacting": async (input, output) => {
  // output.context: string[]  — 追加到压缩提示
  // output.prompt?: string    — 完全替换默认压缩提示
},
"experimental.compaction.autocontinue": async (input, output) => {
  // input.overflow: boolean   — 是否因上下文溢出强制压缩
  // output.enabled: boolean   — 默认 true；false 则跳过压缩后的 continue 轮
}
```

---

## 4. 示例

### 4.1 危险命令拦截

```ts
// .mimocode/hooks/safety.ts
export default {
  "tool.execute.before": async (input, output) => {
    if (input.tool === "bash") {
      const cmd = output.args.command ?? ""
      if (/rm\s+-rf\s+\//.test(cmd)) {
        output.cancel = true
        output.cancelReason = "Blocked: dangerous rm -rf on root"
      }
    }
  },
}
```

### 4.2 自动放行只读操作

```ts
// .mimocode/hooks/auto-allow-reads.ts
export default {
  "permission.ask": async (input, output) => {
    if (
      input.permission === "read" ||
      input.permission === "glob" ||
      input.permission === "grep"
    ) {
      output.status = "allow"
    }
  },
}
```

> 当前 `permission.ask` 尚未接入权限系统，此 hook 暂不生效。

### 4.3 向系统提示词注入项目上下文

```ts
// .mimocode/hooks/project-context.ts
import { readFileSync } from "fs"

export default {
  "experimental.chat.system.transform": async (input, output) => {
    try {
      const ctx = readFileSync(".mimocode/project-context.md", "utf-8")
      output.system.push(ctx)
    } catch {}
  },
}
```

### 4.4 子代理交付验收

```ts
// .mimocode/hooks/subagent-gate.ts
export default {
  "actor.preStop": {
    matcher: { agentType: { include: ["general"] }, mode: "subagent" },
    run: async (input, output) => {
      if (!input.finalText?.includes("**Status**:")) {
        output.continue = true
        output.reason = "Your reply is missing the required Status header. Add it."
      }
    },
  },
}
```

---

## 5. 约束与注意

1. Hooks / Tools 与 bash **同权限**，不能提权
2. **不能修改权限系统**
3. 工具输出截断：50KB / 2000 行
4. 字段名必须完全匹配；写错（如 `output.result`）会**静默失败**
5. 不要创建隐藏信息、绕过确认的扩展
6. 优先小而可组合的扩展，避免大而全的单体 hook

---

## 6. 相关扩展面

除 hooks 外，MiMoCode 还可通过项目目录自扩展：

| 想做什么 | 用什么 |
|----------|--------|
| 改变「能做什么」 | Tools（`.mimocode/tools/*.ts`），同名可覆盖内置工具 |
| 改变「怎么反应」 | Hooks（`.mimocode/hooks/*.ts`） |
| 记住「怎么做 X」 | Skills（`.mimocode/skills/*/SKILL.md`） |
| 多代理流水线 | Workflows（`.mimocode/workflows/*.js`） |
| 改终端 UI | TUI 插件（`.mimocode/tui/*.tsx`） |

系统内置了 `evolve` 技能，可直接在对话中说「用 evolve 加一个 hook …」，由代理帮你创建并验证。

---

## 参考来源

- MiMoCode 文档：`mimocode-docs` skill（guide / config）
- Hook API：`evolve` skill → `reference/hook-api.md`
- 产品说明：`mimo-desktop-guide` skill
