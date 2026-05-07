# LangBot-OpenClaw Bridge

将 LangBot（Windows）收到的个人微信群消息，通过 HTTP 桥接服务转发到 OpenClaw Gateway（Ubuntu），实现完整 AI Agent 能力参与个人微信群聊。

## 架构

```
微信群 → LangBot (Win) → HTTP POST → Bridge (Ubuntu) → OpenClaw Gateway → 完整 Agent → 回复
```

## Quick Start

```bash
cp .env.example .env    # 按需填写配置
node bridge.js --mock   # Mock 模式启动
curl http://localhost:8780/health  # 验证
```

## 文档

| 文档 | 内容 |
|------|------|
| [DESIGN.md](./DESIGN.md) | 架构设计、技术决策、安全方案 |
| [OPERATIONS.md](./OPERATIONS.md) | 部署、运维、排障手册 |

## 状态

🚧 开发中 — Mock 模式可用，Live 模式待接入

## License

MIT
