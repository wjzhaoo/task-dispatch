# 独立审核验证环境

## 可选低风险批量终审（未发布，默认关闭）

首版仅支持 desktop。普通项目继续逐项终审；明确登记固定里程碑后，worker、reviewer 仍逐项执行和初审，通过的成员保持未 accepted，待所有成员准备好才给 brain 一份 batch_review。正式终审期间整个项目停止新执行。

仅接受明确 risk=low、sharedInterfacesChanged=false、excludedRisksAbsent=true 的任务。最后一个声明表示已排除核心接口、权限、支付、迁移、联机一致性以及未明确风险；程序验证声明和结构，不能自动理解全部业务风险。成员须尚未开工，无成员间传递依赖，组外前置已通过，写路径互不重叠且不能覆盖其他成员的 readPaths。必须完整声明读取依赖，必须有在线初审员、可执行验证和 evidenceResult。仅静态审核不合格。

登记流程：先完成启动门禁并暂停项目，登记各成员 task；关闭前一阶段收尾，配置验证规则，再用 brain 凭据执行：

```powershell
node runtime/desktop-client.cjs batch-configure --enabled true --credential BRAIN.json --data SERVICE
node runtime/desktop-client.cjs batch-register --file BATCH.json --credential BRAIN.json --data SERVICE
```

然后恢复项目调度。BATCH.json 示例（A、B 是已登记且未开始的任务）：

```json
{
  "batchId": "milestone-1",
  "milestone": "独立输出验收",
  "independence": "两个独立文件，不改共享接口，无相互读取或依赖",
  "members": [
    {"taskId":"A","risk":"low","sharedInterfacesChanged":false,"excludedRisksAbsent":true,"readPaths":["package.json","package-lock.json","check.cjs"]},
    {"taskId":"B","risk":"low","sharedInterfacesChanged":false,"excludedRisksAbsent":true,"readPaths":["package.json","package-lock.json","check.cjs"]}
  ]
}
```

开始时冻结公共基线与成员契约；初审通过后保留每项候选和验证报告。服务验证复合候选只包含有来源的成员增量，后续成员不能覆盖已通过初审的交付。每项检查还会针对复合候选再执行；证据不足或检查失败不会交给模型猜测通过。审核目录提供 `.dispatch-evidence/batch.json` 和各成员修改前文件、验证输出。

`claim` 返回 kind=batch_review、batchId、attemptId、contractHash、compositeArtifactHash 和每项 artifactId。回执完整列出所有成员，身份字段必须原样对应：

```json
{
  "projectId":"项目ID","batchId":"milestone-1","attemptId":"领取时的ID","role":"brain",
  "contractHash":"领取时的契约摘要","compositeArtifactHash":"领取时的复合候选摘要",
  "members":[
    {"taskId":"A","artifactId":"A的原候选ID","verdict":"pass","summary":"验收依据","findings":[]},
    {"taskId":"B","artifactId":"B的原候选ID","verdict":"needs_fix","summary":"缺少必要内容","findings":[{"key":"missing","message":"具体路径、缺陷及必要修复"}]}
  ]
}
```

用 `batch-submit --file RESULT.json --credential BRAIN.json --data SERVICE` 提交。成员可分别 pass / needs_fix / blocked；缺项、重复、越权、旧候选、修改审核目录会整份拒绝。一笔持久提交应用全部合法分项；仅 pass 释放依赖，返修退出批次走普通单项链。整批只创建一次收尾待办，全部失败也需要收尾。

成员阻塞、初审断开、无可推进成员产生 batch_attention。修复绑定、处理成员或追加预算后，尚未准备共享审核的批次可 `batch-resume --batch ID`；不能自动绕过错误。未领取且无在途成员时，可 `batch-cancel --batch ID --reason TEXT`。已初审的成员须通过来源合并检查才能重建单项候选，保留原候选来源并重新初审；不放宽普通审核的全候选一致性。若存在污染，先核实并纠正污染；验证进程中断还须 `--confirmed-stopped`。

已领取批次不能取消或自动超时换人；需使用已有“确认旧会话停止”的接管流程。级联重置会同时预览并重置冻结成员和下游，并要求确认停止；旧回执随之失效。唤醒每个批次仅一个标识，送达不确定不自动重发，长时间未领取在看板显示异常。

项目管理员在菜单 7 → 3 配置审核验证环境，或运行 `configure-validation PROJECT_ID FILE.json`。配置示例为 `examples/redblueprint-validation.json`。配置会执行候选中的 npm 脚本，仅由管理端设置，执行员报告不能授权额外命令。

