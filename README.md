# WeChat-OpenClaw Bridge

将 OpenClaw Agent 完整能力接入个人微信群聊的桥接服务。

## 状态

🚧 **方案选型中** — 详见 [DESIGN.md](./DESIGN.md)

## 目标

- 个人微信小号进群，@它时调用 OpenClaw Agent 回复
- Agent 具备完整能力（记忆、技能、工具调用、cron）
- 部署在 Linux 服务器，无需 Windows

## 当前进展

已调研并排除 4 个不可行方案，确定 wechatbot-webhook (web 微信协议) 为待验证方案。
