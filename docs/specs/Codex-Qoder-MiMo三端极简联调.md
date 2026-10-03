# Codex/Qoder/MiMo 三端极简联调方案

## 需求概述

使用 Codex 作为 brain、Qoder 作为 reviewer、MiMo 作为 worker，在真实 IDE 原会话中完成一个固定文本文件任务，验证连接、唤醒、初审和终审闭环。

## 影响面分析

- 调度服务：新建一个桌面模式临时项目，不修改运行时源码。
- Codex：当前会话担任 brain，只负责登记、派单和终审。
- Qoder：独立原会话担任 reviewer，只读审核候选。
- MiMo：独立原会话担任 worker，只允许创建 `result.txt`。

## 边界与异常场景

- Qoder Hook 未安装或未生成 session descriptor：连接失败并记录，不自行安装。
- MiMo Desktop API 不可达或无可确定会话：连接失败并记录，不猜测 session ID。
- Codex 缺少真实 turn ID：保留 `attention` 证据，不伪造唤醒绑定。
- 任何端未 `park`：不启动工作，避免把绑定误当作可唤醒。
- 出现权限或登录对话框：不自动处理，记录为需用户操作。

## 选定方案

采用真实三 IDE 原会话唤醒，不使用本地模拟代替。任务的业务内容固定且极简，便于将耗时和失败定位到连接/唤醒链路。

## 实现流程

1. 在工作区 `tmp/` 下建立隔离测试目录。
2. 当前 Codex 会话 connect brain，登记 `mimo-worker`。
3. 生成 Qoder reviewer 与 MiMo worker 邀请，分别在真实 IDE 会话中接入。
4. 核对 provider、sessionId、wakeEnabled 和 armed，两端必须实际 park。
5. 用已获用户确认的 `start-work --confirmed` 启动，登记 `SMOKE-01`。
6. MiMo worker 写入并 submit，Qoder reviewer 初审，Codex brain 终审。
7. 核对文件、尝试数和最终状态，记录各阶段时间。
8. 结束临时项目，确认无活跃等待后清理测试目录。

## 验证方式

- 预期文件：`result.txt` 精确包含 `task-dispatch smoke ok` 加换行，UTF-8 无 BOM。
- 预期 provider：brain=`codex`，reviewer=`qoder`，worker=`mimo`。
- 预期状态：`SMOKE-01.state = accepted`。
- 预期尝试数：execution=1，review=2，total=3。

## 当前前置检查

- Qoder CN 和 Xiaomi MiMo 进程均在运行。
- MiMo 本地 API 可达；主仓库工作区有唯一匹配会话，计划中的临时子目录没有匹配会话。
- 已安装 QoderCN Skill 的 receipt 存在，但其 `qoder-hook.cjs` 不存在，服务 Qoder bridge 目录也不存在；当前无法校验或唤醒 Qoder reviewer。
- 当前 Codex 会话 cwd 是主仓库，不是临时子目录，不满足唤醒工作区精确匹配。
- 当前 Computer Use 环境未暴露原生 app 接口，无法代用户向 Qoder/MiMo 窗口粘贴邀请。

## 生成/修改记录

| 时间 | 模型 | 操作 | 摘要 |
| --- | --- | --- | --- |
| 2026-09-15 19:56 | GPT-5 | 创建 | 建立三 IDE 原会话联调技术说明初稿 |
| 2026-09-15 20:00 | GPT-5 | 更新 | 补充真实 IDE、Hook、工作区和 UI 可控性检查结果 |
