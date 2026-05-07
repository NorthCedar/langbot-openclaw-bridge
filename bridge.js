'use strict';

const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.BRIDGE_PORT || '8780', 10);
const GEWECHAT_BASE_URL = process.env.GEWECHAT_BASE_URL || 'http://127.0.0.1:2531';
const GEWECHAT_TOKEN = process.env.GEWECHAT_TOKEN || '';
const GEWECHAT_APP_ID = process.env.GEWECHAT_APP_ID || '';
const TIMEOUT_MS = parseInt(process.env.BRIDGE_TIMEOUT_MS || '90000', 10);
const MAX_CONCURRENCY = parseInt(process.env.BRIDGE_MAX_CONCURRENCY || '5', 10);
const MOCK_MODE = process.argv.includes('--mock');
const LOG_DIR = path.resolve(process.env.BRIDGE_LOG_DIR || './logs');

// Trigger mode: 'at' (only when @bot), 'all' (all group messages), 'keyword' (prefix keyword)
const TRIGGER_MODE = process.env.BRIDGE_TRIGGER_MODE || 'at';
const TRIGGER_KEYWORD = process.env.BRIDGE_TRIGGER_KEYWORD || '';
// Comma-separated whitelist of group wxids; empty = allow all
const GROUP_WHITELIST = (process.env.BRIDGE_GROUP_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean);

// Bot's own wxid (set after login, used to detect @self)
let botWxid = process.env.BOT_WXID || '';

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

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

function httpRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 10000
    };
    const req = mod.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (_) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('http_timeout')); });
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

// ─── GeWeChat API ────────────────────────────────────────────────────────────

