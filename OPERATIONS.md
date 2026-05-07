# GeWeChat-OpenClaw Bridge 运维手册

## 快速命令

```bash
# 服务管理
sudo systemctl start langbot-bridge
sudo systemctl stop langbot-bridge
sudo systemctl restart langbot-bridge
sudo systemctl status langbot-bridge

# 日志
journalctl -u langbot-bridge -f
tail -f logs/bridge-$(date +%Y-%m-%d).log

# 健康检查
curl http://127.0.0.1:8780/health

# 微信在线状态
curl http://127.0.0.1:8780/status

# 获取登录二维码（掉线重登时用）
curl http://127.0.0.1:8780/login
```

## GeWeChat Docker 管理

```bash
# 查看容器状态
docker ps | grep gewe

# 查看日志
docker logs gewe --tail 50

# 重启容器
docker restart gewe

# 停止/启动
docker stop gewe
docker start gewe
```

## 首次部署流程

1. **启动 GeWeChat Docker**
   ```bash
   mkdir -p /root/temp
   docker pull registry.cn-hangzhou.aliyuncs.com/gewe/gewe:latest
   docker tag registry.cn-hangzhou.aliyuncs.com/gewe/gewe gewe
   docker run -itd -v /root/temp:/root/temp -p 2531:2531 -p 2532:2532 \
     --privileged=true --name=gewe --restart=always gewe /usr/sbin/init
   ```

2. **获取 Token**
   ```bash
   curl -X POST http://127.0.0.1:2531/v2/api/login/getToken
   # → 记录返回的 token
   ```

3. **创建 .env**
   ```bash
   cp .env.example .env
   # 填入 GEWECHAT_TOKEN
   ```

4. **启动 Bridge (mock 模式测试)**
   ```bash
   node bridge.js --mock
   curl http://127.0.0.1:8780/health
   ```

5. **获取二维码 & 登录**
   ```bash
   curl http://127.0.0.1:8780/login
   # 手机微信扫码
   # 登录成功后更新 .env: GEWECHAT_APP_ID 和 BOT_WXID
   ```

6. **设置消息回调**
   ```bash
   curl -X POST http://127.0.0.1:8780/callback/set \
     -H "Content-Type: application/json" \
     -d '{"callbackUrl": "http://127.0.0.1:8780/callback"}'
   ```

7. **切换到 live 模式**
   ```bash
   # 去掉 --mock，重启服务
   sudo systemctl start langbot-bridge
   ```

8. **验证**：在目标群 @机器人 发消息，观察日志和回复。

## 故障排查

| 现象 | 排查步骤 |
|------|---------|
| 群消息无回复 | 1. `curl /health` 看 Bridge 是否活 → 2. `curl /status` 看微信是否在线 → 3. 看日志是否有 msg_in → 4. 检查回调地址是否设置 |
| 回复慢 (>30s) | 看日志 response_ms，可能是 Agent 工具调用耗时 |
| 微信掉线 | `curl /login` 重新获取二维码扫码 |
| GeWeChat 容器挂了 | `docker restart gewe`，等几秒后 `curl /status` |
| Bridge 启动报错 | 检查 .env 是否填完、Node.js 版本是否 ≥18 |

## 注意事项

- GeWeChat **要求同省服务器**，否则可能触发微信异地登录检测
- 微信小号不要是主力号，有封号风险
- 日志自动清理 72 小时，问题排查请及时查看
- Bridge 无状态，重启不丢数据
