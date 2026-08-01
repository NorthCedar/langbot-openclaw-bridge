# LangBot-OpenClaw Bridge

将 LangBot（Windows）收到的个人微信群消息，通过 HTTP 桥接服务转发到 OpenClaw Gateway（Ubuntu），实现完整 AI Agent 能力参与个人微信群聊。

## 架构

```
微信群 → LangBot (Win) → HTTP Webhook → Bridge (Ubuntu) → OpenClaw Gateway → 完整 Agent 处理 → 回复
```

## 快速部署

### 1. 配置

```bash
cp .env.example .env
# 编辑 .env，设置 BRIDGE_TOKEN
```

### 2. 启动

```bash
node bridge.js
```

### 3. 安装系统服务（可选）

```bash
sudo cp langbot-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now langbot-bridge
```

## LangBot 配置

在 LangBot 的 n8n Webhook runner 中配置：

| 配置项 | 值 |
|--------|-----|
| **URL** | `http://<服务器IP>:8780/webhook/langbot` |
| **Method** | `POST` |
| **Content-Type** | `application/json` |
| **Authorization** | `Bearer <BRIDGE_TOKEN>` |

### ⚠️ 防火墙

确保服务器防火墙已开放 TCP **8780** 端口。

## 接口

### POST /webhook/langbot

```json
{
  "message": "用户消息",
  "session_id": "group_<id>",
  "launcher_type": "group",
  "launcher_id": "<群ID>",
  "sender_id": "<发送者微信ID>",
  "sender_name": "昵称",
  "group_name": "群名"
}
```

响应：
```json
{ "text": "Agent 回复" }
```

### GET /health

```json
{ "status": "ok", "active": 0, "uptime": 12345 }
```

## 文档

- [DESIGN.md](./DESIGN.md) — 详细设计文档

## License

MIT
