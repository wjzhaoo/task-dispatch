# Codex Desktop 原会话唤醒验证

日期：2026-09-12。Windows 安装包：OpenAI.Codex_26.903.9818.0_x64。

## 结论

本机此版本的私有 native tools 管道可由独立 Node 进程调用，在原会话已结束回合且空闲时，通过 send_message_to_thread 启动下一轮。无需让目标模型持续等待。

测试目标是用户指定的「自动唤醒测试会话」，ID `01a09443-7d13-7de3-933a-060be18b9f38`。未修改正在试跑的项目或其他会话。

## 实测步骤与证据

1. 只读确认目标 idle，原回合 `01a09445-2cf7-75c3-b2e7-b0cbb3807e62` 已 completed。
2. 读取安装包实现，确认 native pipe 使用长度前缀 JSON，支持 tools/list、tools/call。
3. 本地 Node 进程执行 tools/list，找到 namespace=codex_app 下的 read_thread 和 send_message_to_thread。
4. 使用目标的真实 threadId 和已完成 turnId，从本地进程调用 read_thread，成功返回 idle 状态。没有伪造活跃回合。
5. 同一方式调用 send_message_to_thread，仅发送无文件操作的测试提示，返回 success=true。
6. 目标产生新回合 `01a09449-a6e2-72e0-8130-573e00e0a59e`，约 3.1 秒后 completed，回复 `自动唤醒成功 WAKE-PROBE-01`。

消息发送由 exec 启动的 Node 进程完成，没有调用模型侧 send_message_to_thread 工具。模型侧工具只用于定位目标和观察完成结果。

## 尚未验证的边界

- 这是私有入口，不是官方稳定外部 API；应用升级可能改变协议。
- 管道路径包含随机标识，不可写死。只读探测脚本为 scripts/probe-codex-desktop.cjs；它不发送唤醒消息。
- 本次目标为本地、已载入且空闲的测试会话。未验证 Desktop 关闭、重启、会话卸载和多窗口情况下的行为。
- 应用仍需运行。不能将单次成功描述为离线唤醒或操作系统开机唤醒。
- 等待阶段可交给本地服务，不需要目标模型轮询；新回合的输入、推理和回复仍消耗模型额度。
- ZCode 原会话唤醒未验证。

## 接入服务前需要补的工作

角色绑定增加显式的 Desktop threadId；仅允许向用户绑定的会话发送。派发通知需持久化、串行发送，成功后记录已通知；超时等不确定结果先检查是否已入会话，不能盲目重发。未领取任务保持在队列中，通知只是提醒而非任务状态的事实来源。重连时重新发现管道并核验工具能力，协议不兼容则停止通知并明确报错。

本次只完成接入验证，未改变 task-dispatch 的默认阻塞等待行为。
