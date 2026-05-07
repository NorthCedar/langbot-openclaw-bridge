# GeWeChat-OpenClaw Bridge 设计文档

## 概述

通过 GeWeChat Docker 容器接入个人微信，Bridge 服务接收消息回调并调用 OpenClaw Agent CLI，实现完整 AI 能力参与个人微信群聊。

**不再依赖 LangBot / Windows。** 全部组件运行在同一台 Ubuntu 服务器上。

## 架构

```
┌──────────────┐  消息回调POST  ┌─────────────────────────┐  CLI子进程  ┌──────────────┐
│  GeWeChat    │ ─────────────→ │  Bridge (Node.js)        │ ──────────→ │  OpenClaw    │
│  Docker容器  │ ←── REST API ─ │  port 8780               │ ←────────── │  Gateway     │
│  port 2531   │               │  收回调 + 发消息 + 管理   │             │  port 39922  │
└──────────────┘               └─────────────────────────┘             └──────────────┘
        ↕
   个人微信群
```

## 组件说明

| 组件 | 位置 | 端口 | 职责 |
|------|------|------|------|
| GeWeChat Docker | Ubuntu 本机 | 2531(API) / 2532(文件) | 微信协议层，扫码登录，收发消息 |
| Bridge | Ubuntu 本机 | 8780 | 接收 GeWeChat 回调、调 OpenClaw CLI、调 GeWeChat API 发回复 |
| OpenClaw Gateway | Ubuntu 本机 | 39922 | 完整 Agent 能力（记忆/技能/工具） |

## 消息流

### 入站（群消息 → AI 回复）

1. 微信群有人 @机器人 发消息
2. GeWeChat 容器收到消息，POST 回调到 Bridge (`http://127.0.0.1:8780/callback`)
3. Bridge 判断触发条件（@bot / 关键词 / 白名单群）
4. Bridge 先返回 200（不阻塞 GeWeChat 回调）
5. Bridge 异步调用 `openclaw agent --session-id "langbot-bridge:group:<群id>" --message "..." --json`
6. 等待 CLI 返回 Agent 回复
7. Bridge 调用 GeWeChat REST API 将回复发送到群

### 为什么先返回 200 再异步处理

GeWeChat 回调有超时限制（~5s），而 Agent 处理可能需要 10-60s。如果同步等待会导致回调超时，GeWeChat 可能重试或丢弃。

## 触发机制

通过环境变量 `BRIDGE_TRIGGER_MODE` 控制：

| 模式 | 说明 | 环境变量 |
|------|------|---------|
| `at` (默认) | 仅 @机器人 时响应 | `BRIDGE_TRIGGER_MODE=at` |
| `keyword` | 消息以指定关键词开头时响应 | `BRIDGE_TRIGGER_MODE=keyword` + `BRIDGE_TRIGGER_KEYWORD=鸡腿` |
| `all` | 群内所有消息都响应（慎用） | `BRIDGE_TRIGGER_MODE=all` |

群白名单：`BRIDGE_GROUP_WHITELIST=wxid_group1@chatroom,wxid_group2@chatroom`

## 身份隔离

- 每个群一个独立 session：`langbot-bridge:group:<group_wxid>`
- 消息格式：`[发送者昵称@群名] 消息内容`
- 与私聊 session 完全隔离

## 超时与并发

```
┌───────────────────────────────────────────────────┐
│         Bridge CLI 超时: 90s                      │
│  ┌─────────────────────────────────────────────┐  │
│  │     OpenClaw Agent 内部处理: ≤ 60s          │  │
│  └─────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘
```

- CLI 超时：90s（环境变量 `BRIDGE_TIMEOUT_MS=90000`）
- 最大并发：5 路（`BRIDGE_MAX_CONCURRENCY=5`）
- 超过并发限制：静默丢弃（不回复）

## GeWeChat Docker 部署

```bash
# 拉取镜像
docker pull registry.cn-hangzhou.aliyuncs.com/gewe/gewe:latest
docker tag registry.cn-hangzhou.aliyuncs.com/gewe/gewe gewe

# 启动容器
mkdir -p /root/temp
docker run -itd \
  -v /root/temp:/root/temp \
  -p 2531:2531 -p 2532:2532 \
  --privileged=true \
  --name=gewe \
  --restart=always \
  gewe /usr/sbin/init

# 验证启动
docker logs gewe
# 看到 "启动GIN服务成功！ http://0.0.0.0:8849" 即成功
```

