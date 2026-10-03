# Quick Flow：桌面三端冒烟测试

本模板验证当前桌面会话流程：brain 规划与终审、reviewer 初审、worker 执行，以及三端的唤醒续接。它不使用旧 CLI/headless 菜单，也不自动创建会话。

推荐使用 Codex brain、Qoder reviewer、MiMo worker；也可在 Codex、MiMo、Qoder/QoderCN 之间调整。三个角色必须是独立真实会话，并打开同一个测试项目目录。QoderCN 的安装参数是 `qodercn`，连接 provider 仍为 `qoder`。

## 准备

1. 建立一个没有 `input.txt`、`output.txt` 的测试目录，并让三个宿主会话都直接打开该目录。仅在终端中 `cd` 不算宿主工作区一致。
2. 确认三个宿主已安装本 Skill；安装器当前只支持 `codex`、`mimo`、`qoder`、`qodercn`。
3. 记录本仓库 `runtime/desktop-client.cjs` 的绝对路径。`start.bat` 是桌面客户端的 Windows 包装入口；需要查看任务看板或管理服务时使用独立的 `dashboard.bat`。

新建桌面项目后会看到可识别的标识，例如：

```text
projectId: desktop-quick-flow-a1b2c3d4
credential: quick-flow-a1b2c3d4-brain-11223344.json
clientId: quick-flow-a1b2c3d4-brain-55667788
```

末尾短摘要用于区分同名目录，不要手工改写这些标识。

## 第一阶段：只连接

把下面提示词发给 brain，并替换两个占位符：

```text
请使用 $task-dispatch 执行 quick-flow 桌面三端冒烟测试。
测试项目：<三个宿主共同打开的项目绝对路径>
模板目录：<本 README 所在目录绝对路径>

现在只做连接准备，不得 plan、不得创建 T01/T02，也不得代替我确认开始。

1. 用 desktop-client connect 将当前真实会话接为 brain，必须显式传 `--provider <当前真实平台>`；核对返回的 workspace、projectId、provider、wakeEnabled 和 nextAction。
2. 读取模板 staffing.json，通过 staff --file 原样登记 quick worker；不要修改 workerId 或 capability。
3. 将客户端生成的 reviewerInvite 和 workerInvites 原样分别交给独立 reviewer、worker 会话。各接收端自行明确追加真实 `--provider`，大脑不得代填或猜测。wake 平台还须使用宿主提供的真实 session ID，不读取或展示令牌。
4. reviewer 和 worker 连接后实际执行 resume；首次 resume 也必须显式 provider，已有 continuation 后才可省略复用。配置成功的唤醒端必须 park。返回 attention 时处理真实缺项，不静默降级为 wait。
5. 三端分别报告 projectId、workspace、role、provider、wakeEnabled、armed/parked。三端必须属于同一个项目，且 projectId 应含测试目录名和路径短摘要。
6. 所有端就绪后停止派发，等待我明确回复“开始测试”。

角色边界：brain 只规划、派发、终审和收尾；reviewer 只读初审；worker 只修改任务允许的文件。项目无任务或 idle:true 不代表测试完成。
```

## 第二阶段：明确开始

确认三端已经连接并 park 后，给 brain 发送：

```text
三端已就绪，开始测试。

先用 status 核对三端仍属于同一 workspace/projectId，唤醒端已 armed。然后用 brain 凭据执行 start-work --confirmed。

读取模板 T01.json、T02.json：先 plan T01；T01 终审 accepted 后，领取 planning 待办，登记 T02，再以 outcome=planned、nextTaskIds=["T02"] 完成 closeout。不要提前登记或执行 T02，也不要重写任务内容。

T02 终审 accepted 后，领取最终 planning 待办并确认没有后续授权任务。随后直接使用 brain 凭据执行：
node "<desktop-client.cjs>" finish-project --credential "<brain 凭据>" --data "<服务目录>"

不要再调用 runtime/cli.cjs，也不要虚构 T03。只有返回 completed:true 才算项目结束。

最终分别报告：任务交接是否通过；三端是否各有一次 park → 通知 → claim → submit 的真实证据。wake-bind 成功或 armed:true 不能单独证明唤醒闭环。
```

## 固定任务

| 任务 | 唯一可写文件 | 结果 | 前置条件 |
| --- | --- | --- | --- |
| T01 | `input.txt` | `1` | 用户明确开始，三端就绪 |
| T02 | `output.txt` | `2` | T01 accepted 且阶段 closeout 完成 |

```mermaid
flowchart LR
  A[三端连接并 park] --> B[用户明确开始]
  B --> C[T01 worker 执行]
  C --> D[reviewer 初审]
  D --> E[brain 终审]
  E --> F[closeout 登记 T02]
  F --> G[T02 双审]
  G --> H[brain 凭据结束项目]
```

正常双审共 6 次任务尝试，顺序是 `worker → reviewer → brain`，连接、staffing、planning 和 closeout 不计入这 6 次。

## 验收

| 检查项 | 通过证据 |
| --- | --- |
| 工作区一致 | 三个宿主真实目录与服务 workspace 完全相同 |
| 手动开始 | 用户发令前任务列表为空，发令后才出现 T01 |
| 串行依赖 | T01 accepted 并 closeout 后才登记/执行 T02 |
| 双审门禁 | 每个任务都是 reviewer pass 后进入 brain 终审 |
| 唤醒闭环 | 三端各有通知标记、对应 claimedAt 和 submit 结果 |
| 项目结束 | desktop-client 的 `finish-project` 返回 completed:true |

若某端没有可用唤醒协议，本模板的“完整唤醒测试”不成立；可另做 wait 模式的任务交接测试，但必须明确标为部分通过，不能把手动提醒算作自动唤醒。

只做不调用模型的协议回归时，在仓库根目录运行：

```powershell
node --test tests/pre-review.test.cjs tests/wake.test.cjs tests/desktop.test.cjs
```
