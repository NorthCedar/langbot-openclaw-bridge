#!/usr/bin/env node
/**
 * LangBot-OpenClaw Bridge
 *
 * A lightweight HTTP server that bridges LangBot (Windows) Webhook messages
 * to OpenClaw Gateway CLI. Zero external dependencies — built on Node.js
 * standard library (http, child_process, crypto).
 *
 * Usage:
 *   BRIDGE_PORT=8780 BRIDGE_TOKEN=xxx node bridge.js
 */

'use strict';

const http = require('http');
const { execFile } = require('child_process');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT, 10) || 8780;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const OPENCLAW_CLI = process.env.OPENCLAW_CLI || '/root/.local/share/pnpm/openclaw';
const CLI_TIMEOUT_MS = 90_000;

const MAX_CONCURRENT = 5;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let activeRequests = 0;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Write a structured JSON log line to stdout.
 */
function log(level, requestId, message, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    req: requestId,
    msg: message,
    ...extra,
  };
  // Print as single-line JSON for easy ingestion by log processors
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// ---------------------------------------------------------------------------
// Request counter guard
// ---------------------------------------------------------------------------

/**
 * Acquire a concurrency slot. Returns true if acquired; false if at capacity.
 */
function acquireSlot() {
  if (activeRequests >= MAX_CONCURRENT) return false;
  activeRequests++;
  return true;
}

function releaseSlot() {
  if (activeRequests > 0) activeRequests--;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function respond(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, JSON_HEADERS);
  res.end(payload);
}

function errorResponse(res, requestId, status, message) {
  log('warn', requestId, `HTTP ${status}: ${message}`, { status });
  respond(res, status, { error: message });
}

// ---------------------------------------------------------------------------
// Body parser
// ---------------------------------------------------------------------------

/**
 * Collect the request body as a UTF-8 string. Returns the raw body or rejects
 * if content length exceeds `maxBytes`.
 */
function readBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Auth validation
// ---------------------------------------------------------------------------

/**
 * Extract and validate the Bearer token from the Authorization header.
 * Uses constant-time comparison to avoid timing leaks.
 */
function validateAuth(req) {
  if (!BRIDGE_TOKEN) {
    // No token configured — allow all requests (dev mode).
    return true;
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;

  const token = header.slice(7);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(BRIDGE_TOKEN)
    );
  } catch {
    // Different-length buffers throw in timingSafeEqual
    return false;
  }
}

// ---------------------------------------------------------------------------
// CLI invocation
// ---------------------------------------------------------------------------

/**
 * Execute `openclaw agent` and return the parsed reply text.
 *
 * The CLI is expected to output JSON on stdout (--json flag). We parse the
 * last meaningful line of output to extract the assistant's reply.
 */
function runOpenClawAgent(sessionId, message, requestId) {
  const args = [
    'agent',
    '--session-id', sessionId,
    '--message', message,
    '--json',
    '--timeout', String(Math.floor(CLI_TIMEOUT_MS / 1000)),
  ];

  log('info', requestId, 'invoking openclaw agent', {
    sessionId,
    msgLen: message.length,
  });

  return new Promise((resolve, reject) => {
    const child = execFile(OPENCLAW_CLI, args, {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024, // 2 MB
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        log('error', requestId, 'openclaw CLI not found', { path: OPENCLAW_CLI });
        reject(new Error('CLI_NOT_FOUND'));
      } else if (err.killed) {
        log('warn', requestId, 'CLI timed out');
        reject(new Error('TIMEOUT'));
      } else {
        log('error', requestId, 'CLI spawn error', { err: err.message });
        reject(new Error('CLI_ERROR'));
      }
    });

    child.on('close', (code) => {
      log('info', requestId, 'CLI exited', { code, stdoutLen: stdout.length });

      if (code !== 0 && code !== null) {
        log('error', requestId, 'CLI non-zero exit', { code, stderr: stderr.slice(0, 500) });
        reject(new Error('CLI_NONZERO'));
        return;
      }

      try {
        const reply = parseOpenClawOutput(stdout);
        resolve(reply);
      } catch (err) {
        log('error', requestId, 'failed to parse CLI output', { err: err.message });
        reject(new Error('PARSE_ERROR'));
      }
    });
  });
}

/**
 * Parse the CLI JSON output to extract the assistant's reply text.
 *
 * The CLI outputs multiple JSON lines; we look for ones with a "type" field.
 * The assistant reply typically has type "assistant" with a "text" property.
 */
