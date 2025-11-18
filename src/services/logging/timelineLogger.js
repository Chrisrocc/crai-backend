// src/services/logging/timelineLogger.js
// Clean, boxed sections + compact prompt rendering + AI AUDIT.

const { randomUUID } = require('crypto');

const _store = new Map();
const BAR = '──────────────────────────────────';

function newId() {
  try { return randomUUID(); } catch { return Math.random().toString(36).slice(2) + Date.now(); }
}

function newContext({ chatId }) {
  const id = newId();
  const ctx = {
    id,
    chatId,

    // Top-of-log sections
    messages: [],          // "- Name: message"
    photoAnalysis: [],     // "- ..."
    regoMatches: [],       // "- Car identified: Make Model REGO"
    carCreations: [],      // "- Car Created: Make Model REGO"

    // Prompt snapshots (kept compact)
    prompts: [],           // { name, inputObj, outputObj }

    // Pipeline legacy (kept for compatibility)
    batched: [],
    p1: [],                // filtered lines
    p2: [],                // refined lines
    p3: [],                // [{text, category}]
    extracts: [],          // { label, jsonString }
    extractAll: '',

    // Identification + change notes
    ident: [],             // "- ✓ Identified: ..."
    changes: [],           // "- ..."

    // AI audit
    audit: [],             // "- OK / FLAG ..."
  };
  _store.set(id, ctx);
  return ctx;
}

function get(idOrCtx) {
  const id = typeof idOrCtx === 'string' ? idOrCtx : idOrCtx?.id;
  return _store.get(id) || null;
}

/* ----------------- High-level recorders ----------------- */
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

/**
 * Store prompt I/O as objects so we can render nicely (no ugly escaped JSON).
 * name: string, inputObj: any, outputObj: any
 */
function recordPrompt(ctx, name, inputObj, outputObj) {
  const s = get(ctx); if (!s) return;
  s.prompts.push({ name, inputObj, outputObj });
}

/* ----------------- Legacy recorders ----------------- */
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

/* ----------------- Identification + changes ----------------- */
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

/* ----------------- AI Audit ----------------- */
function auditLine(ctx, line) {
  const s = get(ctx); if (!s) return;
  if (line) s.audit.push(`- ${line}`);
}

/* ----------------- Render helpers ----------------- */
function section(title, lines) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  return `\n ${title.toUpperCase()}\n${BAR}\n${lines.join('\n')}\n`;
}

// Render compact prompt snapshots in the exact “Sender / OUTPUT” style
function sectionPrompts(title, prompts) {
  if (!Array.isArray(prompts) || prompts.length === 0) return '';

  const chunks = [];

  const renderMsgs = (arr) => {
    if (!Array.isArray(arr)) return ['  (none)'];
    return arr.map(m => `  - ${m.speaker || 'Unknown'}: ${m.text}`);
  };

  const renderItems = (arr) => {
    if (!Array.isArray(arr)) return ['  (none)'];
    return arr.map(i => `  - ${i.category} — ${i.speaker || 'Unknown'}: '${i.text}'`);
  };

  const renderActions = (arr) => {
    if (!Array.isArray(arr)) return ['  (none)'];
    return arr.map(a => {
      const rego = (a.rego || '').toUpperCase() || '—';
      const car  = [a.make, a.model].filter(Boolean).join(' ') || '—';
      switch (a.type) {
        case 'REPAIR':              return `  - REPAIR: {rego ${rego} • ${car}, task: ${a.checklistItem || 'repair'}}`;
        case 'RECON_APPOINTMENT':   return `  - RECON_APPOINTMENT: {rego ${rego} • ${car}, category: ${a.category || 'Uncategorized'}}`;
        case 'LOCATION_UPDATE':     return `  - LOCATION_UPDATE: {rego ${rego}, at: ${a.location || 'unknown'}}`;
        case 'CUSTOMER_APPOINTMENT':return `  - CUSTOMER_APPOINTMENT: {rego ${rego}, ${a.name || '—'} @ ${a.dateTime || '—'}}`;
        case 'NEXT_LOCATION':       return `  - NEXT_LOCATION: {rego ${rego} → ${a.nextLocation || '—'}}`;
        case 'DROP_OFF':            return `  - DROP_OFF: {rego ${rego} → ${a.destination || '—'}}`;
        case 'TASK':                return `  - TASK: {rego ${rego}, ${a.task || '—'}}`;
        case 'READY':               return `  - READY: {rego ${rego}}`;
        case 'SOLD':                return `  - SOLD: {rego ${rego}}`;
        default:                    return `  - ${a.type || 'UNKNOWN'}: {rego ${rego}}`;
      }
    });
  };

  for (const p of prompts) {
    const name = String(p.name || '').trim();

    // Shape-sensitive pretty print
    let inputLines = [];
    let outputLines = [];

    // Input
    if (name === 'FILTER_SYSTEM' || name === 'REFINE_SYSTEM') {
      // Expect {messages:[{speaker,text}]}
      const msgs = p?.inputObj?.messages
        ? p.inputObj.messages
        : // fallback: when we recorded plain text payload
          String(p.inputObj || '')
            .split('\n')
            .filter(Boolean)
            .map(t => {
              const m = t.match(/^([^:]+):\s*'?(.*?)'?$/);
              return { speaker: m?.[1] || 'Unknown', text: m?.[2] || t };
            });
      inputLines = renderMsgs(msgs);
      const outMsgs = p?.outputObj?.messages || [];
      outputLines = renderMsgs(outMsgs);
    } else if (name === 'CATEGORIZE_SYSTEM') {
      // Expect {items:[{speaker,text,category}]}
      const msgs = String(p.inputObj || '')
        .split('\n')
        .filter(Boolean)
        .map(t => {
          const m = t.match(/^([^:]+):\s*'?(.*?)'?$/);
          return { speaker: m?.[1] || 'Unknown', text: m?.[2] || t };
        });
      inputLines = renderMsgs(msgs);
      const items = p?.outputObj?.items || [];
      outputLines = renderItems(items);
    } else if (String(name).startsWith('EXTRACT_')) {
      // Expect {actions:[...]}
      // Input could be text; show as simple one-liners
      inputLines = String(p.inputObj || '')
        ? String(p.inputObj).split('\n').filter(Boolean).map(t => `  - ${t}`)
        : ['  (none)'];
      const actions = p?.outputObj?.actions || [];
      outputLines = renderActions(actions);
    } else {
      // Generic fallback
      inputLines = String(p.inputObj || '') ? [`  ${String(p.inputObj)}`] : ['  (none)'];
      outputLines = p.outputObj ? [`  ${JSON.stringify(p.outputObj)}`] : ['  (none)'];
    }

    chunks.push(
      ` PROMPT: ${name}\n${BAR}\nINPUT:\n${inputLines.join('\n')}\nOUTPUT:\n${outputLines.join('\n')}`
    );
  }

  return `\n ${title.toUpperCase()}\n${BAR}\n${chunks.join('\n')}\n`;
}

