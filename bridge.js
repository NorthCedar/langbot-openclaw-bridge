'use strict';

const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.BRIDGE_PORT || '8780', 10);
const AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || '';
const ALLOWED_IPS = (process.env.BRIDGE_ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
const TIMEOUT_MS = parseInt(process.env.BRIDGE_TIMEOUT_MS || '90000', 10);
const MAX_CONCURRENCY = parseInt(process.env.BRIDGE_MAX_CONCURRENCY || '5', 10);
const MOCK_MODE = process.argv.includes('--mock');

const LOG_DIR = path.resolve(process.env.BRIDGE_LOG_DIR || './logs');

// ─── Logger ──────────────────────────────────────────────────────────────────

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function logFile() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `bridge-${date}.log`);
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

// ─── Auth & IP check ─────────────────────────────────────────────────────────

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
}

function isAuthorized(req) {
  // IP check
  if (ALLOWED_IPS.length > 0) {
    const ip = getClientIP(req).replace('::ffff:', '');
    if (!ALLOWED_IPS.includes(ip)) return false;
  }
  // Token check
  if (AUTH_TOKEN) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${AUTH_TOKEN}`) return false;
  }
  return true;
}

// ─── OpenClaw Agent call ─────────────────────────────────────────────────────

function callAgent(sessionId, message) {
  return new Promise((resolve, reject) => {
    if (MOCK_MODE) {
      // Mock: echo back with prefix
      setTimeout(() => {
        resolve(`[Mock] 收到消息: "${message.slice(0, 50)}"`);
      }, 500);
      return;
    }

    const args = [
      'agent',
      '--session-id', sessionId,
      '--message', message,
      '--json',
      '--timeout', String(Math.floor(TIMEOUT_MS / 1000))
    ];

    const child = execFile('openclaw', args, {
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024, // 1MB
      env: { ...process.env }
    }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed || err.code === 'ETIMEDOUT') {
          return reject(new Error('timeout'));
        }
        return reject(new Error(`cli_error: ${err.message}`));
      }
      try {
        const result = JSON.parse(stdout);
        // Extract assistant reply from JSON output
        const reply = result?.result?.message?.content
          || result?.message?.content
          || result?.text
          || stdout.trim();
        resolve(typeof reply === 'string' ? reply : JSON.stringify(reply));
      } catch (_) {
        // Fallback: use raw stdout
        resolve(stdout.trim() || '(无回复)');
      }
    });
  });
}

// ─── HTTP Handler ────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 64 * 1024) { req.destroy(); reject(new Error('body_too_large')); }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function handleWebhook(req, res) {
  const start = Date.now();

  // Auth
  if (!isAuthorized(req)) {
    log('warn', 'unauthorized', { ip: getClientIP(req) });
    return sendJSON(res, 403, { error: 'Forbidden' });
  }

  // Concurrency
  if (activeRequests >= MAX_CONCURRENCY) {
    log('warn', 'concurrency_limit', { active: activeRequests });
    return sendJSON(res, 429, { error: '繁忙，请稍后再试' });
  }

  activeRequests++;
  try {
    // Parse body
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch (_) {
      return sendJSON(res, 400, { error: 'Invalid JSON' });
    }

    const { message, sender_name, sender_id, group_name, launcher_id } = body;
    if (!message) {
      return sendJSON(res, 400, { error: 'Missing "message" field' });
    }

    const groupId = launcher_id || body.session_id || 'unknown';
    const sessionId = `langbot-bridge:group:${groupId}`;

    // Build agent message with sender context
    const agentMessage = sender_name
      ? `[${sender_name}@${group_name || '群聊'}] ${message}`
      : message;

    log('info', 'request', {
      group_id: groupId,
      group_name: group_name || '',
      sender_id: sender_id || '',
      sender_name: sender_name || '',
      message_preview: message.slice(0, 50)
    });

    // Call agent
    const reply = await callAgent(sessionId, agentMessage);
    const elapsed = Date.now() - start;

    log('info', 'response', {
      group_id: groupId,
      response_ms: elapsed,
      reply_preview: reply.slice(0, 50),
      status: 'ok'
    });

    return sendJSON(res, 200, { text: reply });
  } catch (err) {
    const elapsed = Date.now() - start;
    log('error', 'handler_error', { error: err.message, response_ms: elapsed });

    if (err.message === 'timeout') {
      return sendJSON(res, 200, { text: '处理超时，请稍后再试~' });
    }
    return sendJSON(res, 200, { text: '服务暂时不可用，请稍后再试' });
  } finally {
    activeRequests--;
  }
}

function handleHealth(req, res) {
  const status = {
    ok: true,
    mode: MOCK_MODE ? 'mock' : 'live',
    active_requests: activeRequests,
    uptime_s: Math.floor(process.uptime())
  };
  sendJSON(res, 200, status);
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const { method, url } = req;

  if (method === 'GET' && url === '/health') {
    return handleHealth(req, res);
  }
  if (method === 'POST' && url === '/webhook/langbot') {
    return handleWebhook(req, res);
  }

  sendJSON(res, 404, { error: 'Not Found' });
});

server.listen(PORT, '0.0.0.0', () => {
  ensureLogDir();
  cleanOldLogs();
  log('info', 'startup', { port: PORT, mode: MOCK_MODE ? 'mock' : 'live', max_concurrency: MAX_CONCURRENCY });
  console.log(`🌉 Bridge listening on 0.0.0.0:${PORT} [${MOCK_MODE ? 'MOCK' : 'LIVE'}]`);
});

server.on('error', (err) => {
  log('error', 'server_error', { error: err.message });
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('info', 'shutdown', { reason: 'SIGTERM' });
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  log('info', 'shutdown', { reason: 'SIGINT' });
  server.close(() => process.exit(0));
});
