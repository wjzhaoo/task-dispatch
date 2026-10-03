# 向其他 AI 会话发送消息方法

> 记录如何通过 opencode HTTP API 向 CodeArts IDE 中指定的 AI 会话发送消息。

## 一、整体流程

```
┌─────────────────────────────────────────────────────────────┐
│                    向目标会话发送消息                          │
└─────────────────────────────────────────────────────────────┘

  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
  │ 1. 定位会话   │ ──> │ 2. 定位服务   │ ──> │ 3. 获取认证   │
  │   数据库      │     │   端口        │     │   凭据        │
  └──────────────┘     └──────────────┘     └──────────────┘
                                                  │
                                                  v
  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
  │ 5. 接收响应   │ <── │ 4. 发送消息   │ <── │  构造请求     │
  │   解析回复    │     │   (HTTP API) │     │  (UTF-8)     │
  └──────────────┘     └──────────────┘     └──────────────┘
```

## 二、关键路径与组件

```
C:\Users\Lenovo\.codeartsdoer\
├── codearts-data\
│   ├── opencode.db              ← 会话数据库（SQLite）
│   └── log\
│       └── kernel_output_*.log  ← 服务启动日志（含端口信息）
├── CodeArts_Agent\
│   └── Vscode_*\
│       └── server_config.properties  ← 服务配置（pid/port）
└── ai-ide\
    └── codeagent.json           ← IDE 配置
```

## 三、详细步骤

### 步骤 1：定位会话数据库

会话数据存储在 SQLite 数据库中：

```
路径: C:\Users\Lenovo\.codeartsdoer\codearts-data\opencode.db
表名: session
关键字段: id, title, time_updated
```

查询标题为"测试唤醒"的会话：

```python
import sqlite3

conn = sqlite3.connect(r'C:\Users\Lenovo\.codeartsdoer\codearts-data\opencode.db')
cur = conn.cursor()
cur.execute("SELECT id, title FROM session WHERE title = '测试唤醒'")
row = cur.fetchone()
print(f"会话ID: {row[0]}, 标题: {row[1]}")
conn.close()
```

### 步骤 2：定位 AgentKernel 服务端口

AgentKernel 是 opencode 的 HTTP API 服务器，通过两种方式定位端口：

**方式 A — 读取配置文件：**

```
路径: C:\Users\Lenovo\.codeartsdoer\CodeArts_Agent\Vscode_<版本>\server_config.properties
内容: port=15737
```

**方式 B — 查找进程命令行：**

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match "AgentKernel.*serve" } |
  Select-Object ProcessId, CommandLine
```

输出示例：
```
CommandLine: ...AgentKernel.exe --port=15737 serve
```

### 步骤 3：获取 API 认证凭据

服务器使用 **HTTP Basic Authentication**。凭据存储在 AgentKernel 进程的环境变量中：

```powershell
$proc = Get-Process -Id <AgentKernel_PID>
$envVars = $proc.StartInfo.EnvironmentVariables
# 关键变量：
# OPENCODE_SERVER_USERNAME = codearts
# OPENCODE_SERVER_PASSWORD = <UUID 格式的密码>
```

> **注意：** 即使日志显示 "password is not set; server is unsecured"，
> 服务器仍会返回 `401 Unauthorized` 并要求 Basic Auth。
> 响应头包含 `WWW-Authenticate: Basic realm="Secure Area"`。

### 步骤 4：发送消息

API 端点：`POST /session/{session_id}/message`

请求格式：

```json
{
  "parts": [
    { "type": "text", "text": "你好" }
  ]
}
```

> **编码关键：** 必须以 UTF-8 编码发送请求体，否则中文会变成乱码。
> Windows 下 curl 容易出现编码问题，建议使用 Python 发送。

### 步骤 5：解析响应

响应为 JSON，包含 AI 的推理过程和最终回复：

```json
{
  "info": { "role": "assistant", "modelID": "GLM-5.2", ... },
  "parts": [
    { "type": "reasoning", "text": "..." },
    { "type": "text", "text": "你好！请问有什么可以帮您的？" }
  ]
}
```

## 四、完整脚本

```python
"""
向 CodeArts IDE 中指定标题的 AI 会话发送消息。
依赖：仅使用 Python 标准库（urllib, sqlite3, json, base64）。
"""
import urllib.request
import json
import base64
import sqlite3
import re
import subprocess
import os


# ── 配置 ──────────────────────────────────────────────
DB_PATH = os.path.expanduser(
    r'~\.codeartsdoer\codearts-data\opencode.db'
)
TARGET_TITLE = '测试唤醒'   # 目标会话标题
MESSAGE_TEXT = '你好'       # 要发送的消息


