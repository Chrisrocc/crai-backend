// src/services/logging/timelineLogger.js
const { randomUUID } = require('crypto');

const _store = new Map();

// ---------- config ----------
const MAX_LINE = 320;
const TRIM_NOTE = ' …(trimmed)';

// ---------- helpers ----------
const idOf = (x) => (typeof x === 'string' ? x : x?.id);
const safe = (v, fb) => (v === undefined || v === null ? fb : v);

const box = (title) => {
  const line = '═'.repeat(Math.max(36, title.length + 2));
  return `\n${line}\n ${title}\n${line}\n`;
};
const sub = (label) => `\n— ${label} —\n`;

function prettyJSON(obj) {
  try {
    if (typeof obj === 'string') return JSON.stringify(JSON.parse(obj), null, 2);
    return JSON.stringify(obj ?? {}, null, 2);
  } catch {
    return String(obj ?? '');
  }
}
const trimLongLines = (s) =>
  String(s)
    .split('\n')
    .map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) + TRIM_NOTE : l))
    .join('\n');

function renderMessagesArray(msgs = []) {
  const obj = {
    messages: (Array.isArray(msgs) ? msgs : []).map((m) => ({
      speaker: String(m?.speaker || ''),
      text: String(m?.text || ''),
    })),
  };
  return prettyJSON(obj);
}
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

// ---------- state / API ----------
function newContext({ chatId }) {
  const id =
    typeof randomUUID === 'function'
      ? randomUUID()
      : Math.random().toString(36).slice(2) + Date.now();

  const ctx = {
    id,
    chatId,

    // Inputs
    batched: [],
    photoAnalysis: [],
    regoIdent: { success: [], fail: [] },
    carCreated: [],

    // Prompts
    // legacy direct buckets:
    p1: [],
    p2: [],
    p3: [],
    // generic prompts recorded via recordPrompt():
    prompts: [], // [{name,input,output}]

    extracts: [],    // [{label, raw}]
    actions: [],     // final actions

    // QA / meta
    identNotes: [],
    changes: [],
  };

  _store.set(id, ctx);
  return ctx;
}
const get = (idOrCtx) => _store.get(idOf(idOrCtx)) || null;

// ---------- recorders ----------
function recordBatch(ctx, messages = []) {
  const s = get(ctx); if (!s) return;
  s.batched = Array.isArray(messages) ? messages : [];
}
function recordPhoto(ctx, lines = []) {
  const s = get(ctx); if (!s) return;
  s.photoAnalysis.push(...(Array.isArray(lines) ? lines : [String(lines)]));
}
function recordRegoSuccess(ctx, label) {
  const s = get(ctx); if (!s) return;
  s.regoIdent.success.push(String(label || ''));
}
function recordRegoFail(ctx, label) {
  const s = get(ctx); if (!s) return;
  s.regoIdent.fail.push(String(label || ''));
}
function recordCarCreated(ctx, label) {
  const s = get(ctx); if (!s) return;
  s.carCreated.push(String(label || ''));
}

// legacy named buckets
function recordP1(ctx, messages = []) { const s = get(ctx); if (s) s.p1 = Array.isArray(messages) ? messages : []; }
function recordP2(ctx, messages = []) { const s = get(ctx); if (s) s.p2 = Array.isArray(messages) ? messages : []; }
function recordP3(ctx, items = [])    { const s = get(ctx); if (s) s.p3 = Array.isArray(items) ? items : []; }

// NEW: generic prompt recorder (compat shim for pipeline calls)
function recordPrompt(ctx, name, input, output) {
  const s = get(ctx); if (!s) return;
  s.prompts.push({
    name: String(name || 'PROMPT'),
    input,
    output,
  });
}

function recordExtract(ctx, label, rawObj) {
  const s = get(ctx); if (!s) return;
  s.extracts.push({ label: String(label || ''), raw: rawObj });
}
function recordExtractAll(ctx, actions = []) {
  const s = get(ctx); if (!s) return;
  s.actions = Array.isArray(actions) ? actions : [];
}

function identSuccess(ctx, { rego = '', make = '', model = '' } = {}) {
  const s = get(ctx); if (!s) return;
  const label = rego || [make, model].filter(Boolean).join(' ');
  s.identNotes.push(`✓ Identified: ${label || '(unknown)'}`);
}
function identFail(ctx, { reason = '', rego = '', make = '', model = '' } = {}) {
  const s = get(ctx); if (!s) return;
  const input = rego || [make, model].filter(Boolean).join(' ');
  s.identNotes.push(`✗ Not identified${input ? ` (${input})` : ''}${reason ? `: ${reason}` : ''}`);
}
function change(ctx, text = '') {
  const s = get(ctx); if (!s) return;
  if (text) s.changes.push(text);
}

// ---------- printer ----------
function print(ctx) {
  const s = get(ctx); if (!s) return;
  let out = '';

  // Messages
  out += box('MESSAGES');
  out += trimLongLines(renderMessagesArray(s.batched));

  // Photo analysis
  if (s.photoAnalysis.length) {
    out += box('PHOTO ANALYSIS');
    out += trimLongLines(s.photoAnalysis.map((l) => `• ${l}`).join('\n'));
  }

  // Rego checker
  out += box('REGO CHECKER / MATCHER');
  if (!s.regoIdent.success.length && !s.regoIdent.fail.length) {
    out += '(no rego results)\n';
  } else {
    if (s.regoIdent.success.length) {
      out += sub('Car identified') + s.regoIdent.success.map((x) => `• ${x}`).join('\n') + '\n';
    }
    if (s.regoIdent.fail.length) {
      out += sub('Not identified') + s.regoIdent.fail.map((x) => `• ${x}`).join('\n') + '\n';
    }
  }

  // Car creator
  if (s.carCreated.length) {
    out += box('CAR CREATOR');
    out += s.carCreated.map((x) => `• ${x}`).join('\n') + '\n';
  }

  // Legacy named prompts
  out += box('PROMPT: FILTER_SYSTEM');
  out += sub('INPUT') + trimLongLines(renderMessagesArray(s.batched)) + '\n';
  out += sub('OUTPUT') + trimLongLines(renderMessagesArray(s.p1)) + '\n';

  out += box('PROMPT: REFINE_SYSTEM');
  out += sub('INPUT') + trimLongLines(renderMessagesArray(s.p1)) + '\n';
  out += sub('OUTPUT') + trimLongLines(renderMessagesArray(s.p2)) + '\n';

  out += box('PROMPT: CATEGORIZE_SYSTEM');
  out += sub('INPUT') + trimLongLines(renderMessagesArray(s.p2)) + '\n';
  out += sub('OUTPUT') + trimLongLines(renderCategorized(s.p3)) + '\n';

  // Any extra prompts recorded via recordPrompt()
  if (s.prompts.length) {
    for (const p of s.prompts) {
      out += box(`PROMPT: ${p.name}`);
      if (p.input !== undefined)  out += sub('INPUT')  + trimLongLines(prettyJSON(p.input))  + '\n';
      if (p.output !== undefined) out += sub('OUTPUT') + trimLongLines(prettyJSON(p.output)) + '\n';
    }
  }

  // Extractors raw
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

// ---------- exports ----------
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
  recordPrompt,        // ← NEW

  recordExtract,
  recordExtractAll,

  identSuccess,
  identFail,
  change,

  print,
};