⚠️ **重要提示：**
- GeWeChat 要求服务器与微信账号**同省**（或使用同省代理），否则有异地登录风险
- 首次部署后需获取 Token 和 AppId（通过 API）
- 需要服务器能访问外网

## Bridge 服务端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/login` | 获取登录二维码 |
| GET | `/status` | 检查微信在线状态 |
| POST | `/callback/set` | 设置 GeWeChat 回调地址 |
| POST | `/callback` | 接收 GeWeChat 消息回调 |
| POST | `/webhook/gewechat` | 同上（别名） |

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BRIDGE_PORT` | Bridge 监听端口 | `8780` |
| `GEWECHAT_BASE_URL` | GeWeChat API 地址 | `http://127.0.0.1:2531` |
| `GEWECHAT_TOKEN` | GeWeChat X-GEWE-TOKEN | (必填) |
| `GEWECHAT_APP_ID` | GeWeChat 设备 AppId | (必填) |
| `BOT_WXID` | 机器人微信号 wxid | (登录后填) |
| `BRIDGE_TIMEOUT_MS` | CLI 超时(ms) | `90000` |
| `BRIDGE_MAX_CONCURRENCY` | 最大并发 | `5` |
| `BRIDGE_TRIGGER_MODE` | 触发模式 | `at` |
| `BRIDGE_TRIGGER_KEYWORD` | 关键词(keyword模式) | (空) |
| `BRIDGE_GROUP_WHITELIST` | 群白名单(逗号分隔) | (空=全部) |
| `BRIDGE_LOG_DIR` | 日志目录 | `./logs` |

## systemd 服务

```ini
[Unit]
Description=GeWeChat-OpenClaw Bridge
After=network.target docker.service

[Service]
Type=simple
ExecStart=/usr/bin/node /root/.openclaw/workspace/langbot-bridge/bridge.js
Restart=always
RestartSec=3
StartLimitBurst=5
StartLimitIntervalSec=60
EnvironmentFile=/root/.openclaw/workspace/langbot-bridge/.env
Environment=NODE_ENV=production
MemoryMax=128M
CPUQuota=50%

[Install]
WantedBy=multi-user.target
```

## 日志

- 路径：`./logs/bridge-YYYY-MM-DD.log`
- 格式：JSON line
- 保留：72 小时自动清理
- 消息预览：仅记前 50 字符

## 安全

- GeWeChat Token 仅存在 `.env`，不入仓库
- Bridge 仅监听本地回调（GeWeChat 同机），无外部暴露需求
- OpenClaw Gateway auth 由 CLI 自动读取本地配置
- 无状态：不持久化任何消息内容

## 部署步骤

### 1. 启动 GeWeChat Docker
见上方"GeWeChat Docker 部署"

### 2. 获取 Token
```bash
# 获取 GeWeChat token
curl -X POST http://127.0.0.1:2531/v2/api/login/getToken
# 返回 {"token": "xxx"} → 填入 .env
```

### 3. 获取二维码 & 登录
```bash
# 首次登录获取二维码
curl http://127.0.0.1:8780/login
# 返回二维码信息，用手机微信扫码

# 登录成功后记录 appId 和 botWxid → 填入 .env
```

### 4. 设置回调地址
```bash
curl -X POST http://127.0.0.1:8780/callback/set \
  -H "Content-Type: application/json" \
  -d '{"callbackUrl": "http://127.0.0.1:8780/callback"}'
```

### 5. 启动 Bridge
```bash
# 开发/测试
node bridge.js --mock

# 生产（systemd）
sudo cp langbot-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now langbot-bridge
```

### 6. 验证
```bash
curl http://127.0.0.1:8780/health
curl http://127.0.0.1:8780/status
```

## 文件结构

```
langbot-bridge/
├── bridge.js                # 主服务
├── DESIGN.md                # 本文档
├── OPERATIONS.md            # 运维手册
├── README.md
├── package.json
├── langbot-bridge.service   # systemd unit
├── .env.example             # 环境变量模板
├── .gitignore
└── logs/                    # 日志（不入仓库）
```

## 后续扩展

- [ ] 支持图片/文件消息（Base64 或 GeWeChat 文件 URL）
- [ ] 支持 @特定人回复
- [ ] 多 Agent 路由（不同群用不同 agent-id）
- [ ] 断线自动重连（监控 GeWeChat 在线状态）
- [ ] 管理面板（Web UI 查看状态/日志）