function parseOpenClawOutput(stdout) {
  const lines = stdout.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // Try common shapes from the OpenClaw CLI JSON output
      if (obj.type === 'assistant' && obj.text) {
        return obj.text;
      }
      if (obj.reply) {
        return obj.reply;
      }
      if (obj.text && typeof obj.text === 'string') {
        return obj.text;
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  // Last resort: return the last non-empty line if it looks like plain text
  const lastLine = lines[lines.length - 1] || '';
  if (lastLine && !lastLine.startsWith('{')) {
    return lastLine;
  }

  throw new Error('no assistant reply found in CLI output');
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

async function handleWebhook(req, res, requestId) {
  // --- Concurrency check ---
  if (!acquireSlot()) {
    errorResponse(res, requestId, 429, 'too many concurrent requests');
    return;
  }

  try {
    // --- Auth ---
    if (!validateAuth(req)) {
      errorResponse(res, requestId, 401, 'unauthorized');
      return;
    }

    // --- Method check ---
    if (req.method !== 'POST') {
      errorResponse(res, requestId, 405, 'method not allowed');
      return;
    }

    // --- Parse body ---
    let rawBody;
    try {
      rawBody = await readBody(req);
    } catch {
      errorResponse(res, requestId, 400, 'request body too large or unreadable');
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      errorResponse(res, requestId, 400, 'invalid JSON body');
      return;
    }

    // --- Validate required fields ---
    if (!payload.message || typeof payload.message !== 'string') {
      errorResponse(res, requestId, 400, 'missing or invalid "message" field');
      return;
    }
    if (!payload.launcher_id) {
      errorResponse(res, requestId, 400, 'missing "launcher_id" field');
      return;
    }

    // --- Build session id & message ---
    const sessionId = `langbot-bridge:group:${payload.launcher_id}`;

    const senderName = payload.sender_name || 'unknown';
    const groupName = payload.group_name || 'unknown';
    const message = `[${senderName}@${groupName}] ${payload.message}`;

    log('info', requestId, 'handling webhook', {
      sessionId,
      sender: senderName,
      group: groupName,
    });

    // --- Invoke OpenClaw CLI ---
    let reply;
    try {
      reply = await runOpenClawAgent(sessionId, message, requestId);
    } catch (err) {
      switch (err.message) {
        case 'CLI_NOT_FOUND':
          errorResponse(res, requestId, 503, '服务暂时不可用');
          return;
        case 'TIMEOUT':
          respond(res, 200, { text: '处理超时，请稍后再试' });
          return;
        case 'CLI_NONZERO':
        case 'PARSE_ERROR':
          errorResponse(res, requestId, 503, '服务暂时不可用');
          return;
        default:
          log('error', requestId, 'unexpected CLI error', { err: err.message });
          errorResponse(res, requestId, 503, '服务暂时不可用');
          return;
      }
    }

    // --- Success ---
    log('info', requestId, 'request completed', { replyLen: reply.length });
    respond(res, 200, { text: reply });

  } finally {
    releaseSlot();
  }
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

function createServer() {
  return http.createServer((req, res) => {
    const requestId = crypto.randomUUID().split('-')[0]; // short 8-char id
    const start = Date.now();

    log('info', requestId, 'incoming request', {
      method: req.method,
      url: req.url,
      remote: req.socket.remoteAddress,
    });

    // Register response finish logging
    res.on('finish', () => {
      log('info', requestId, 'response sent', {
        status: res.statusCode,
        latencyMs: Date.now() - start,
      });
    });

    // Route: only POST /webhook/langbot is supported
    if (req.url === '/webhook/langbot') {
      handleWebhook(req, res, requestId).catch((err) => {
        log('error', requestId, 'unhandled error', { err: err.message });
        if (!res.headersSent) {
          respond(res, 500, { error: 'internal server error' });
        }
        releaseSlot();
      });
      return;
    }

    // Health-check endpoint (lightweight)
    if (req.url === '/health' && req.method === 'GET') {
      respond(res, 200, {
        status: 'ok',
        active: activeRequests,
        uptime: process.uptime(),
      });
      return;
    }

    // 404 for everything else
    errorResponse(res, requestId, 404, 'not found');
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function main() {
  if (!BRIDGE_TOKEN) {
    log('warn', '—', 'BRIDGE_TOKEN not set — auth is DISABLED (dev mode only!)');
  }

  const server = createServer();

  server.listen(BRIDGE_PORT, '0.0.0.0', () => {
    log('info', '—', `langbot-bridge listening on 0.0.0.0:${BRIDGE_PORT}`, {
      pid: process.pid,
      node: process.version,
      maxConcurrent: MAX_CONCURRENT,
      cliTimeoutMs: CLI_TIMEOUT_MS,
    });
  });

  // Graceful shutdown
  const shutdown = (signal) => {
    log('info', '—', `received ${signal}, shutting down`, { active: activeRequests });
    server.close(() => {
      log('info', '—', 'server closed');
      process.exit(0);
    });
    // Force exit after 10s
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log('error', '—', 'uncaught exception', { err: err.message, stack: err.stack });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log('error', '—', 'unhandled rejection', { reason: String(reason) });
  });
}

main();
