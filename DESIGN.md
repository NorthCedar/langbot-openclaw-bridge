# 微信群聊 AI 接入 — 设计文档

## 需求

将 OpenClaw Agent（完整能力：记忆、技能、工具调用、cron）接入个人微信群聊。

**硬性要求：**
- 用个人微信号（小号）进群，群里 @它 能回复
- Agent 回复必须走 OpenClaw Gateway，不是简单文本转发
- 不依赖企业微信 / 公众号
- 部署在现有腾讯云 Ubuntu 服务器（广州机房）

## 方案调研 & 试错记录

### ❌ 方案 1：openclaw-weixin 插件

- **原理**：OpenClaw 自带微信插件
- **结论**：**不支持群聊**，仅支持单聊
- **验证方式**：文档确认

### ❌ 方案 2：LangBot + n8n Webhook Pipeline

- **原理**：LangBot(Win) 接微信 → Pipeline 设为 n8n Webhook → POST 到 Ubuntu Bridge → 调 OpenClaw
- **结论**：**LangBot 面板无 Webhook Pipeline 选项**。唯一的微信适配器走的是 openclaw-weixin (ilinkai.weixin.qq.com)，不暴露自定义转发配置
- **验证方式**：实际进入 LangBot 管理面板确认
- **教训**：未验证"面板有这个选项"就设计了整套架构

### ❌ 方案 3：GeWeChat Docker（iPad 协议）

- **原理**：Docker 容器跑微信 iPad 协议，REST API 收发消息，Bridge 接收回调
- **结论**：**设备库域名 `devicelibrary.cn2.luto.cc` 已下线（DNS NXDomain）**，pact 服务无法启动，登录流程完全不可用
- **验证方式**：实际部署 Docker，tcpdump 抓包确认 DNS 解析失败
- **教训**：未提前检查项目活跃度和外部服务可用性

### ❌ 方案 4：weixin-bot-sdk（iLink Bot API）

- **原理**：微信官方 iLink Bot API，Node.js SDK，扫码即用
- **结论**：**iLink Bot 是独立 Bot 身份，不是个人号登录，不能被拉进微信群**
- **验证方式**：实际运行出二维码后，分析 API 文档确认其为 Bot 通道而非个人号通道
- **教训**：看到"零封号""官方 API"就推荐，没确认"能不能进群"

### ✅ 方案 5：wechatbot-webhook（web 微信协议）— 待部署验证

- **原理**：基于 wechaty（web 微信协议），Docker 部署，个人号扫码登录，收到消息 POST 到外部 webhook URL
- **代码确认**：
  - `src/wechaty/init.js`：底层用 WechatyBuilder，监听 `message` 事件，有 `room-join`/`room-leave` 事件处理
  - `src/service/msgUploader.js`：收到消息后 POST 到 `RECVD_MSG_API`，payload 包含 `source.room`（群信息含 memberList）、`source.from`（发送者）、消息内容
  - 支持返回 response 快捷回复
- **已确认能力**：收群消息 ✅、发送者识别 ✅、webhook 转发 ✅、Docker 部署 ✅
- **已知限制**：
  - 基于 web 微信协议，**约 2 天掉线一次**需重新扫码
  - 部分微信号无法登录 web 微信（新号/被限制的号）
  - 不支持发语音、自定义表情等高级功能
- **状态**：待实际部署验证

## 方案对比

| 维度 | LangBot | GeWeChat | iLink Bot | wechatbot-webhook |
|------|---------|----------|-----------|-------------------|
| 个人号进群 | ❓ 未验证 | ✅ 设计上支持 | ❌ 不支持 | ✅ 代码确认 |
| 服务可用 | ✅ | ❌ 设备库下线 | ✅ | ✅ |
| Webhook 转发 | ❌ 无此选项 | ✅ 回调机制 | ❌ 非此用途 | ✅ RECVD_MSG_API |
| 封号风险 | 低(iPad) | 中(iPad) | 无 | 中(web协议) |
| 稳定性 | — | — | 高 | 低(~2天掉线) |
| 部署复杂度 | 高(Win+Ubuntu) | 高(Docker+MySQL+Redis) | 低(npm) | 中(Docker) |
| 项目活跃度 | 活跃 | ❌ 停止维护 | 活跃 | 活跃(2024.12最后更新) |
| 是否需要 Windows | 是 | 否 | 否 | 否 |

## 方案 5 架构（待实施）

```
┌──────────────┐  RECVD_MSG_API POST  ┌──────────────────┐  CLI  ┌──────────────┐
│  wechatbot-  │ ──────────────────→  │  Bridge          │ ────→ │  OpenClaw    │
│  webhook     │ ←── HTTP response ── │  (Node.js)       │ ←──── │  Gateway     │
│  (Docker)    │                      │  port 8780       │       │  port 39922  │
│  port 3001   │                      └──────────────────┘       └──────────────┘
└──────────────┘
      ↕
  个人微信群
```

**消息流：**
1. 群内有人发消息
2. wechatbot-webhook 通过 web 微信协议收到
3. POST 到 Bridge (`RECVD_MSG_API=http://127.0.0.1:8780/webhook`)
4. Bridge 解析消息（提取群ID、发送者、内容）
5. Bridge 调用 `openclaw agent --session-id "wechat-bridge:group:<roomId>" --message "..." --json`
6. Agent 回复返回
7. Bridge 通过 HTTP response 返回回复文本（wechatbot-webhook 的快捷回复机制）
8. wechatbot-webhook 将回复发到群

**身份隔离：** 每个群独立 session key `wechat-bridge:group:<room_id>`

## 待验证项（方案 5）

- [ ] 实际 Docker 部署能否正常启动
- [ ] 小号能否登录 web 微信
- [ ] 群消息的 webhook payload 具体结构（确认 room/from 字段）
- [ ] 快捷回复机制是否支持异步（Agent 处理可能 10-60s）
- [ ] 2 天掉线后重登流程是否可自动化

## 环境现状

- Docker 已安装（v29.4.3）
- OpenClaw Gateway 运行中（127.0.0.1:39922）
- Node.js v22.22.2 可用