async function gewechatAPI(endpoint, payload = {}) {
  const url = `${GEWECHAT_BASE_URL}/v2/api/${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-GEWE-TOKEN': GEWECHAT_TOKEN
  };
  const res = await httpRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    timeout: 15000
  });
  return res.data;
}

/**
 * Send text message via GeWeChat
 * @param {string} toWxid - recipient wxid (group or contact)
 * @param {string} text - message text
 * @param {string[]} [ats] - wxids to @ in group
 */
async function sendTextMessage(toWxid, text, ats = []) {
  const payload = {
    appId: GEWECHAT_APP_ID,
    toWxid,
    content: text
  };
  if (ats.length > 0) {
    payload.ats = ats;
  }
  return gewechatAPI('message/postText', payload);
}

/**
 * Get login QR code from GeWeChat
 * @param {string} [appId] - existing appId for re-login
 */
async function getLoginQR(appId) {
  const payload = appId ? { appId } : {};
  return gewechatAPI('login/getLoginQrCode', payload);
}

/**
 * Check login status
 */
async function checkOnline() {
  const payload = { appId: GEWECHAT_APP_ID };
  return gewechatAPI('login/checkOnline', payload);
}

/**
 * Set message callback URL
 * @param {string} callbackUrl
 */
async function setCallback(callbackUrl) {
  const payload = {
    appId: GEWECHAT_APP_ID,
    token: '', // optional verification token
    callbackUrl
  };
  return gewechatAPI('tools/setCallback', payload);
}

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
      timeout: TIMEOUT_MS + 5000, // extra buffer for CLI startup
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

/**
 * Determine if a message should trigger the bot
 */
function shouldProcess(msg) {
  // Only handle text messages (type 1)
  if (msg.msgType !== 1 && msg.type !== 1) return false;

  // Must be a group message (from wxid ending with @chatroom)
  const fromWxid = msg.fromWxid || msg.from_wxid || '';
  if (!fromWxid.endsWith('@chatroom')) return false;

  // Group whitelist
  if (GROUP_WHITELIST.length > 0 && !GROUP_WHITELIST.includes(fromWxid)) return false;

  const content = (msg.content || msg.msg || '').trim();

  if (TRIGGER_MODE === 'all') return true;

  if (TRIGGER_MODE === 'at') {
    // Check if bot is @'d in the message
    // GeWeChat wraps @mentions or provides atUserList
    const atList = msg.atUserList || msg.at_user_list || [];
    if (atList.includes(botWxid)) return true;
    // Fallback: check if content starts with @botname
    if (content.includes(`@${botWxid}`)) return true;
    return false;
  }

  if (TRIGGER_MODE === 'keyword') {
    return TRIGGER_KEYWORD && content.startsWith(TRIGGER_KEYWORD);
  }

  return false;
}

/**
 * Extract clean message text (remove @prefix, keyword prefix)
 */
function extractMessage(msg) {
  let content = (msg.content || msg.msg || '').trim();

  // Remove @mention prefix from group messages
  // GeWeChat group messages may have "wxid_xxx:\n" prefix for the actual sender
  const lines = content.split('\n');
  if (lines.length > 1 && lines[0].includes(':')) {
    content = lines.slice(1).join('\n').trim();
  }

  // Remove @bot text
  content = content.replace(/@[^\s]+\s*/g, '').trim();

  // Remove keyword prefix
  if (TRIGGER_MODE === 'keyword' && TRIGGER_KEYWORD) {
    if (content.startsWith(TRIGGER_KEYWORD)) {
      content = content.slice(TRIGGER_KEYWORD.length).trim();
    }
  }

  return content;
}

/**
 * Handle incoming GeWeChat callback message
 */
async function processMessage(msg) {
  if (!shouldProcess(msg)) return null;

  if (activeRequests >= MAX_CONCURRENCY) {
    log('warn', 'concurrency_limit', { active: activeRequests });
    return null; // silently drop
  }

  activeRequests++;
  const start = Date.now();

  try {
    const fromGroup = msg.fromWxid || msg.from_wxid || '';
    const senderWxid = msg.finalFromWxid || msg.final_from_wxid || msg.senderWxid || '';
    const senderName = msg.senderNickname || msg.pushContent?.split(':')[0] || senderWxid;
    const groupName = msg.groupName || msg.from_name || fromGroup;
    const content = extractMessage(msg);

    if (!content) return null;

    const sessionId = `langbot-bridge:group:${fromGroup}`;
    const agentMessage = `[${senderName}@${groupName}] ${content}`;

    log('info', 'msg_in', {
      group_id: fromGroup,
      group_name: groupName,
      sender_id: senderWxid,
      sender_name: senderName,
      message_preview: content.slice(0, 50)
    });

    const reply = await callAgent(sessionId, agentMessage);
    const elapsed = Date.now() - start;

    log('info', 'msg_out', {
      group_id: fromGroup,
      response_ms: elapsed,
      reply_preview: reply.slice(0, 50)
    });

    // Send reply back to the group
    if (reply && reply !== 'NO_REPLY' && reply !== 'HEARTBEAT_OK') {
      await sendTextMessage(fromGroup, reply);
    }

    return reply;
  } catch (err) {
    const elapsed = Date.now() - start;
    log('error', 'process_error', { error: err.message, response_ms: elapsed });

    // On timeout, send a friendly message
    if (err.message === 'timeout') {
      const fromGroup = msg.fromWxid || msg.from_wxid || '';
      if (fromGroup) {
        await sendTextMessage(fromGroup, '处理超时了，请稍后再试~').catch(() => {});
      }
    }
    return null;
  } finally {
    activeRequests--;
  }
}

// ─── HTTP Server (receives GeWeChat callbacks) ───────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 256 * 1024) { req.destroy(); reject(new Error('body_too_large')); }
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

async function handleCallback(req, res) {
  // GeWeChat sends message callbacks as POST
  try {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch (_) {
      return sendJSON(res, 400, { error: 'Invalid JSON' });
    }

    // Respond immediately (GeWeChat expects fast 200)
    sendJSON(res, 200, { success: true });

    // Process async (don't block the callback response)
    processMessage(body).catch(err => {
      log('error', 'async_process_error', { error: err.message });
    });
  } catch (err) {
    log('error', 'callback_error', { error: err.message });
    sendJSON(res, 500, { error: 'Internal error' });
  }
}

function handleHealth(req, res) {
  sendJSON(res, 200, {
    ok: true,
    mode: MOCK_MODE ? 'mock' : 'live',
    active_requests: activeRequests,
    uptime_s: Math.floor(process.uptime()),
    bot_wxid: botWxid || '(not set)',
    gewechat: GEWECHAT_BASE_URL
  });
}

async function handleLogin(req, res) {
  try {
    const result = await getLoginQR(GEWECHAT_APP_ID || undefined);
    sendJSON(res, 200, result);
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
}

async function handleStatus(req, res) {
  try {
    const result = await checkOnline();
    sendJSON(res, 200, result);
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
}

async function handleSetCallback(req, res) {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    const callbackUrl = body.callbackUrl || body.callback_url || '';
    if (!callbackUrl) return sendJSON(res, 400, { error: 'Missing callbackUrl' });
    const result = await setCallback(callbackUrl);
    sendJSON(res, 200, result);
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const { method, url } = req;

  if (method === 'GET' && url === '/health') return handleHealth(req, res);
  if (method === 'GET' && url === '/login') return handleLogin(req, res);
  if (method === 'GET' && url === '/status') return handleStatus(req, res);
  if (method === 'POST' && url === '/callback/set') return handleSetCallback(req, res);

  // GeWeChat message callback endpoint
  if (method === 'POST' && (url === '/callback' || url === '/webhook/gewechat')) {
    return handleCallback(req, res);
  }

  // Legacy: keep langbot webhook endpoint for backward compat (can remove later)
  if (method === 'POST' && url === '/webhook/langbot') {
    return handleCallback(req, res);
  }

  sendJSON(res, 404, { error: 'Not Found' });
});

server.listen(PORT, '0.0.0.0', () => {
  ensureLogDir();
  cleanOldLogs();
  log('info', 'startup', {
    port: PORT,
    mode: MOCK_MODE ? 'mock' : 'live',
    trigger: TRIGGER_MODE,
    gewechat: GEWECHAT_BASE_URL,
    max_concurrency: MAX_CONCURRENCY
  });
  console.log(`🌉 Bridge listening on 0.0.0.0:${PORT} [${MOCK_MODE ? 'MOCK' : 'LIVE'}]`);
  console.log(`📡 GeWeChat: ${GEWECHAT_BASE_URL}`);
  console.log(`🎯 Trigger: ${TRIGGER_MODE}${TRIGGER_MODE === 'keyword' ? ` (${TRIGGER_KEYWORD})` : ''}`);
});

server.on('error', (err) => {
  log('error', 'server_error', { error: err.message });
  process.exit(1);
});

process.on('SIGTERM', () => { log('info', 'shutdown', { reason: 'SIGTERM' }); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { log('info', 'shutdown', { reason: 'SIGINT' }); server.close(() => process.exit(0)); });
