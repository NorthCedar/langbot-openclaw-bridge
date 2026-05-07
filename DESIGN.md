# LangBot-OpenClaw Bridge 设计文档

## 概述

将 LangBot（Windows）收到的个人微信群消息，通过 HTTP 桥接服务转发到 OpenClaw Gateway（Ubuntu），实现"黄金藤椒大鸡腿"以完整能力（记忆、技能、工具调用、cron）参与个人微信群聊。

## 架构

```
┌──────────────┐          ┌──────────────────────┐          ┌─────────────────┐
│  个人微信群   │  ←───→   │  LangBot (Windows)    │  ──POST→  │  Bridge (Ubuntu) │
│  (群消息收发) │          │  n8n Webhook runner   │  ←JSON──  │  HTTP Server     │
└──────────────┘          └──────────────────────┘          └────────┬────────┘
                                                                     │ WebSocket
                                                                     ▼
                                                            ┌─────────────────┐
                                                            │ OpenClaw Gateway │
                                                            │ (完整 Agent)     │
                                                            └─────────────────┘
```

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
3. Bridge 解析发送者/群信息，构造 OpenClaw inbound envelope
4. Bridge 通过 WebSocket 注入 Gateway，等待 Agent 回复
5. Bridge 返回 HTTP Response（Agent 回复内容）给 LangBot
6. LangBot 将回复发送到微信群

### 出站格式

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

Bridge 返回：
```json
{
  "text": "Agent 的回复文本"
}
```

## 身份识别方案

### 群聊会话隔离

每个微信群对应一个独立的 OpenClaw session：
```
session key: agent:main:langbot-bridge:group:<group_id>
```

### 发送者标识

Bridge 注入消息时携带 inbound metadata：
```json
{
  "schema": "openclaw.inbound_meta.v2",
  "channel": "langbot-bridge",
  "provider": "langbot-bridge",
  "chat_type": "group",
  "chat_id": "group:<group_id>",
  "group_name": "群名称",
  "sender_id": "<sender_wxid>",
  "sender_name": "发送者昵称"
}
```

OpenClaw Agent 通过 inbound context 区分「来自哪个群」和「谁在说话」。

### 与私聊会话的隔离

- 群聊 session key 带 `langbot-bridge:group:` 前缀
- 私聊走原有 `openclaw-weixin` channel，session key 不同
- 两者完全独立，不会串

## 日志

### 路径
```
~/.openclaw/workspace/logs/langbot-bridge/
├── bridge-YYYY-MM-DD.log    # 每日轮转
```

### 保留策略
- 保留 **24 小时**
- 启动时自动清理超过 24h 的日志文件

### 日志内容
每条记录为 JSON line：
```json
{
  "ts": "2026-05-07T13:20:00.000Z",
  "level": "info",
  "event": "inbound",
  "group_id": "xxx",
  "group_name": "某群",
  "sender_id": "wxid_xxx",
  "sender_name": "张三",
  "message": "今天股市怎么样",
  "response_ms": 3200
}
```

## Bridge 服务技术栈

| 项目 | 选择 | 理由 |
|------|------|------|
| 语言 | Node.js | 与 OpenClaw 生态一致，WebSocket 原生支持 |
| HTTP 框架 | 内置 `http` 模块 | 零依赖，一个文件搞定 |
| WebSocket | `ws` 包 | OpenClaw Gateway 标准 WS 库 |
| 进程管理 | systemd service | 开机自启，崩溃自动重启 |

## 文件结构

```
~/.openclaw/workspace/langbot-bridge/
├── bridge.js            # 主服务（~150行）
├── config.json          # 配置（端口、Gateway地址、auth token）
├── package.json
└── README.md
```

## config.json

```json
{
  "port": 8780,
  "gateway": {
    "url": "ws://127.0.0.1:39922",
    "authToken": "<从 openclaw config get gateway.auth.token 获取>"
  },
  "timeout_ms": 60000,
  "log": {
    "dir": "~/.openclaw/workspace/logs/langbot-bridge",
    "retention_hours": 24
  }
}
```

## LangBot 端配置

### Pipeline 设置

1. 创建新 Pipeline
2. AI runner 选择 **n8n Workflow API**
3. Webhook URL 填：`http://<ubuntu-ip>:8780/webhook/langbot`
4. Response Mode：同步

### Bot 设置

1. 平台：OpenClaw 微信
2. 绑定到上述 Pipeline
3. 群聊触发：@机器人 或 关键词

## 安全

- Bridge 仅监听来自 LangBot 的请求（可选 IP 白名单或 Bearer Token）
- Gateway auth token 不外泄，仅 Bridge 本地使用
- 群消息中的私人信息不落盘到 MEMORY.md（遵循 AGENTS.md 群聊规则）

## 后续扩展

- [ ] 支持图片/文件消息透传
- [ ] 支持 @特定人回复
- [ ] 支持多 Agent 路由（不同群用不同人设）
- [ ] LangBot 原生支持 OpenClaw Gateway 后可去掉 Bridge

## 部署步骤（简要）

### Ubuntu 端
1. `cd ~/.openclaw/workspace/langbot-bridge && npm install`
2. 填写 `config.json`
3. `sudo systemctl enable langbot-bridge && sudo systemctl start langbot-bridge`

### Windows 端
1. 部署 LangBot（`uvx langbot`）
2. 配置微信适配器 → 小号扫码
3. 配置 Pipeline → n8n Webhook → 填 Bridge URL
4. 把小号拉进目标群