# ── 步骤 1：查询会话 ID ───────────────────────────────
def find_session_id(db_path, title):
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("SELECT id FROM session WHERE title = ?", (title,))
    row = cur.fetchone()
    conn.close()
    if not row:
        raise ValueError(f"未找到标题为 '{title}' 的会话")
    return row[0]


# ── 步骤 2：定位服务端口 ──────────────────────────────
def find_server_port():
    # 从 server_config.properties 读取
    base = os.path.expanduser(r'~\.codeartsdoer\CodeArts_Agent')
    for name in os.listdir(base):
        cfg = os.path.join(base, name, 'server_config.properties')
        if os.path.isfile(cfg):
            with open(cfg) as f:
                for line in f:
                    if line.startswith('port='):
                        return int(line.split('=')[1].strip())
    raise RuntimeError("未找到服务端口配置")


# ── 步骤 3：获取认证凭据 ──────────────────────────────
def get_credentials(port):
    # 通过 netstat 找到监听该端口的 PID
    result = subprocess.run(
        ['netstat', '-ano'], capture_output=True, text=True
    )
    pid = None
    for line in result.stdout.splitlines():
        if f'127.0.0.1:{port}' in line and 'LISTENING' in line:
            pid = line.strip().split()[-1]
            break
    if not pid:
        raise RuntimeError(f"未找到监听端口 {port} 的进程")

    # 通过 PowerShell 读取进程环境变量
    ps_script = (
        f"$p = Get-Process -Id {pid}; "
        f"$e = $p.StartInfo.EnvironmentVariables; "
        f"Write-Output ($e['OPENCODE_SERVER_USERNAME'] + ':' "
        f"+ $e['OPENCODE_SERVER_PASSWORD'])"
    )
    result = subprocess.run(
        ['powershell', '-Command', ps_script],
        capture_output=True, text=True
    )
    return result.stdout.strip()


# ── 步骤 4：发送消息 ─────────────────────────────────
def send_message(port, credentials, session_id, text):
    url = f'http://127.0.0.1:{port}/session/{session_id}/message'
    auth = base64.b64encode(credentials.encode()).decode()

    payload = json.dumps(
        {'parts': [{'type': 'text', 'text': text}]},
        ensure_ascii=False
    ).encode('utf-8')

    req = urllib.request.Request(url, data=payload, method='POST')
    req.add_header('Content-Type', 'application/json; charset=utf-8')
    req.add_header('Authorization', 'Basic ' + auth)

    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode('utf-8'))


# ── 步骤 5：解析回复 ─────────────────────────────────
def extract_reply(response):
    for part in response.get('parts', []):
        if part.get('type') == 'text':
            return part.get('text', '')
    return '(无文本回复)'


# ── 主流程 ───────────────────────────────────────────
if __name__ == '__main__':
    session_id = find_session_id(DB_PATH, TARGET_TITLE)
    print(f"[1] 会话ID: {session_id}")

    port = find_server_port()
    print(f"[2] 服务端口: {port}")

    credentials = get_credentials(port)
    print(f"[3] 认证凭据: {credentials.split(':')[0]}:***")

    print(f"[4] 发送消息: {MESSAGE_TEXT}")
    response = send_message(port, credentials, session_id, MESSAGE_TEXT)

    reply = extract_reply(response)
    print(f"[5] AI回复: {reply}")
```

## 五、注意事项

| 项目 | 说明 |
|------|------|
| **编码** | 必须用 UTF-8 发送请求体，Windows 下 curl 易出乱码，建议用 Python |
| **认证** | Basic Auth，凭据在进程环境变量 `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` |
| **端口** | 从 `server_config.properties` 读取，或从进程命令行 `--port=N` 提取 |
| **会话存在性** | 发送前先在 `opencode.db` 的 `session` 表中确认目标会话存在 |
| **响应等待** | API 为同步调用，需等待 AI 生成完整回复后才返回（建议 timeout ≥ 60s） |
| **密码变动** | `OPENCODE_SERVER_PASSWORD` 为 UUID 格式，每次服务重启可能变化 |
| **工作目录** | 目标会话的 `directory` 字段决定 AI 的工作目录，非当前会话目录 |

## 六、API 速查

```
GET  /session                          → 列出所有会话
POST /session/{id}/message             → 向指定会话发送消息
     Body: {"parts":[{"type":"text","text":"消息内容"}]}
     Auth: Basic (username:password)
     响应: {"info":{...}, "parts":[{type:"reasoning",...},{type:"text",...}]}
```