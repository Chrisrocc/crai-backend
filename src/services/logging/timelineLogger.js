// backend/src/services/logging/timelineLogger.js
const { randomUUID } = require('crypto');

const _store = new Map();

function newContext({ chatId }) {
  const id = typeof randomUUID === 'function'
    ? randomUUID()
    : Math.random().toString(36).slice(2) + Date.now();
  const ctx = {
    id,
    chatId,
    batched: [],
    p1: [],
    p2: [],
    p3: [],
    extracts: [],
    extractAll: '',
    ident: [],
    changes: [],
    qa: null,        // full report
    qaItems: []      // flat items
  };
  _store.set(id, ctx);
  return ctx;
}

function get(idOrCtx) {
  const id = typeof idOrCtx === 'string' ? idOrCtx : idOrCtx?.id;
  return _store.get(id) || null;
}

function recordBatch(ctx, messages = []) {
  const s = get(ctx); if (!s) return;
  s.batched = messages.map(m => `${m.speaker || 'Unknown'}: '${m.text}'`);
}
function recordP1(ctx, messages = []) {
  const s = get(ctx); if (!s) return;
  s.p1 = messages.map(m => `${m.speaker || 'Unknown'}: '${m.text}'`);
}
function recordP2(ctx, messages = []) {
  const s = get(ctx); if (!s) return;
  s.p2 = messages.map(m => `${m.speaker || 'Unknown'}: '${m.text}'`);
}
function recordP3(ctx, items = []) {
  const s = get(ctx); if (!s) return;
  s.p3 = items.map(i => ({ text: `${i.speaker || 'Unknown'}: '${i.text}'`, category: i.category }));
}
function recordExtract(ctx, label, rawObj) {
  const s = get(ctx); if (!s) return;
  try { s.extracts.push({ label, jsonString: JSON.stringify(rawObj) }); }
  catch { s.extracts.push({ label, jsonString: '{"actions":[]}' }); }
}
function recordExtractAll(ctx, actions = []) {
  const s = get(ctx); if (!s) return;
  try { s.extractAll = JSON.stringify({ actions }); }
  catch { s.extractAll = '{"actions":[]}'; }
}

function identSuccess(ctx, { rego = '', make = '', model = '' } = {}) {
  const s = get(ctx); if (!s) return;
  const label = rego || [make, model].filter(Boolean).join(' ');
  s.ident.push(`✓ Identified: ${label || '(unknown)'}`);
}
function identFail(ctx, { reason = '', rego = '', make = '', model = '' } = {}) {
  const s = get(ctx); if (!s) return;
  const input = rego || [make, model].filter(Boolean).join(' ');
  s.ident.push(`✗ Not identified${input ? ` (${input})` : ''}: ${reason}`);
}
function change(ctx, text = '') {
  const s = get(ctx); if (!s) return;
  if (text) s.changes.push(text);
}

// ---------- QA logging ----------
function recordQA(ctx, report) {
  const s = get(ctx); if (!s) return;
  s.qa = report || null;
}
function recordQAItem(ctx, item) {
  const s = get(ctx); if (!s) return;
  s.qaItems.push(item);
}

function print(ctx) {
  const s = get(ctx); if (!s) return;
  const section = (title, body) => body ? `\n${title}\n${'-'.repeat(title.length)}\n${body}\n` : '';

  const bodyBatch = s.batched.join('\n');
  const bodyP1 = s.p1.join('\n');
  const bodyP2 = s.p2.join('\n');
  const catLines = s.p3.map(i => `${i.category} — ${i.text}`).join('\n');
  const extracts = s.extracts.map(e => `# ${e.label.toUpperCase()}\n${e.jsonString}`).join('\n');
  const allJson = s.extractAll;
  const idBody = s.ident.join('\n');
  const changesBody = s.changes.join('\n');

  let qaBody = '';
  if (s.qa) {
    const sum = `Summary: total=${s.qa.summary.total}, ok=${s.qa.summary.ok}, flagged=${s.qa.summary.flagged}`;
    const lines = (s.qa.items || []).map((it, idx) => {
      const head = `[${idx}] ${it.status} • ${it.action?.type || ''} • ${it.action?.rego || ''}`;
      const src = it.sourceText ? `SRC: ${it.sourceText}` : '';
      const flg = (it.flags || []).length ? `FLAGS: ${it.flags.join(', ')}` : '';
      const sug = (it.suggestions || []).length ? `SUGGEST: ${it.suggestions.join(' | ')}` : '';
      return [head, src, flg, sug].filter(Boolean).join('\n');
    }).join('\n\n');
    qaBody = [sum, lines].filter(Boolean).join('\n\n');
  }

  console.log(
    section('Batch', bodyBatch) +
    section('Prompt 1 (Filtered)', bodyP1) +
    section('Prompt 2 (Refined)', bodyP2) +
    section('Prompt 3 (Categorized)', catLines) +
    section('Extractor outputs (per category)', extracts) +
    section('Actions (Combined)', allJson) +
    section('Identification', idBody) +
    section('Changes', changesBody) +
    section('QA Check', qaBody) +
    '\n' + '='.repeat(40) + '\n'
  );

  _store.delete(s.id);
}

module.exports = {
  newContext,
  recordBatch,
  recordP1,
  recordP2,
  recordP3,
  recordExtract,
  recordExtractAll,
  identSuccess,
  identFail,
  change,
  // QA
  recordQA,
  recordQAItem,
  print,
};
