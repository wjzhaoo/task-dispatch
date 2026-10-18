# Task Dispatch

Web 管理端创建目标后保持待开始，全部成员就绪后由用户点击「开始」：只填名称、目标与验收要求、项目目录，默认“大脑＋初审端＋一名执行员”，成员配置收进高级设置。同一目录复用项目、团队与绑定，连续新增的目标顺序执行；缺少的成员可以同时接入，一次 connect 完成核验、保存凭据与待命。创建与接入本身不会启动任务；已明确加入队列的目标按顺序执行，大脑明确完成验收后继续下一目标，队列为空则保留成员待命。本轮仅支持同机，详情见[统一 Web 控制台](docs/admin-console.md)。

新增[统一 Web 控制台](docs/admin-console.md)：双击 `dashboard.bat`（或 `web-console.bat`）直接打开浏览器主页，无需在终端选择目录。主页读取用户总目录中的项目目录表（`%USERPROFILE%\.task-dispatch-service\service-registry.json`，仅含项目 ID 与路径映射，不含令牌），表里有多少项目就显示多少张卡片；点击进入的项目控制台仍在同一端口内打开（默认 **43187**，被占用自动顺延；已运行则复用并重新打开登录链接），不再跳转其他端口。控制台分「总览 / 任务 / 事件」三个页签，跨项目聚合只保留在主页。原命令行菜单保留为 `dashboard.bat --cli`。

当前版本：**1.0.0**。版本源文件为 [VERSION](VERSION)，变更记录见 [CHANGELOG.md](CHANGELOG.md)。package.json、插件清单和技能版本标记保持一致，自动测试检查版本漂移。

新增 [Qoder / QoderCN 原会话接入](skills/task-dispatch/references/qoder.md)：`node scripts/install.js qoder`（或 `qodercn`）安装技能与常驻 App Plugin 桥接，重启 Qoder 后 `connect --provider qoder` 接入。提交后 `resume` 可长期待命，任务到达时桥接通过 `chat.continueSession` 直接唤醒原会话，不使用 Stop Hook。

新增 [OpenCode 2.x 原会话接入](skills/task-dispatch/references/opencode.md)：`node scripts/install.js opencode` 安装技能，使用真实 `ses_...` 会话 ID 接入 brain、reviewer 或 worker。Skill 安装支持 Codex、MiMo、Qoder、QoderCN 和 OpenCode，`all` 包含这五个安装目标。

[CodeArts 接入](skills/task-dispatch/references/codearts.md) 使用独立 Hook bridge，参数为 `--provider codearts`（兼容 `codeartsdoer`），不使用 OpenCode 2.x 数据库或 CLI。已有 Hook 环境可继续接入；Skill 安装目标保持上述五种。

游戏与应用开发的任务分派 Skill：强模型设计与审核，经济模型处理明确任务，按风险与依赖设置审核点。

## 可选：本地自动交接服务

支持一个 brain、一个必需的 reviewer、多 worker 编号接入，项目内保持串行。brain connect 后先评估本阶段模型数量与职责，`staff --file` 登记并返回逐编号 workerInvites；`invite --worker-id strong --capability strong` 生成指定执行员说明。任务可指定 workerId/requiredCapability，没有匹配绑定时排队等待，不消耗执行回合。`detach` 主动断绑；reviewer 崩溃且不能自解绑时，brain 可明确执行 `detach --role reviewer`，安全终止旧初审所有权，等待新 reviewer 恢复初审，绝不按超时自动接管。worker 在新会话使用对应编号的新邀请自动换绑，大脑通过 `handoff-invite` 输出接替提示词；`assign` 改派未执行任务。见[多执行员接入](skills/task-dispatch/references/workers.md)。

服务协作的默认入口为 `node runtime/desktop-client.cjs connect --provider <真实平台>`：当前目录作为项目、当前会话作为 brain，自动启动服务并生成绑定凭据。connect/rebind 必须由接收端明确平台，不从目录或其他 IDE 猜测。brain/reviewer 支持 Codex、MiMo、Qoder、OpenCode、CodeArts、DSH 六种 wake 平台；worker 可用合法 provider。六种 wake 平台严格核验真实会话，只有执行员可使用其他 provider，无需 session ID、持续 wait。Codex 仅在显式 `--provider codex` 后读取 CODEX_THREAD_ID；Qoder 首次连接可使用邀请自带的一次性 `--invitation-id`，无需人工查找 session ID。reviewer 初审不会因无心跳被撤销，确定终止时显式 detach。

Skill 安装时生成不含令牌的 `runtime-link.json`，指向本仓库客户端并声明按工作区解析项目数据目录。桌面 `connect` 成功后保存连接描述并返回最终状态；已持有本端凭据时直接 `resume`，缺少凭据路径时才用 `discover` 只读定位，排查问题时再用 `status`。自定义服务目录需沿用用户提供的 `--data`。状态格式保持 version 2；结构完整的现行数据继续使用，不完整旧数据明确拒绝，不自动补齐。见[服务发现与接入](skills/task-dispatch/references/connection.md)。

项目快照、清理策略、消耗统计与独立验证环境仍由运行时管理接口保留，见[存储与消耗说明](docs/storage-usage.md)和[独立验证环境](docs/review-validation.md)；它们不再出现在 `start.bat` 的日常入口中。

Codex、MiMo、Qoder、OpenCode、CodeArts、DSH 桌面会话通过 `connect/resume → claim → submit → park` 协作。修改运行时代码后，服务和客户端需同步更新并在安全边界重启服务。

