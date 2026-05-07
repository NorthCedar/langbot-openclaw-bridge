# LangBot-OpenClaw Bridge 设计文档

## 概述

将 LangBot（Windows）收到的个人微信群消息，通过 HTTP 桥接服务转发到 OpenClaw Gateway（Ubuntu），实现"黄金藤椒大鸡腿"以完整能力（记忆、技能、工具调用、cron）参与个人微信群聊。

## 架构

```
┌──────────────┐          ┌──────────────────────┐          ┌─────────────────┐
│  个人微信群   │  ←───→   │  LangBot (Windows)    │  ──POST→  │  Bridge (Ubuntu) │
│  (群消息收发) │          │  n8n Webhook runner   │  ←JSON──  │  HTTP Server     │
└──────────────┘          └──────────────────────┘          └────────┬────────┘
                                                                     │ CLI/子进程
                                                                     ▼
                                                            ┌─────────────────┐
                                                            │ OpenClaw Gateway │
                                                            │ (完整 Agent)     │
                                                            └─────────────────┘
```

## 设计原则

1. **轻量** — 单文件服务，最少依赖，内存占用 < 30MB
2. **稳定** — 无状态设计，崩溃自动恢复，不影响 Gateway 主进程
3. **安全** — 最小权限，token 不外泄，请求验证
4. **可观测** — 结构化日志，关键指标可追踪

## 网络拓扑

| 组件 | 位置 | 地址 |
|------|------|------|
| LangBot | Windows 主机 | `<win-ip>:5300`（管理面板） |
| Bridge 服务 | Ubuntu 服务器 | `0.0.0.0:8780`（对外接收 Webhook） |
| OpenClaw Gateway | Ubuntu 服务器 | `127.0.0.1:39922`（本机 WebSocket） |

## 消息流

### 入站（群消息 → OpenClaw）

1. LangBot 收到微信群消息
2. LangBot Pipeline（n8n Webhook runner）POST 到 Bridge：
   ```
   POST http://<ubuntu-ip>:8780/webhook/langbot
   Content-Type: application/json
   ```
3. Bridge 校验请求合法性（IP/Token）
4. Bridge 调用 `openclaw agent` CLI 注入消息，指定 session-id 实现群隔离
5. Bridge 等待 CLI 返回 Agent 回复（--json 模式）
6. Bridge 返回 HTTP Response 给 LangBot
7. LangBot 将回复发送到微信群

### 与 Gateway 通信方式

**选择 CLI 子进程（`openclaw agent`）而非 WebSocket 直连：**

| 对比 | CLI 子进程 | WebSocket 直连 |
|------|-----------|---------------|
| 复杂度 | 低，调用一个命令 | 高，需实现协议 |
| 稳定性 | 高，无连接状态维护 | 需心跳/重连逻辑 |
| 兼容性 | 随 OpenClaw 升级自动兼容 | 协议变更需同步改 |
| 性能开销 | 每次 fork 一个进程（~50ms） | 长连接，零 fork |
| 适用场景 | 群聊消息（QPS < 1） | 高频消息流 |

群聊场景 QPS 极低（远 < 1/s），CLI 方式的 50ms fork 开销可忽略。

### 入站格式

LangBot POST body（n8n Webhook 标准格式）：
```json
{
  "message": "用户发送的消息文本",
  "session_id": "group_<group_id>",
  "launcher_type": "group",
  "launcher_id": "<group_id>",
  "sender_id": "<sender_wxid>",
  "sender_name": "发送者昵称",
  "group_name": "群名称",
  "msg_create_time": 1678000000
}
```

### 出站格式

Bridge 返回给 LangBot：
```json
{
  "text": "Agent 的回复文本"
}
```

## 身份识别方案

### 群聊会话隔离

每个微信群对应一个独立的 OpenClaw session：
```
session-id: langbot-bridge:group:<group_id>
```

CLI 调用示例：
```bash
openclaw agent \
  --session-id "langbot-bridge:group:12345678" \
  --message "[sender_name] 说：消息内容" \
  --json
```

### 发送者标识

消息注入时在 message 前缀中携带发送者信息：
```
[张三@某群] 今天股市怎么样
```

OpenClaw Agent 通过消息前缀区分「谁在说话」。