function sectionCat(title, categorized) {
  if (!Array.isArray(categorized) || categorized.length === 0) return '';
  const lines = categorized.map(c => `- ${c.category} — ${c.text}`);
  return `\n ${title.toUpperCase()}\n${BAR}\n${lines.join('\n')}\n`;
}

function sectionExtractors(title, extractsJson) {
  if (!Array.isArray(extractsJson) || extractsJson.length === 0) return '';
  const chunks = [];
  for (const e of extractsJson) {
    let pretty = '';
    try {
      const obj = JSON.parse(e.jsonString || '{}');
      const acts = Array.isArray(obj.actions) ? obj.actions : [];
      pretty = acts.length
        ? acts.map(a => {
            const rego = (a.rego || '').toUpperCase() || '—';
            const car  = [a.make, a.model].filter(Boolean).join(' ') || '—';
            switch (a.type) {
              case 'REPAIR':              return `  - REPAIR: {rego ${rego} • ${car}, task: ${a.checklistItem || 'repair'}}`;
              case 'RECON_APPOINTMENT':   return `  - RECON_APPOINTMENT: {rego ${rego} • ${car}, category: ${a.category || 'Uncategorized'}}`;
              case 'LOCATION_UPDATE':     return `  - LOCATION_UPDATE: {rego ${rego}, at: ${a.location || 'unknown'}}`;
              case 'CUSTOMER_APPOINTMENT':return `  - CUSTOMER_APPOINTMENT: {rego ${rego}, ${a.name || '—'} @ ${a.dateTime || '—'}}`;
              case 'NEXT_LOCATION':       return `  - NEXT_LOCATION: {rego ${rego} → ${a.nextLocation || '—'}}`;
              case 'DROP_OFF':            return `  - DROP_OFF: {rego ${rego} → ${a.destination || '—'}}`;
              case 'TASK':                return `  - TASK: {rego ${rego}, ${a.task || '—'}}`;
              case 'READY':               return `  - READY: {rego ${rego}}`;
              case 'SOLD':                return `  - SOLD: {rego ${rego}}`;
              default:                    return `  - ${a.type || 'UNKNOWN'}: {rego ${rego}}`;
            }
          }).join('\n')
        : '  - (no actions)';
    } catch {
      pretty = '  - (unparsable extractor output)';
    }
    chunks.push(`# ${e.label.toUpperCase()}\n${pretty}`);
  }
  return `\n ${title.toUpperCase()}\n${BAR}\n${chunks.join('\n')}\n`;
}

/* ----------------- Final print ----------------- */
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
    (s.extractAll ? `\n FINAL OUTPUT & ACTIONS\n${BAR}\n  ${s.extractAll}\n` : '') +
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
  recordPhoto,
  recordRego,
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