当前支持有 package-lock.json 的 npm 项目，依赖策略为 copy-node-modules：核对工作区 package.json/package-lock.json 与候选逐字节一致，复制现有 node_modules，校验复制前后内容摘要。不会联网安装、链接回原工作区或更改锁文件。缺少依赖、不匹配、链接式依赖（如 pnpm 链接布局）会阻塞，不猜测兼容。

审核候选继续只读。服务从同一 artifactId 创建 `validations/<attemptId>/tree`，运行显式配置的 npm run 检查，保存退出码与输出；完整报告复制到候选 `.dispatch-evidence/validation.json`。审核员查看服务检查证据，不再因只读候选中没有 node_modules 重复触发环境失败。验收范围仍由审核员判断，不因为测试全绿自动通过。

配置的 outputs（如 tmp/、coverage/）在验证目录重新创建，允许测试产生文件；源文件修改或未声明位置的新增文件阻止验证。旧临时产物、.keys/、.env 与 .env.* 不进入验证目录，排除清单和其中涉及本次变更的文件写入报告供审核。不应将源码目录声明成 outputs。测试涉及排除内容时需补充专用隔离夹具，不能假称覆盖。

依赖缺失与准备失败标记 `blockKind:environment`，保留 artifactId 和 brain 恢复阶段。修复环境后用普通 retry 重审，不使用 restart-worker。检查非零退出会作为失败证据交大脑分析，控制器拒绝在配置检查失败时接受 pass。中断标记 uncertain，需要确认测试子进程停止再重试。

运行脚本仍以当前 OS 用户执行，不是安全沙箱。可信命令和项目测试应使用隔离数据、不得调用真实模型或访问真实凭据。Windows 超时尝试终止已记录 PID 的进程树；异常退出仍按 uncertain 处理。

blocked 的处理入口为菜单 5 查看错误、菜单 7 → 3 配置环境、菜单 7 → 1 重试审核。当前不自动把环境问题派给执行员，也不会自动将任务判为通过。

## 结构化证据门禁（2026-09-22）

现有配置可增加 `evidenceResult`，例如 `tmp/evidence-result.json`。该路径必须是 outputs 内的相对文件路径，不能是目录、越界路径或链接。结果限制 1 MiB，协议为 version=1 和非空 checks 数组；每项有唯一 id、布尔 passed、errors 数组，失败项必须提供 path/message 定位，通过项不能携带错误。

服务把结果绑定到本次 artifactId/artifactHash；脚本自行提供的身份字段不被采纳。配置结果后，命令非零、结果缺失、结构错误或任一检查失败都会在模型取得审核任务前阻塞，标记 `blockKind:evidence`。仍会登记服务准备的审核 attempt，因此 attempt 数不等于实际模型调用数。未配置时报告 `evidence.status=not_configured`，保持旧验证规则。

各字段的事实来源由项目适配器明确，例如调用数以全局 ledger 为准、运行状态以 raw 为准；报告只作为派生数据。通用服务不内置小说业务字段，也不能证明脚本的断言足够覆盖业务。可运行的离线示例见 `examples/evidence-validation/README.md`。当前仍只支持既有 npm＋package-lock＋复制 node_modules 流程；纯 Python 项目未在本轮获得自动适配。

## 提交前预检与隔离

领取者可执行 `node runtime/desktop-client.cjs preflight --task TASK_ID --attempt ATTEMPT_ID --credential CREDENTIAL_FILE --data SERVICE_DIR`。仅允许当前绑定、已领取且未结算的 attempt；不领取任务、不生成候选、不写回执或修改任务状态。接口访问日志仍按现有监控记录。

worker 预检报告范围外路径、受保护计划/其他任务证据及未完成的恢复目标、Windows 保留文件名；审核角色报告输入的新增、修改、删除路径。返回列表各限 100 项，counts 给出总数。旧 attempt 使用兼容范围提示，最终仍以提交校验为准。预检通过不冻结文件，submit 必须重新验证当前候选，不能凭旧预检结果放行。

审核提交的完整差异保存在原回执的 reviewChanges，旧 reviewChanged 布尔字段继续兼容。展示错误最多列出前 20 项及 2000 字符；不要用展示截断推断其他路径没变化。验证树的源文件变更完整列表保存于 validation report 的 changedPaths。

审核员应读取 `.dispatch-evidence/validation.json`，不要在审核输入树运行会写缓存或数据的检查。配置的测试在独立 validations 树运行，临时目录在启动前创建；真实数据路径与缓存目录需由项目测试主动隔离。outputs 不得覆盖本次修改交付物。此机制不是操作系统沙箱，不能拦截测试脚本主动访问绝对路径；不能通过忽略整个数据或证据目录掩盖污染。
