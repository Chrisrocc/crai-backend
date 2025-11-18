// src/services/logging/timelineLogger.js
const { randomUUID } = require('crypto');

/**
 * Timeline logger that prints big, readable JSON blocks.
 * - We store RAW objects and render with JSON.stringify(..., null, 2)
 * - Sections are boxed and consistently ordered
 * - No collapsed single-line JSON, ever
 */

const _store = new Map();

// ---------------------------
// Config
// ---------------------------
const MAX_LINE = 320; // long single lines will be trimmed for sanity
const TRIM_NOTE = ' …(trimmed)';

// ---------------------------
// Helpers
// ---------------------------
const idOf = (x) => (typeof x === 'string' ? x : x?.id);
const safe = (v, fallback) => (v === undefined || v === null ? fallback : v);

function box(title) {
  const line = '═'.repeat(Math.max(36, title.length + 2));
  return `\n${line}\n ${title}\n${line}\n`;
}

function sub(label) {
  return `\n— ${label} —\n`;
}

function prettyJSON(obj) {
  try {
    // If a string that looks like JSON was passed, parse then pretty
    if (typeof obj === 'string') {
      const parsed = JSON.parse(obj);
      return JSON.stringify(parsed, null, 2);
    }
    return JSON.stringify(obj, null, 2);
  } catch {
    // Fallback to raw string
    return String(obj ?? '');
  }
}

function trimLongLines(str) {
  return String(str)
    .split('\n')
    .map((line) =>
      line.length > MAX_LINE ? line.slice(0, MAX_LINE) + TRIM_NOTE : line
    )
    .join('\n');
}

// Render a {messages:[{speaker,text}]} object from an array of Msgs
function renderMessagesArray(msgs = []) {
  const obj = { messages: (Array.isArray(msgs) ? msgs : []).map((m) => ({
    speaker: String(m?.speaker || ''),
    text: String(m?.text || ''),
  })) };
  return prettyJSON(obj);
}

// Render categorized lines as JSON
function renderCategorized(items = []) {
  const obj = {
    items: (Array.isArray(items) ? items : []).map((i) => ({
      speaker: String(i?.speaker || ''),
      text: String(i?.text || ''),
      category: String(i?.category || 'OTHER'),
    })),
  };
  return prettyJSON(obj);
}

// Render extractor raw outputs (already JSON from the LLM)
function renderExtracts(arr = []) {
  const blocks = [];
  for (const e of arr || []) {
    blocks.push(
      sub(`# ${String(e?.label || '').toUpperCase()}`) +
        trimLongLines(prettyJSON(safe(e?.raw, {})))
    );
  }
  return blocks.join('');
}

function renderActions(actions = []) {
  return prettyJSON({ actions: Array.isArray(actions) ? actions : [] });
}

// ---------------------------
// Public API
// ---------------------------
function newContext({ chatId }) {
  const id =
    typeof randomUUID === 'function'
      ? randomUUID()
      : Math.random().toString(36).slice(2) + Date.now();

  const ctx = {
    id,
    chatId,

    // Inputs
    batched: [], // [{speaker,text}]
    photoAnalysis: [], // optional strings
    regoIdent: { success: [], fail: [] }, // arrays of strings
    carCreated: [], // strings like "Make Model REGO"

    // Prompts
    p1: [], // filtered messages [{speaker,text}]
    p2: [], // refined messages  [{speaker,text}]
    p3: [], // categorized [{speaker,text,category}]
    extracts: [], // [{label, raw}]
    actions: [], // final combined actions []

    // QA / meta
    identNotes: [], // ✓ / ✗ messages
    changes: [], // bullet messages
  };

  _store.set(id, ctx);
  return ctx;
}

function get(idOrCtx) {
  return _store.get(idOf(idOrCtx)) || null;
}

// ------------ recorders ------------
function recordBatch(ctx, messages = []) {
  const s = get(ctx);
  if (!s) return;
  s.batched = Array.isArray(messages) ? messages : [];
}

function recordPhoto(ctx, lines = []) {
  const s = get(ctx);
  if (!s) return;
  s.photoAnalysis.push(...(Array.isArray(lines) ? lines : [String(lines)]));
}

function recordRegoSuccess(ctx, label) {
  const s = get(ctx);
  if (!s) return;
  s.regoIdent.success.push(String(label || ''));
}

function recordRegoFail(ctx, label) {
  const s = get(ctx);
  if (!s) return;
  s.regoIdent.fail.push(String(label || ''));
}

function recordCarCreated(ctx, label) {
  const s = get(ctx);
  if (!s) return;
  s.carCreated.push(String(label || ''));
}

function recordP1(ctx, messages = []) {
  const s = get(ctx);
  if (!s) return;
  s.p1 = Array.isArray(messages) ? messages : [];
}