### 与私聊会话的隔离

- 群聊 session-id 带 `langbot-bridge:group:` 前缀
- 私聊走原有 `openclaw-weixin` channel
- 两者完全独立，不会串

## 稳定性设计

### 超时控制

```
┌─────────────────────────────────────────────────┐
│           LangBot HTTP 超时: 120s               │
│  ┌───────────────────────────────────────────┐  │
│  │      Bridge → CLI 超时: 90s               │  │
│  │  ┌─────────────────────────────────────┐  │  │
│  │  │   Gateway Agent 处理: ≤ 60s         │  │  │
│  │  └─────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

- LangBot HTTP timeout: **120s**（给足余量）
- Bridge CLI timeout: **90s**（`--timeout 90`）
- Gateway Agent 内部: 默认 60s
- 超时后 Bridge 返回降级回复，不挂起

### 并发控制

- 最大并发请求数: **5**（防止 Gateway 过载）
- 超过上限返回 HTTP 429，LangBot 侧可配重试
- 实现方式：简单计数器 + Promise

### 进程管理（systemd）

```ini
[Unit]
Description=LangBot-OpenClaw Bridge
After=network.target openclaw-gateway.service
Wants=openclaw-gateway.service

[Service]
Type=simple
ExecStart=/usr/bin/node /root/.openclaw/workspace/langbot-bridge/bridge.js
Restart=always
RestartSec=3
StartLimitBurst=5
StartLimitIntervalSec=60
Environment=NODE_ENV=production

# 资源限制
MemoryMax=128M
CPUQuota=50%

[Install]
WantedBy=default.target
```

### 错误处理策略

| 错误类型 | 处理方式 |
|---------|---------|
| CLI 执行超时 | kill 子进程，返回 "处理超时，请稍后再试" |
| CLI 非零退出 | 记录日志，返回 "服务暂时不可用" |
| Gateway 不可达 | 记录日志，返回 503 |
| 请求格式错误 | 返回 400 + 错误描述 |
| 并发超限 | 返回 429 "繁忙，请稍后" |

### 健康检查

- `GET /health` — 返回服务状态 + Gateway 可达性
- systemd watchdog: 定期检测进程存活
- 日志中记录每分钟请求计数和平均响应时间

## 资源占用预估

| 指标 | 预估值 |
|------|--------|
| 常驻内存 | ~15MB（Node.js 空载） |
| 单请求峰值 | +5MB（CLI 子进程临时） |
| CPU（空闲） | ~0% |
| CPU（处理中） | < 2%（只是转发） |
| 磁盘 | 日志 ~1MB/天 |
| 网络 | 可忽略（本机通信 + 低频 HTTP） |

## 日志

### 路径
```
~/.openclaw/workspace/logs/langbot-bridge/
├── bridge-YYYY-MM-DD.log    # 每日轮转
```

### 保留策略
- 保留 **72 小时**（3天，方便排查问题）
- 每日 00:00 自动清理过期日志

### 日志级别

| 级别 | 记录内容 |
|------|---------|
| info | 请求进出、响应时间 |
| warn | 超时、重试、降级 |
| error | CLI 失败、未知异常 |

### 日志格式
每条记录为 JSON line：
```json
{
  "ts": "2026-05-07T13:20:00.000Z",
  "level": "info",
  "event": "request",
  "group_id": "xxx",
  "group_name": "某群",
  "sender_id": "wxid_xxx",
  "sender_name": "张三",
  "message_preview": "今天股市...",
  "response_ms": 3200,
  "status": "ok"
}
```

**注意：日志中消息只记前 50 字符（preview），不记全文，减少磁盘和隐私风险。**

## 安全

### 请求验证（三选一，按需配置）

1. **IP 白名单** — 只允许 LangBot 所在 IP
2. **Bearer Token** — 请求头携带共享密钥
3. **两者都开** — 最严格

### 其他

- Gateway auth token 仅存在 config.json，不经网络传输（CLI 直接读本地配置）
- Bridge 不存储任何消息内容（无状态）
- 群消息中的私人信息不落盘到 MEMORY.md（遵循 AGENTS.md 群聊规则）

## 技术栈

| 项目 | 选择 | 理由 |
|------|------|------|
| 语言 | Node.js | 与 OpenClaw 生态一致 |
| HTTP 框架 | 内置 `http` 模块 | 零额外依赖 |
| 子进程 | 内置 `child_process` | 调用 `openclaw agent` CLI |
| 进程管理 | systemd user service | 开机自启，崩溃自动重启，资源限制 |
| 依赖 | **零 npm 依赖** | 减少供应链风险，降低维护成本 |

## 文件结构

```
~/.openclaw/workspace/langbot-bridge/
├── bridge.js            # 主服务（~200行）
├── config.json          # 配置
├── package.json         # 元信息（无依赖）
├── DESIGN.md            # 本文档
├── README.md
└── langbot-bridge.service  # systemd unit file
```

## 配置

运行时通过环境变量或本地 `.env` 文件提供敏感信息，**不入仓库**。

### 环境变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `BRIDGE_PORT` | 监听端口 | `8780` |
| `BRIDGE_AUTH_TOKEN` | LangBot 请求验证密钥 | 随机字符串 |
| `BRIDGE_ALLOWED_IPS` | 允许的来源 IP（逗号分隔） | `192.168.1.100` |
| `BRIDGE_TIMEOUT_MS` | CLI 超时（毫秒） | `90000` |
| `BRIDGE_MAX_CONCURRENCY` | 最大并发数 | `5` |

### config.json（仅非敏感配置，可入仓库）

```json
{
  "port": 8780,
  "gateway": {
    "timeout_ms": 90000
  },
  "concurrency": {
    "max": 5
  },
  "log": {
    "dir": "./logs",
    "retention_hours": 72,
    "message_preview_len": 50
  }
}
```

### .env（本地，不入仓库）

```env
BRIDGE_AUTH_TOKEN=your-shared-secret
BRIDGE_ALLOWED_IPS=192.168.1.100,10.0.0.5
```
```

