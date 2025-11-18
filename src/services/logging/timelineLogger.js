// src/services/logging/timelineLogger.js
// Pretty, sectioned timeline with compact single-line entries + AI AUDIT box.

const { randomUUID } = require('crypto');

const _store = new Map();
const bar = '──────────────────────────────────';

function newId() {
  try { return randomUUID(); } catch { return Math.random().toString(36).slice(2) + Date.now(); }
}

function newContext({ chatId }) {
  const id = newId();
  const ctx = {
    id,
    chatId,

    // Raw inputs / steps
    messages: [],                 // array of "Name: message"
    photoAnalysis: [],            // strings
    regoMatches: [],              // strings
    carCreations: [],             // strings

    // Prompts (ordered)
    prompts: [],                  // { name, inputText, outputText }

    // Legacy compatibility (pipeline uses these)
    batched: [],
    p1: [],
    p2: [],
    p3: [],
    extracts: [],                 // { label, jsonString }
    extractAll: '',

    // Identification + change notes
    ident: [],
    changes: [],

    // AI audit
    audit: [],                    // array of one-line strings
  };
  _store.set(id, ctx);
  return ctx;
}

function get(idOrCtx) {
  const id = typeof idOrCtx === 'string' ? idOrCtx : idOrCtx?.id;
  return _store.get(id) || null;
}

/* -------- High-level recorders -------- */
function recordMessage(ctx, name, text) {
  const s = get(ctx); if (!s) return;
  s.messages.push(`- ${name}: ${text}`);
}

function recordPhoto(ctx, line) {
  const s = get(ctx); if (!s) return;
  s.photoAnalysis.push(`- ${line}`);
}

function recordRego(ctx, line) {
  const s = get(ctx); if (!s) return;
  s.regoMatches.push(`- ${line}`);
}

function recordCarCreate(ctx, line) {
  const s = get(ctx); if (!s) return;
  s.carCreations.push(`- ${line}`);
}

function recordPrompt(ctx, name, inputText, outputText) {
  const s = get(ctx); if (!s) return;
  s.prompts.push({ name, inputText: String(inputText || ''), outputText: String(outputText || '') });
}

/* -------- Legacy recorders (kept so pipeline code doesn't break) -------- */
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

/* -------- Identification + change notes -------- */
function identSuccess(ctx, { rego = '', make = '', model = '' } = {}) {
  const s = get(ctx); if (!s) return;
  const label = rego || [make, model].filter(Boolean).join(' ');
  s.ident.push(`- ✓ Identified: ${label || '(unknown)'}`);
}
function identFail(ctx, { reason = '', rego = '', make = '', model = '' } = {}) {
  const s = get(ctx); if (!s) return;
  const input = rego || [make, model].filter(Boolean).join(' ');
  s.ident.push(`- ✗ Not identified${input ? ` (${input})` : ''}: ${reason}`);
}
function change(ctx, text = '') {
  const s = get(ctx); if (!s) return;
  if (text) s.changes.push(`- ${text}`);
}

/* -------- AI Audit -------- */
function auditLine(ctx, line) {
  const s = get(ctx); if (!s) return;
  if (line) s.audit.push(`- ${line}`);
}

/* -------- Print (pretty, compact, readable) -------- */
function section(title, linesArray) {
  const has = Array.isArray(linesArray) && linesArray.length > 0;
  if (!has) return '';
  const body = linesArray.join('\n');
  return `\n ${title.toUpperCase()}\n${bar}\n${body}\n`;
}

function sectionPrompts(title, prompts) {
  if (!prompts || prompts.length === 0) return '';
  const chunks = prompts.map(p => {
    const inp = p.inputText ? `INPUT:\n  ${p.inputText}` : 'INPUT:\n  [none]';
    const out = p.outputText ? `OUTPUT:\n  ${p.outputText}` : 'OUTPUT:\n  [none]';
    return ` PROMPT: ${p.name}\n${bar}\n${inp}\n${out}`;
  });
  return `\n ${title.toUpperCase()}\n${bar}\n${chunks.join('\n')}\n`;
}