function recordP2(ctx, messages = []) {
  const s = get(ctx);
  if (!s) return;
  s.p2 = Array.isArray(messages) ? messages : [];
}

function recordP3(ctx, items = []) {
  const s = get(ctx);
  if (!s) return;
  s.p3 = Array.isArray(items) ? items : [];
}

function recordExtract(ctx, label, rawObj) {
  const s = get(ctx);
  if (!s) return;
  s.extracts.push({ label: String(label || ''), raw: rawObj });
}

function recordExtractAll(ctx, actions = []) {
  const s = get(ctx);
  if (!s) return;
  s.actions = Array.isArray(actions) ? actions : [];
}

function identSuccess(ctx, { rego = '', make = '', model = '' } = {}) {
  const s = get(ctx);
  if (!s) return;
  const label = rego || [make, model].filter(Boolean).join(' ');
  s.identNotes.push(`✓ Identified: ${label || '(unknown)'}`);
}

function identFail(ctx, { reason = '', rego = '', make = '', model = '' } = {}) {
  const s = get(ctx);
  if (!s) return;
  const input = rego || [make, model].filter(Boolean).join(' ');
  s.identNotes.push(`✗ Not identified${input ? ` (${input})` : ''}${reason ? `: ${reason}` : ''}`);
}

function change(ctx, text = '') {
  const s = get(ctx);
  if (!s) return;
  if (text) s.changes.push(text);
}

// ------------ printer ------------
function print(ctx) {
  const s = get(ctx);
  if (!s) return;

  let out = '';

  // Messages
  out += box('MESSAGES');
  out += trimLongLines(renderMessagesArray(s.batched));

  // Photo analysis (optional)
  if (s.photoAnalysis.length) {
    out += box('PHOTO ANALYSIS');
    out += trimLongLines(
      s.photoAnalysis.map((l) => `• ${l}`).join('\n')
    );
  }

  // Rego checker/matcher
  out += box('REGO CHECKER / MATCHER');
  if (!s.regoIdent.success.length && !s.regoIdent.fail.length) {
    out += '(no rego results)\n';
  } else {
    if (s.regoIdent.success.length) {
      out += sub('Car identified');
      out += s.regoIdent.success.map((x) => `• ${x}`).join('\n') + '\n';
    }
    if (s.regoIdent.fail.length) {
      out += sub('Not identified');
      out += s.regoIdent.fail.map((x) => `• ${x}`).join('\n') + '\n';
    }
  }

  // Car creator
  if (s.carCreated.length) {
    out += box('CAR CREATOR');
    out += s.carCreated.map((x) => `• ${x}`).join('\n') + '\n';
  }

  // Prompts (INPUT/OUTPUT)
  out += box('PROMPT: PHOTO_MERGER_SYSTEM');
  out += sub('INPUT') + '(handled earlier in pipeline)\n';
  out += sub('OUTPUT') + '(attach here if photo merger is invoked in this module)\n';

  out += box('PROMPT: FILTER_SYSTEM');
  out += sub('INPUT') + trimLongLines(renderMessagesArray(s.batched)) + '\n';
  out += sub('OUTPUT') + trimLongLines(renderMessagesArray(s.p1)) + '\n';

  out += box('PROMPT: REFINE_SYSTEM');
  out += sub('INPUT') + trimLongLines(renderMessagesArray(s.p1)) + '\n';
  out += sub('OUTPUT') + trimLongLines(renderMessagesArray(s.p2)) + '\n';

  out += box('PROMPT: CATEGORIZE_SYSTEM');
  out += sub('INPUT') + trimLongLines(renderMessagesArray(s.p2)) + '\n';
  out += sub('OUTPUT') + trimLongLines(renderCategorized(s.p3)) + '\n';

  // Extractors
  if (s.extracts.length) {
    out += box('EXTRACTORS — RAW OUTPUTS');
    out += renderExtracts(s.extracts);
  }

  // Final actions
  out += box('FINAL OUTPUT & ACTIONS');
  out += trimLongLines(renderActions(s.actions)) + '\n';

  // QA / identification / changes
  if (s.identNotes.length) {
    out += box('IDENTIFICATION');
    out += s.identNotes.join('\n') + '\n';
  }
  if (s.changes.length) {
    out += box('CHANGES');
    out += s.changes.map((x) => `• ${x}`).join('\n') + '\n';
  }

  out += '\n' + '─'.repeat(42) + '\n';

  console.log(out);
  _store.delete(s.id);
}

// ---------------------------
// Exports
// ---------------------------
module.exports = {
  newContext,
  get,

  // recorders
  recordBatch,
  recordPhoto,
  recordRegoSuccess,
  recordRegoFail,
  recordCarCreated,
  recordP1,
  recordP2,
  recordP3,
  recordExtract,
  recordExtractAll,

  identSuccess,
  identFail,
  change,

  // printer
  print,
};