唯一工作流为完整功能阶段集中终审：大脑制定完整计划，plan 登记草案，stage-register 提交后执行；小脑逐项初审，全部通过后大脑整体终审。发现问题由大脑追加关联修复任务并再次验收；阶段通过才进入下一阶段。操作见[阶段计划与终审](skills/task-dispatch/references/stages.md)。状态保持 version 2，结构完整的现行数据继续使用，依赖已移除机制的旧队列明确拒绝。修改运行时代码后需重启服务才生效。

**Windows 的 `start.bat` 现在只是桌面客户端入口，不再启动旧 CLI/headless 菜单。** 双击会显示常用命令；在终端中可直接执行 `start.bat connect ...`、`start.bat resume ...`、`start.bat status ...`。`connect` 会按需初始化并启动本地服务。用户已明确指定的平台直接复用，仅缺失时询问。服务已就绪时只需一次轻量检查和一次连接请求；连接变更合并持久化，原样重连不重复写入。

**任务看板与控制台由 `dashboard.bat` 提供。** 双击直接进入统一 Web 控制台主页：项目目录表有多少项目就显示多少张卡片，点击卡片在同一端口进入该项目控制台。项目统一从目录主页选择；Web 启动器不接受 `--data` / `--workspace` 直连参数。原命令行菜单保留为 `dashboard.bat --cli`，空清单时进入刷新等待模式。

<!-- [AI-added] 2026-09-17 11:46 -->
新建桌面项目默认使用项目内 `.task-dispatch/runtime/<项目路径摘要>/`，状态、快照、收据、审核副本和角色凭据均严格保存在该私有运行目录；`.task-dispatch/.gitignore` 会忽略 `runtime/`，候选快照也强制排除它。系统缓存只保存不含令牌的项目目录清单（项目工作目录与数据目录映射），不再创建空的用户级公共服务。自定义目录可显式追加 `--data "数据目录"`；系统索引目录不能承载服务数据。不支持旧目录发现或旧数据迁移，结构不完整的数据会明确拒绝加载。

运行时支持多项目队列、执行与审核分离、阶段修复轮和持久化恢复。Node.js 22+（OpenCode 需 22.13+），无需第三方依赖。配置只包含版本与并发上限；Skill 安装器不会启动服务。

完整配置、启动、恢复和角色隔离边界见 [运行文档](docs/runtime.md)。已知缺陷、存储占用实测与修复顺序见 [运行服务健康排查](docs/service-health-audit.md)。初始任务示例在 `examples/`。支持 Codex、MiMo、Qoder/QoderCN、OpenCode、CodeArts 和 DSH 现有桌面会话，不启动无人值守模型进程。connect 自动核验真实会话、完成绑定并待命；后续使用 resume。

## 一键安装

需要 Node.js 22 或更新版本，OpenCode 需 22.13+；无 npm 依赖。双击 `install.bat`，输入平台名称；直接回车安装到所有平台。

```bat
install.bat codex
install.bat codex,mimo,qoder,opencode
install.bat codex --dry-run
```

也可跨平台执行 `node scripts/install.js codex`。`--home DIRECTORY` 可指定测试用户目录；默认使用当前用户目录。与参考包一致采用 Skill 文件复制安装，不注册插件市场、不自动配置模型或 API Key。

| 平台 | 用户目录下安装位置 |
| --- | --- |
| codex | `.codex/skills/task-dispatch` |
| mimo | `.config/mimocode/skills/task-dispatch`（YAML frontmatter） |
| qoder | `.qoder/skills/task-dispatch`，桥接位于 `.qoder/app/dev-extensions/task-dispatch-bridge` |
| qodercn | `.qoder-cn/skills/task-dispatch`，桥接位于 `.qoder-cn/app/dev-extensions/task-dispatch-bridge`（兼容别名 `qoder-cn`） |
| opencode | `.config/opencode/skills/task-dispatch` |

安装器支持上表中的平台；CodeArts 使用已有 Hook 环境，DSH 通过本机 Remote API 接入，见 [DSH 接入](skills/task-dispatch/references/dsh.md)。大脑和小脑可使用全部六种 wake 平台，只有执行员可使用非 wake 平台。Qoder 与 QoderCN 是同一角色平台的两个产品安装目录，运行时 provider 均使用 `qoder`。

## 使用

安装后新建对话，输入：

> 使用 $task-dispatch，把当前功能拆成可交接任务包，标注模型角色、依赖和审核点。

也可要求“只规划”“审核这批结果”或“按已授权工具执行”。没有外部模型接口时生成手动交接包，不会声称已经调用其他模型。其他工具若不支持 `$` 调用语法，可直接要求读取其安装目录的 `SKILL.md`。

## 升级与验证

更新本目录文件后再次运行安装命令。安装器按内容判断更新，不仅检查版本号。已安装文件被手动修改且与新版冲突时，会在写入前停止并指出路径；先备份或移走冲突文件，再重试。用户额外添加的文件和新版已移除的旧文件保留，不执行目录清空；正常升级只覆盖确认未被修改的同名文件。每个平台保存 `.task-dispatch-install.json` 作为内容记录。

```bat
node scripts/verify.js
```

验证在系统临时目录完成，覆盖首次安装、重复安装、升级、冲突保护和安装预览，不修改真实技能目录。临时目录在结果中打印并保留供检查。

`.codex-plugin/plugin.json` 仍保留为原生插件封装入口；本安装脚本只安装 Skill，不会让它出现在插件市场的已安装列表。无需同时进行两种安装。
