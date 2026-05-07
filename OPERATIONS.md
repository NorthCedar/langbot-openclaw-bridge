# Operations Guide

## 启动

```bash
# Mock 模式（测试链路）
cd ~/.openclaw/workspace/langbot-bridge
node bridge.js --mock

# Live 模式（接入 OpenClaw）
node bridge.js
```

## systemd 服务管理

```bash
# 安装
cp langbot-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable langbot-bridge
systemctl --user start langbot-bridge

# 状态 / 重启 / 停止
systemctl --user status langbot-bridge
systemctl --user restart langbot-bridge
systemctl --user stop langbot-bridge

# 实时日志
journalctl --user -u langbot-bridge -f
```

## 健康检查

```bash
curl http://127.0.0.1:8780/health
# {"ok":true,"mode":"mock","active_requests":0,"uptime_s":123}
```

## 手动测试

```bash
curl -X POST http://127.0.0.1:8780/webhook/langbot \
  -H "Content-Type: application/json" \
  -d '{"message":"你好","sender_name":"姜姜","launcher_id":"group1","group_name":"测试群"}'
```

## 日志

```bash
# 今天的日志
tail -20 logs/bridge-$(date +%Y-%m-%d).log

# 格式化查看
cat logs/bridge-$(date +%Y-%m-%d).log | python3 -m json.tool --no-ensure-ascii

# 只看错误
grep '"level":"error"' logs/bridge-*.log
```

日志保留 72 小时，自动清理。

## 配置修改

```bash
vim .env
systemctl --user restart langbot-bridge
```

## Mock ↔ Live 切换

编辑 systemd service 文件的 `ExecStart` 行：

```bash
vim ~/.config/systemd/user/langbot-bridge.service

# Mock: ExecStart=/usr/bin/node .../bridge.js --mock
# Live: ExecStart=/usr/bin/node .../bridge.js

systemctl --user daemon-reload
systemctl --user restart langbot-bridge
```

## 常见问题

| 现象 | 排查 |
|------|------|
| 群里无回复 | 1. LangBot 在线？ 2. `curl /health` 正常？ 3. 日志有请求记录？ |
| 回复慢 (>30s) | 日志看 `response_ms`，可能 Agent 工具调用多 |
| 403 Forbidden | 检查 `.env` 中 `BRIDGE_ALLOWED_IPS` 和 `BRIDGE_AUTH_TOKEN` |
| 429 Too Many | 并发超限，等一会或调大 `BRIDGE_MAX_CONCURRENCY` |