function sectionCat(title, categorized) {
  if (!categorized || categorized.length === 0) return '';
  const lines = categorized.map(c => `- ${c.category} — ${c.speaker || 'Unknown'}: '${c.text}'`);
  return `\n ${title.toUpperCase()}\n${bar}\n${lines.join('\n')}\n`;
}

function sectionExtractors(title, extractsJson) {
  if (!extractsJson || extractsJson.length === 0) return '';
  // Render each extractor label with one line per action, compact
  const chunks = [];
  for (const e of extractsJson) {
    let pretty = '';
    try {
      const obj = JSON.parse(e.jsonString || '{}');
      const acts = Array.isArray(obj.actions) ? obj.actions : [];
      const lines = acts.map(a => {
        const rego = (a.rego || '').toUpperCase() || '—';
        if (a.type === 'REPAIR') return `  - REPAIR: {rego ${rego} • ${[a.make, a.model].filter(Boolean).join(' ') || '—'}, task: ${a.checklistItem || 'repair'}}`;
        if (a.type === 'RECON_APPOINTMENT') return `  - RECON_APPOINTMENT: {rego ${rego} • ${[a.make, a.model].filter(Boolean).join(' ') || '—'}, category: ${a.category || 'Uncategorized'}}`;
        if (a.type === 'LOCATION_UPDATE') return `  - LOCATION_UPDATE: {rego ${rego}, at: ${a.location || 'unknown'}}`;
        if (a.type === 'CUSTOMER_APPOINTMENT') return `  - CUSTOMER_APPOINTMENT: {rego ${rego}, ${a.name || '—'} @ ${a.dateTime || '—'}}`;
        if (a.type === 'NEXT_LOCATION') return `  - NEXT_LOCATION: {rego ${rego} → ${a.nextLocation || '—'}}`;
        if (a.type === 'DROP_OFF') return `  - DROP_OFF: {rego ${rego} → ${a.destination || '—'}}`;
        if (a.type === 'TASK') return `  - TASK: {rego ${rego}, ${a.task || '—'}}`;
        if (a.type === 'READY') return `  - READY: {rego ${rego}}`;
        if (a.type === 'SOLD') return `  - SOLD: {rego ${rego}}`;
        return `  - ${a.type || 'UNKNOWN'}: {rego ${rego}}`;
      });
      pretty = lines.join('\n');
    } catch {
      pretty = '  - (unparsable extractor output)';
    }
    chunks.push(`# ${e.label.toUpperCase()}\n${pretty || '  - (no actions)'}`);
  }
  return `\n ${title.toUpperCase()}\n${bar}\n${chunks.join('\n')}\n`;
}

function print(ctx) {
  const s = get(ctx); if (!s) return;

  const out =
    section('Messages', s.messages) +
    section('Photo Analysis', s.photoAnalysis) +
    section('Rego Checker / Matcher', s.regoMatches) +
    section('Car Creator', s.carCreations) +
    sectionPrompts('Prompts', s.prompts) +
    sectionCat('Categorized', s.p3) +
    sectionExtractors('Extractors', s.extracts) +
    (s.extractAll ? `\n FINAL OUTPUT & ACTIONS\n${bar}\n  ${s.extractAll}\n` : '') +
    section('Identification', s.ident) +
    section('Changes', s.changes) +
    section('AI Audit', s.audit) +
    '\n';

  console.log(out);
  _store.delete(s.id);
}

module.exports = {
  newContext,
  get,

  // high-level
  recordMessage,
  recordPhoto: recordPhoto,
  recordRego: recordRego,
  recordCarCreate,
  recordPrompt,

  // legacy used by pipeline
  recordBatch,
  recordP1,
  recordP2,
  recordP3,
  recordExtract,
  recordExtractAll,

  identSuccess,
  identFail,
  change,

  auditLine,
  print,
};
