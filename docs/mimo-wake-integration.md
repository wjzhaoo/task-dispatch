# MiMo 原会话唤醒：接入缺口

依据用户提供的 `mimo跨会话通信方案.md` 和 `cli接口/codex-app-server-vs-mimo-desktop.md`。

当前状态：平台分流已准备，MiMo 发送适配器尚未启用。`--provider mimo` 会明确报错，不能回落到 Codex，也不会静默启动 MiMo CLI 的另一份会话。

## 给 MiMo 侧的验证任务

请验证“独立本地程序唤醒已结束回合的 MiMo Desktop 原会话”，不要只由一个仍运行的模型调用 talk_to_session。

1. 提供现有 Desktop 实例的外部连接入口：HTTP、命名管道、插件桥接或官方 CLI attach。给出如何发现地址、鉴权方式、版本信息。不要把真实密码或 token 写进文档。
2. 提供只读 contacts/会话查询的完整请求和脱敏返回，至少包含稳定 session ID、workspace、idle/busy 状态。如果是 SDK，给出准确包名、版本和连接现有实例的示例。
3. 提供独立程序异步发送消息的完整示例：优先 contact_id，mode=async。明确返回“已接收/已排队”与“已完成”的区别。示例须针对专门测试会话，不操作生产会话。
4. 原文禁止向自己发送：说明外部程序是否需要源会话 ID，能否在源模型回合结束后继续使用，是否必须创建中继会话。不能用伪造身份绕过规则。
5. 说明 5 跳限制如何计数：多轮 task-dispatch 派发是否累积跳数，外部发送是否开启新的链。不得假设无限返修兼容。
6. 提供只读历史查询方式，以唯一通知标识确认超时请求是否已送达。若无法查询，明确不支持；调度器会保守停止重发，交用户恢复。
7. 说明 MiMo 所在电脑与任务服务是否同机。现有服务仅监听本机，且任务快照依赖本机文件系统；另一台电脑不能直接填 localhost 或把 J: 路径当作本机路径。

验收证据：关闭测试会话当前模型回合 → 独立程序发送唯一标记 → Desktop 原会话出现新消息和回复。保留调用返回、目标 ID、前后状态。不要借 Capability `/v1/chat/completions` 替代会话唤醒，也不要仅启动 `mimo run -s` 后就宣称 Desktop 窗口已恢复。

## 调度器对接约定

完成外部入口验证后，MiMo adapter 将只读查询规范化为 `{thread:{id,cwd,status:{type:'idle'|'active'}},turns:[...]}`；发送方法使用 MiMo 自己的真实协议，以 session ID 定位，异步送达。以上是 task-dispatch 内部约定，不是声称 MiMo 已提供此 JSON API。

绑定按 provider + session ID 隔离；MiMo 不要求 Codex turnId。角色、任务、通知去重、park/claim/submit、超时停止重发继续复用现有实现。未验证的 provider 拒绝绑定。
