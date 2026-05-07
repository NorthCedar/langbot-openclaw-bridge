# LangBot-OpenClaw Bridge

将 LangBot（Windows）收到的个人微信群消息，通过 HTTP 桥接服务转发到 OpenClaw Gateway（Ubuntu），实现完整 AI Agent 能力参与个人微信群聊。

## 架构

```
微信群 → LangBot (Win) → HTTP Webhook → Bridge (Ubuntu) → OpenClaw Gateway → 完整 Agent 处理 → 回复
```

## 文档

- [DESIGN.md](./DESIGN.md) — 详细设计文档

## 状态

🚧 开发中

## License

MIT