## LangBot 端配置

### Pipeline 设置

1. 创建新 Pipeline
2. AI runner 选择 **n8n Workflow API**
3. Webhook URL 填：`http://<ubuntu-ip>:8780/webhook/langbot`
4. Response Mode：同步
5. Timeout: 120s

### Bot 设置

1. 平台：微信（个人号适配器）
2. 绑定到上述 Pipeline
3. 群聊触发规则：
   - @机器人触发
   - 或指定关键词前缀
   - 或白名单群全量触发

## 部署步骤

### Ubuntu 端
1. 代码已就位：`~/.openclaw/workspace/langbot-bridge/`
2. 填写 `config.json`（auth token、允许 IP）
3. 安装 systemd service：
   ```bash
   cp langbot-bridge.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable langbot-bridge
   systemctl --user start langbot-bridge
   ```
4. 验证：`curl http://127.0.0.1:8780/health`

### Windows 端
1. 部署 LangBot（`uvx langbot`）
2. 配置微信适配器 → 小号扫码
3. 配置 Pipeline → n8n Webhook → 填 Bridge URL
4. 把小号拉进目标群
5. 测试：在群里 @小号 发消息

## 监控与运维

### 日常检查
```bash
# 服务状态
systemctl --user status langbot-bridge

# 最近日志
tail -20 ~/.openclaw/workspace/logs/langbot-bridge/bridge-$(date +%Y-%m-%d).log

# 健康检查
curl http://127.0.0.1:8780/health
```

### 常见问题排查

| 现象 | 排查 |
|------|------|
| 群里发消息无回复 | 1. LangBot 是否在线 2. Bridge 日志有无请求 3. health 端点是否正常 |
| 回复很慢（>30s） | 看 response_ms，可能 Gateway Agent 处理重（工具调用多） |
| 间歇性 503 | Gateway 可能重启了，Bridge 会自动重试 |

## 后续扩展

- [ ] 支持图片/文件消息透传（Base64 或 URL）
- [ ] 支持 @特定人回复（LangBot at 格式）
- [ ] 支持多 Agent 路由（不同群用不同 agent-id）
- [ ] Gateway HTTP API 可用后可替换 CLI 调用（减少 fork 开销）
- [ ] LangBot 原生支持 OpenClaw Gateway 后可去掉 Bridge
