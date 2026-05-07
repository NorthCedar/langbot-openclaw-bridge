import { WeixinBot } from 'weixin-bot-sdk';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────

const TIMEOUT_MS = parseInt(process.env.BRIDGE_TIMEOUT_MS || '90000', 10);
const MAX_CONCURRENCY = parseInt(process.env.BRIDGE_MAX_CONCURRENCY || '5', 10);
const MOCK_MODE = process.argv.includes('--mock');
const LOG_DIR = path.resolve(process.env.BRIDGE_LOG_DIR || path.join(__dirname, 'logs'));
const CREDENTIALS_PATH = path.resolve(process.env.CREDENTIALS_PATH || path.join(__dirname, '.wx-credentials.json'));

// Trigger mode: 'at' (only when @bot), 'all' (all messages), 'keyword' (prefix keyword)
const TRIGGER_MODE = process.env.BRIDGE_TRIGGER_MODE || 'all';
const TRIGGER_KEYWORD = process.env.BRIDGE_TRIGGER_KEYWORD || '';

// ─── Logger ──────────────────────────────────────────────────────────────────

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function logFile() {
  return path.join(LOG_DIR, `bridge-${new Date().toISOString().slice(0, 10)}.log`);
}

function log(level, event, data = {}) {
  const entry = { ts: new Date().toISOString(), level, event, ...data };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else console.log(line);
  try { fs.appendFileSync(logFile(), line + '\n'); } catch (_) {}
}

function cleanOldLogs() {
  const retentionMs = 72 * 60 * 60 * 1000;
  const now = Date.now();
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      const fp = path.join(LOG_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > retentionMs) {
        fs.unlinkSync(fp);
        log('info', 'log_cleanup', { file: f });
      }
    }
  } catch (_) {}
}

// ─── Concurrency ─────────────────────────────────────────────────────────────

let activeRequests = 0;

// ─── OpenClaw Agent call ─────────────────────────────────────────────────────

function callAgent(sessionId, message) {
  return new Promise((resolve, reject) => {
    if (MOCK_MODE) {
      setTimeout(() => resolve(`[Mock] 收到: "${message.slice(0, 50)}"`), 300);
      return;
    }

    const args = [
      'agent',
      '--session-id', sessionId,
      '--message', message,
      '--json',
      '--timeout', String(Math.floor(TIMEOUT_MS / 1000))
    ];

    execFile('openclaw', args, {
      timeout: TIMEOUT_MS + 5000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env }
    }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed || err.code === 'ETIMEDOUT') return reject(new Error('timeout'));
        return reject(new Error(`cli_error: ${err.message}`));
      }
      try {
        const result = JSON.parse(stdout);
        const reply = result?.result?.message?.content
          || result?.message?.content
          || result?.text
          || stdout.trim();
        resolve(typeof reply === 'string' ? reply : JSON.stringify(reply));
      } catch (_) {
        resolve(stdout.trim() || '(无回复)');
      }
    });
  });
}

// ─── Message Processing ──────────────────────────────────────────────────────

function shouldProcess(msg) {
  // Only handle text messages
  if (msg.type !== 'text') return false;
  if (!msg.text || !msg.text.trim()) return false;

  if (TRIGGER_MODE === 'all') return true;

  if (TRIGGER_MODE === 'keyword') {
    return TRIGGER_KEYWORD && msg.text.trim().startsWith(TRIGGER_KEYWORD);
  }

  // 'at' mode — check if the message mentions the bot
  // iLink API may have @bot text in message content
  if (TRIGGER_MODE === 'at') {
    // Will be refined once we see actual group message format
    return true; // for now, process all (can refine after testing)
  }

  return false;
}

function extractMessage(msg) {
  let content = msg.text.trim();

  if (TRIGGER_MODE === 'keyword' && TRIGGER_KEYWORD) {
    if (content.startsWith(TRIGGER_KEYWORD)) {
      content = content.slice(TRIGGER_KEYWORD.length).trim();
    }
  }

  return content;
}

async function processMessage(msg, rawMsg, bot) {
  if (!shouldProcess(msg)) return;

  if (activeRequests >= MAX_CONCURRENCY) {
    log('warn', 'concurrency_limit', { active: activeRequests });
    return;
  }

  activeRequests++;
  const start = Date.now();

  try {
    const content = extractMessage(msg);
    if (!content) return;

    // Use from_user_id as session key (group or individual)
    const fromId = msg.from || 'unknown';
    const sessionId = `wechat-bridge:${fromId}`;

    log('info', 'msg_in', {
      from: fromId,
      type: msg.type,
      message_preview: content.slice(0, 50)
    });

    const reply = await callAgent(sessionId, content);
    const elapsed = Date.now() - start;

    log('info', 'msg_out', {
      from: fromId,
      response_ms: elapsed,
      reply_preview: (reply || '').slice(0, 50)
    });

    // Send reply
    if (reply && reply !== 'NO_REPLY' && reply !== 'HEARTBEAT_OK') {
      await bot.reply(msg, reply);
      log('info', 'reply_sent', { from: fromId });
    }
  } catch (err) {
    const elapsed = Date.now() - start;
    log('error', 'process_error', { error: err.message, response_ms: elapsed });

    if (err.message === 'timeout') {
      try { await bot.reply(msg, '处理超时了，请稍后再试~'); } catch (_) {}
    }
  } finally {
    activeRequests--;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  ensureLogDir();
  cleanOldLogs();

  const bot = new WeixinBot({
    credentialsPath: CREDENTIALS_PATH
  });

  bot.on('error', (err) => {
    log('error', 'bot_error', { error: err.message });
  });

  bot.on('login', (result) => {
    log('info', 'login_success', { result });
    console.log('✅ 微信登录成功！');
  });

  bot.on('session:expired', (code) => {
    log('warn', 'session_expired', { code });
    console.log('⚠️  Session 过期，需要重新扫码登录');
  });

  bot.on('message', async (msg, rawMsg) => {
    processMessage(msg, rawMsg, bot).catch(err => {
      log('error', 'message_handler_error', { error: err.message });
    });
  });

  // Login
  console.log('🔐 正在登录微信...');
  console.log(`📂 凭证文件: ${CREDENTIALS_PATH}`);

  try {
    await bot.login({
      onQrCode: (url) => {
        console.log('\n📱 请用微信扫描二维码:');
        console.log(`🔗 ${url}\n`);
        log('info', 'qrcode_generated', { url });
      }
    });
  } catch (err) {
    log('error', 'login_failed', { error: err.message });
    console.error('❌ 登录失败:', err.message);
    process.exit(1);
  }

  // Start polling
  bot.start();

  log('info', 'startup', {
    mode: MOCK_MODE ? 'mock' : 'live',
    trigger: TRIGGER_MODE,
    max_concurrency: MAX_CONCURRENCY
  });

  console.log(`🌉 Bridge 运行中 [${MOCK_MODE ? 'MOCK' : 'LIVE'}]`);
  console.log(`🎯 触发模式: ${TRIGGER_MODE}`);

  // Graceful shutdown
  const shutdown = () => {
    log('info', 'shutdown', { reason: 'signal' });
    bot.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
