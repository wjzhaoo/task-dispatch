# CodeArts Hook 机制

> CodeArts 基于 opencode，通过插件（Plugins）系统提供 hooks，可在特定事件发生时执行自定义逻辑。

## 一、整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      CodeArts Hook 系统                      │
└─────────────────────────────────────────────────────────────┘

  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
  │ 插件文件      │ ──> │ 导出函数      │ ──> │ 返回 hooks   │
  │ *.ts / *.js  │     │ (ctx) => {}  │     │ 对象         │
  └──────────────┘     └──────────────┘     └──────────────┘
                                                  │
                                                  v
  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
  │ 执行自定义    │ <── │ 事件触发时    │ <── │ 事件监听     │
  │ 逻辑         │     │ 匹配 hook    │     │ (内部总线)   │
  └──────────────┘     └──────────────┘     └──────────────┘
```

## 二、插件加载顺序

```
1. 全局配置 (~/.config/opencode/opencode.json)
2. 项目配置 (opencode.json)
3. 全局插件目录 (~/.config/opencode/plugins/)
4. 项目插件目录 (.opencode/plugins/)
```

> 同名 npm 包只加载一次；本地插件与同名 npm 插件分别独立加载。

## 三、插件放置位置

```
CodeArts 环境下的对应关系：

opencode 标准路径              CodeArts 实际路径
────────────────────────       ──────────────────────────────────────
~/.config/opencode/     ──>    C:\Users\Lenovo\.codeartsdoer\
.opencode/plugins/      ──>    <项目根>\.opencode\plugins\
~/.config/opencode/plugins/ ─> C:\Users\Lenovo\.codeartsdoer\plugins\
```

### 三种加载方式

| 方式 | 位置 | 说明 |
|------|------|------|
| **项目级本地文件** | `.opencode/plugins/*.ts` | 随项目走，可提交 Git |
| **全局本地文件** | `~/.codeartsdoer/plugins/*.ts` | 所有项目生效 |
| **npm 包** | `opencode.json` 中 `plugin` 字段 | 启动时由 Bun 自动安装 |

npm 包配置示例：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-helicone-session", "opencode-wakatime", "@my-org/custom-plugin"]
}
```

## 四、可用的 Hook 事件

### 事件总览

```
┌─────────────────────────────────────────────────────────┐
│                    Hook 事件分类                          │
├───────────┬───────────┬───────────┬─────────────────────┤
│  Session  │  Message  │   Tool    │       File          │
├───────────┼───────────┼───────────┼─────────────────────┤
│ Permission│  Command  │   Shell   │        LSP          │
├───────────┼───────────┼───────────┼─────────────────────┤
│   TUI     │   Todo    │  Server   │    Compaction       │
└───────────┴───────────┴───────────┴─────────────────────┘
```

### 详细事件列表

| 类别 | 事件名 | 触发时机 |
|------|--------|----------|
| **会话** | `session.created` | 新会话创建时 |
| | `session.idle` | 会话空闲（AI 回复完成）时 |
| | `session.updated` | 会话信息更新时 |
| | `session.deleted` | 会话删除时 |
| | `session.compacted` | 上下文压缩时 |
| | `session.error` | 会话发生错误时 |
| | `session.status` | 会话状态变更时 |
| | `session.diff` | 会话产生文件差异时 |
| **消息** | `message.updated` | 消息更新时 |
| | `message.part.updated` | 消息分片更新时（流式） |
| | `message.removed` | 消息删除时 |
| | `message.part.removed` | 消息分片删除时 |
| **工具** | `tool.execute.before` | 工具执行**前**（可拦截/修改参数） |
| | `tool.execute.after` | 工具执行**后** |
| **文件** | `file.edited` | 文件被编辑时 |
| | `file.watcher.updated` | 文件监视器检测到变更时 |
| **权限** | `permission.asked` | 请求用户授权时 |
| | `permission.replied` | 用户回复授权请求时 |
| **命令** | `command.executed` | 自定义命令执行时 |
| **Shell** | `shell.env` | Shell 环境变量注入时 |
| **LSP** | `lsp.client.diagnostics` | LSP 诊断信息更新时 |
| | `lsp.updated` | LSP 状态更新时 |
| **TUI** | `tui.prompt.append` | TUI 追加提示文本时 |
| | `tui.command.execute` | TUI 执行命令时 |
| | `tui.toast.show` | TUI 显示 toast 通知时 |
| **Todo** | `todo.updated` | 待办事项更新时 |
| **服务器** | `server.connected` | 客户端连接到服务器时 |
| **安装** | `installation.updated` | 安装信息更新时 |
| **压缩** | `experimental.session.compacting` | 上下文压缩前（可注入额外上下文） |

## 五、插件基本结构

### 5.1 函数签名

```typescript
import type { Plugin } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async (ctx) => {
  // ctx 包含以下字段：
  // - project:   当前项目信息
  // - directory: 当前工作目录
  // - worktree:  git worktree 路径
  // - client:    opencode SDK 客户端（可调用 AI）
  // - $:         Bun shell API（可执行命令）

  return {
    // 在这里定义 hooks
  }
}
```

### 5.2 两种 Hook 模式

```
模式 A：事件监听（只读通知）
┌──────────────────────────────┐
│  event: async ({ event }) => │
│    if (event.type === "...") │
│      // 执行副作用            │
└──────────────────────────────┘

模式 B：拦截器（可修改输入/输出）
┌──────────────────────────────────┐
│  "tool.execute.before":          │
│    async (input, output) => {    │
│      // 可读取 input.tool        │
│      // 可修改 output.args       │
│      // 可 throw 阻止执行        │
│    }                             │
└──────────────────────────────────┘
```

## 六、完整示例

### 示例 1：会话完成通知

```typescript
// .opencode/plugins/notification.ts
import type { Plugin } from "@opencode-ai/plugin"

export const NotificationPlugin: Plugin = async ({ $ }) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        // Windows 弹窗通知
        await $`powershell -Command "msg * 'CodeArts 会话已完成!'"`
      }
    },
  }
}
```

### 示例 2：禁止读取 .env 文件

```typescript
// .opencode/plugins/env-protection.ts
import type { Plugin } from "@opencode-ai/plugin"

export const EnvProtection: Plugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "read" && output.args.filePath.includes(".env")) {
        throw new Error("安全策略：禁止读取 .env 文件")
      }
    },
  }
}
```

### 示例 3：注入环境变量

```typescript
// .opencode/plugins/inject-env.ts
import type { Plugin } from "@opencode-ai/plugin"

export const InjectEnvPlugin: Plugin = async () => {
  return {
    "shell.env": async (input, output) => {
      output.env.MY_API_KEY = "secret"
      output.env.PROJECT_ROOT = input.cwd
    },
  }
}
```

### 示例 4：自定义工具

```typescript
// .opencode/plugins/custom-tools.ts
import { type Plugin, tool } from "@opencode-ai/plugin"

export const CustomToolsPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      mytool: tool({
        description: "这是一个自定义工具",
        args: {
          foo: tool.schema.string(),
        },
        async execute(args, context) {
          const { directory, worktree } = context
          return `Hello ${args.foo} from ${directory} (worktree: ${worktree})`
        },
      }),
    },
  }
}
```

> 如果插件工具与内置工具同名，插件工具优先。

### 示例 5：结构化日志

```typescript
// .opencode/plugins/logging.ts
import type { Plugin } from "@opencode-ai/plugin"

export const LoggingPlugin: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "my-plugin",
      level: "info",          // debug | info | warn | error
      message: "插件已初始化",
      extra: { foo: "bar" },
    },
  })
}
```

### 示例 6：自定义上下文压缩

```typescript
// .opencode/plugins/compaction.ts
import type { Plugin } from "@opencode-ai/plugin"

export const CompactionPlugin: Plugin = async (ctx) => {
  return {
    "experimental.session.compacting": async (input, output) => {
      // 向压缩提示注入额外上下文
      output.context.push(`## 自定义上下文
- 当前任务状态
- 已做出的重要决策
- 正在修改的文件`)
    },
  }
}
```

完全替换压缩提示：

```typescript
export const CustomCompactionPlugin: Plugin = async (ctx) => {
  return {
    "experimental.session.compacting": async (input, output) => {
      // 设置 output.prompt 将完全替换默认压缩提示
      output.prompt = `请总结以下内容：
1. 当前任务及其状态
2. 正在修改的文件
3. 下一步计划`
    },
  }
}
```

## 七、依赖管理

插件如需使用外部 npm 包，在配置目录添加 `package.json`：

```json
// .opencode/package.json
{
  "dependencies": {
    "shescape": "^2.1.0"
  }
}
```

启动时自动执行 `bun install`，插件中可直接 import：

```typescript
// .opencode/plugins/my-plugin.ts
import { escape } from "shescape"

export const MyPlugin = async (ctx) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash") {
        output.args.command = escape(output.args.command)
      }
    },
  }
}
```

## 八、快速上手清单

```
1. 创建目录:  .opencode/plugins/
2. 编写插件:  .opencode/plugins/my-hook.ts
3. （如需依赖）添加 .opencode/package.json
4. 重启 CodeArts（插件在启动时自动加载）
5. 查看日志确认加载: C:\Users\Lenovo\.codeartsdoer\codearts-data\log\
```

## 九、参考链接

| 资源 | 地址 |
|------|------|
| opencode 插件文档 | https://opencode.ai/docs/plugins/ |
| opencode 配置文档 | https://opencode.ai/docs/config/ |
| opencode SDK 文档 | https://opencode.ai/docs/sdk/ |
| Bun Shell API | https://bun.com/docs/runtime/shell |
| 插件类型包 | `@opencode-ai/plugin` |