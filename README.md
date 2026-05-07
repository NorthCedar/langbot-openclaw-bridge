# GeWeChat-OpenClaw Bridge

Lightweight bridge service that connects GeWeChat (personal WeChat Docker framework) to OpenClaw Gateway, enabling full AI agent capabilities in WeChat group chats.

## Architecture

```
WeChat Groups ↔ GeWeChat Docker ──callback──→ Bridge ──CLI──→ OpenClaw Agent
                                 ←─REST API──         ←─────
```

## Features

- **Full AI capabilities** — memory, skills, tools, cron, all accessible in group chat
- **Zero npm dependencies** — uses only Node.js built-in modules
- **Trigger modes** — @bot, keyword prefix, or all messages
- **Group whitelist** — restrict to specific groups
- **Session isolation** — each group gets its own OpenClaw session
- **Auto log cleanup** — 72-hour retention
- **Concurrency control** — configurable max parallel requests
- **Health checks** — built-in `/health` and `/status` endpoints

## Quick Start

1. Deploy GeWeChat Docker (see [OPERATIONS.md](./OPERATIONS.md))
2. Copy `.env.example` to `.env` and fill in values
3. `node bridge.js --mock` (test mode)
4. `node bridge.js` (production)

## Documentation

- [DESIGN.md](./DESIGN.md) — Architecture and design decisions
- [OPERATIONS.md](./OPERATIONS.md) — Deployment and operations guide

## Requirements

- Node.js ≥ 18
- GeWeChat Docker container running on same machine
- OpenClaw Gateway running and accessible via CLI

## Environment Variables

See [.env.example](./.env.example) for all available configuration options.

## License

MIT
