// src/services/logging/auditLogger.js
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// -------- config (env) --------
const ENABLED = String(process.env.AUDIT_ENABLED ?? 'false').toLowerCase() !== 'false'; // default OFF
const LOG_DIR = process.env.AUDIT_LOG_DIR || path.join(process.cwd(), 'logs');
const STDOUT_MODE = (process.env.AUDIT_LOG_STDOUT || 'summary').toLowerCase(); // 'summary' | 'full' | 'none'
const PRETTY = String(process.env.AUDIT_LOG_PRETTY || 'true').toLowerCase() === 'true';
const MAX_CHARS = Number(process.env.AUDIT_MAX_CHARS || 6000);

// -------- safe helpers --------
const now = () => new Date().toISOString();
const safeStringify = (obj) => {
  try { return JSON.stringify(obj); } catch { return '{"_err":"stringify-failed"}'; }
};
const trim = (s = '', n = MAX_CHARS) => (s.length > n ? s.slice(0, n) + ' …[trimmed]' : s);

// -------- no-op mode --------
if (!ENABLED) {
  function newContext() { return { id: 'audit-disabled', chatId: null, startedAt: now() }; }
  function write() { /* no-op */ }
  module.exports = { newContext, write };
  return;
}

// -------- enabled mode: ensure log dir --------
if (!fs.existsSync(LOG_DIR)) {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

function fileFor(ctx) {
  return path.join(LOG_DIR, `${ctx?.id || 'general'}.ndjson`);
}

function echoToConsole(type, payload) {
  if (STDOUT_MODE === 'none') return;

  if (STDOUT_MODE === 'summary') {
    console.log(`[AUDIT ${type}]`, payload.summary || '');
    return;
  }

  // FULL mode
  if (!PRETTY) {
    console.log(`[AUDIT ${type}]`, trim(safeStringify(payload)));
    return;
  }

  console.log(`\n===== AUDIT ${type} =====`);
  if (payload.summary) console.log(`summary: ${payload.summary}\n`);

  if (payload.system) { console.log('--- system ---'); console.log(trim(String(payload.system))); console.log(); }
  if (payload.user)   { console.log('--- user ---');   console.log(trim(String(payload.user)));   console.log(); }
  if (typeof payload.out !== 'undefined') {
    console.log('--- out ---');
    console.log(trim(safeStringify(payload.out)));
    console.log();
  }

  const omit = new Set(['summary','system','user','out']);
  const rest = {};
  for (const k of Object.keys(payload || {})) if (!omit.has(k)) rest[k] = payload[k];
  if (Object.keys(rest).length) {
    console.log('--- details ---');
    console.log(trim(safeStringify(rest)));
  }
  console.log('===== END AUDIT =====\n');
}

function newContext({ chatId }) {
  const id = typeof randomUUID === 'function'
    ? randomUUID()
    : Math.random().toString(36).slice(2) + Date.now();
  return { id, chatId, startedAt: now() };
}

function write(ctx, type, payload = {}) {
  if (!ctx) return;
  const line = safeStringify({ ts: now(), id: ctx.id, chatId: ctx.chatId, type, ...payload }) + '\n';
  try { fs.appendFile(fileFor(ctx), line, () => {}); } catch {}
  echoToConsole(type, payload);
}

module.exports = { newContext, write };
