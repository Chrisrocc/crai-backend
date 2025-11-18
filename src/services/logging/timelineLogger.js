const { randomUUID } = require('crypto');

const _store = new Map();

// ---------- tiny helpers ----------
const idOf = (x) => (typeof x === 'string' ? x : x?.id);
const safeArr = (x) => (Array.isArray(x) ? x : []);
const cap = (s) => String(s || '');
const joinNonEmpty = (arr, sep = ' ') => arr.filter(Boolean).join(sep);
const trimLen = (s, n = 160) => (s.length > n ? s.slice(0, n) + ' …' : s);

const box = (title) => {
  const line = '─'.repeat(Math.max(34, title.length + 2));
  return `\n${line}\n ${title}\n${line}`;
};
const bullet = (s) => `  - ${s}`;

// ---------- compact action renderers ----------
function summarizeAction(a) {
  const rego = cap(a.rego);
  const mm = joinNonEmpty([cap(a.make), cap(a.model)], ' ');
  const badge = cap(a.badge);
  const desc = cap(a.description);
  const year = cap(a.year);

  const head = joinNonEmpty(
    [
      rego && `rego ${rego}`,
      mm && mm,
      badge && `(${badge})`,
      year && `(${year})`,
    ],
    ' • '
  );

  switch (a.type) {
    case 'LOCATION_UPDATE':
      return `LOCATION_UPDATE: {${head}${head ? ', ' : ''}location: ${cap(a.location)}}`;
    case 'SOLD':
      return `SOLD: {${head || 'vehicle'}}`;
    case 'REPAIR': {
      const parts = cap(a.checklistItem || desc || 'repair');
      return `REPAIR: {${head}${head ? ', ' : ''}task: ${parts}}`;
    }
    case 'READY': {
      const r = cap(a.readiness || 'ready');
      return `READY: {${head}${head ? ', ' : ''}${r}}`;
    }
    case 'DROP_OFF': {
      const dest = cap(a.destination);
      const note = cap(a.note);
      return `DROP_OFF: {${head}${head ? ', ' : ''}to: ${dest}${note ? `, note: ${note}` : ''}}`;
    }
    case 'CUSTOMER_APPOINTMENT': {
      const name = cap(a.name);
      const dt = cap(a.dateTime);
      const notes = cap(a.notes);
      return `CUSTOMER_APPOINTMENT: {${head}${head ? ', ' : ''}${joinNonEmpty([name && `name: ${name}`, dt && `time: ${dt}`, notes && `notes: ${notes}`], ', ')}}`;
    }
    case 'RECON_APPOINTMENT': {
      const svc = cap(a.service);
      const cat = cap(a.category);
      const dt = cap(a.dateTime);
      const notes = cap(a.notes);
      return `RECON_APPOINTMENT: {${head}${head ? ', ' : ''}${joinNonEmpty([cat && `category: ${cat}`, svc && `service: ${svc}`, dt && `time: ${dt}`, notes && `notes: ${notes}`], ', ')}}`;
    }
    case 'NEXT_LOCATION': {
      return `NEXT_LOCATION: {${head}${head ? ', ' : ''}next: ${cap(a.nextLocation)}}`;
    }
    case 'TASK': {
      return `TASK: {${head}${head ? ', ' : ''}${cap(a.task)}}`;
    }
    default:
      return `${a.type || 'ACTION'}: {${head || 'vehicle'}}`;
  }
}

function compactActionsList(actions = []) {
  return safeArr(actions).map((a) => bullet(summarizeAction(a))).join('\n');
}

// ---------- state ----------
function newContext({ chatId }) {
  const id =
    typeof randomUUID === 'function'
      ? randomUUID()
      : Math.random().toString(36).slice(2) + Date.now();

  const ctx = {
    id,
    chatId,

    // inputs
    batched: [],           // [{speaker,text}]
    photoAnalysis: [],     // [string]
    regoOk: [],            // [string]
    regoFail: [],          // [string]
    carCreated: [],        // [string]

    // prompts (legacy buckets)
    p1: [], // filtered messages
    p2: [], // refined messages
    p3: [], // categorized items [{speaker,text,category}]

    // generic prompts if you want: recordPrompt(name,input,output)
    prompts: [],           // [{name,input,output}]

    // extractor raw outputs and combined actions
    extracts: [],          // [{label, raw}] where raw is {actions:[...]} or anything
    actions: [],

    // audit / notes
    identNotes: [],        // ✓/✗ lines
    changes: [],           // • change lines
    audit: [],             // overall QA audit lines
  };

  _store.set(id, ctx);
  return ctx;
}
const get = (x) => _store.get(idOf(x)) || null;

// ---------- recorders ----------
function recordBatch(ctx, messages = []) { const s = get(ctx); if (s) s.batched = safeArr(messages); }
function recordPhoto(ctx, lines = [])     { const s = get(ctx); if (s) s.photoAnalysis.push(...safeArr(lines)); }

function recordRegoSuccess(ctx, label)    { const s = get(ctx); if (s) s.regoOk.push(cap(label)); }
function recordRegoFail(ctx, label)       { const s = get(ctx); if (s) s.regoFail.push(cap(label)); }
function recordCarCreated(ctx, label)     { const s = get(ctx); if (s) s.carCreated.push(cap(label)); }

function recordP1(ctx, messages = [])     { const s = get(ctx); if (s) s.p1 = safeArr(messages); }
function recordP2(ctx, messages = [])     { const s = get(ctx); if (s) s.p2 = safeArr(messages); }
function recordP3(ctx, items = [])        { const s = get(ctx); if (s) s.p3 = safeArr(items); }

function recordPrompt(ctx, name, input, output) {
  const s = get(ctx); if (!s) return;
  s.prompts.push({ name: cap(name || 'PROMPT'), input, output });
}

function recordExtract(ctx, label, rawObj) {
  const s = get(ctx); if (!s) return;
  s.extracts.push({ label: cap(label), raw: rawObj });
}
function recordExtractAll(ctx, actions = []) {
  const s = get(ctx); if (!s) return;
  s.actions = safeArr(actions);
}

function identSuccess(ctx, { rego = '', make = '', model = '' } = {}) {
  const s = get(ctx); if (!s) return;
  const label = rego || joinNonEmpty([make, model]);
  s.identNotes.push(`✓ Identified: ${label || '(unknown)'}`);
}
function identFail(ctx, { reason = '', rego = '', make = '', model = '' } = {}) {
  const s = get(ctx); if (!s) return;
  const label = rego || joinNonEmpty([make, model]);
  s.identNotes.push(`✗ Not identified${label ? ` (${label})` : ''}${reason ? `: ${reason}` : ''}`);
}
function change(ctx, text = '') { const s = get(ctx); if (!s) return; if (text) s.changes.push(text); }
function auditLine(ctx, text = '') { const s = get(ctx); if (!s) return; if (text) s.audit.push(text); }

// ---------- rendering ----------
function fmtMsgs(msgs = []) {
  if (!msgs.length) return '  (none)';
  return msgs.map((m) => bullet(`${cap(m.speaker || 'Unknown')}: ${trimLen(cap(m.text))}`)).join('\n');
}
function fmtCats(items = []) {
  if (!items.length) return '  (none)';
  return items
    .map((i) => bullet(`${cap(i.category)} — ${cap(i.speaker || 'Unknown')}: ${trimLen(cap(i.text))}`))
    .join('\n');
}
function fmtExtractorBlocks(extracts = []) {
  const lines = [];
  for (const e of safeArr(extracts)) {
    const label = e.label ? e.label.toUpperCase() : 'EXTRACT';
    let actions = [];
    try {
      const raw = typeof e.raw === 'string' ? JSON.parse(e.raw) : e.raw;
      if (raw && Array.isArray(raw.actions)) actions = raw.actions;
    } catch { /* ignore */ }
    if (actions.length) {
      lines.push(`\n# ${label}\n${compactActionsList(actions)}`);
    }
  }
  return lines.join('');
}

function print(ctx) {
  const s = get(ctx); if (!s) return;

  let out = '';

  // 1) Messages (input)
  out += box('MESSAGES');
  out += `\n${fmtMsgs(s.batched)}\n`;

  // 2) Photo analysis (optional)
  if (s.photoAnalysis.length) {
    out += box('PHOTO ANALYSIS');
    out += '\n' + s.photoAnalysis.map((x) => bullet(trimLen(cap(x)))).join('\n') + '\n';
  }

  // 3) Rego checker / creator
  out += box('REGO CHECKER / MATCHER');
  if (!s.regoOk.length && !s.regoFail.length) {
    out += '\n  (no rego results)\n';
  } else {
    if (s.regoOk.length) out += '\nCar identified:\n' + s.regoOk.map((x) => bullet(x)).join('\n') + '\n';
    if (s.regoFail.length) out += '\nNot identified:\n' + s.regoFail.map((x) => bullet(x)).join('\n') + '\n';
  }
  if (s.carCreated.length) {
    out += box('CAR CREATOR');
    out += '\n' + s.carCreated.map((x) => bullet(x)).join('\n') + '\n';
  }

  // 4) Prompts (compact)
  out += box('FILTER');
  out += '\nINPUT:'  + (s.batched.length ? `\n${fmtMsgs(s.batched)}` : ' (none)');
  out += '\nOUTPUT:' + (s.p1.length ? `\n${fmtMsgs(s.p1)}`       : ' (none)');

  out += box('REFINE');
  out += '\nINPUT:'  + (s.p1.length ? `\n${fmtMsgs(s.p1)}`       : ' (none)');
  out += '\nOUTPUT:' + (s.p2.length ? `\n${fmtMsgs(s.p2)}`       : ' (none)');

  out += box('CATEGORIZE');
  out += '\nINPUT:'  + (s.p2.length ? `\n${fmtMsgs(s.p2)}`       : ' (none)');
  out += '\nOUTPUT:' + (s.p3.length ? `\n${fmtCats(s.p3)}`       : ' (none)');

  // Extra prompts recorded via recordPrompt (render as one compact line each)
  for (const p of safeArr(s.prompts)) {
    out += box(`PROMPT: ${p.name}`);
    if (p.input !== undefined)  out += '\nINPUT:\n'  + bullet(trimLen(cap(typeof p.input === 'string' ? p.input : JSON.stringify(p.input))));
    if (p.output !== undefined) {
      // if output looks like {actions:[…]} show compact list, else show single line
      let rendered = null;
      try {
        const obj = typeof p.output === 'string' ? JSON.parse(p.output) : p.output;
        if (obj && Array.isArray(obj.actions)) rendered = compactActionsList(obj.actions);
      } catch { /* ignore */ }
      out += '\nOUTPUT:\n' + (rendered || bullet(trimLen(cap(typeof p.output === 'string' ? p.output : JSON.stringify(p.output)))));
    }
    out += '\n';
  }

  // 5) Extractors raw → compact
  if (s.extracts.length) {
    out += box('EXTRACTORS');
    out += fmtExtractorBlocks(s.extracts) || '\n  (no extractor outputs)\n';
  }

  // 6) Final actions (compact)
  out += box('FINAL OUTPUT & ACTIONS');
  out += s.actions.length ? '\n' + compactActionsList(s.actions) + '\n' : '\n  (none)\n';

  // 7) AI Audit / Identification / Changes
  if (s.audit.length) {
    out += box('AI AUDIT');
    out += '\n' + s.audit.map((x) => bullet(x)).join('\n') + '\n';
  }
  if (s.identNotes.length) {
    out += box('IDENTIFICATION');
    out += '\n' + s.identNotes.map((x) => bullet(x)).join('\n') + '\n';
  }
  if (s.changes.length) {
    out += box('CHANGES');
    out += '\n' + s.changes.map((x) => bullet(x)).join('\n') + '\n';
  }

  out += '\n' + '═'.repeat(42) + '\n';
  console.log(out);

  _store.delete(s.id);
}

// ---------- exports ----------
module.exports = {
  newContext,
  // inputs
  recordBatch,
  recordPhoto,
  recordRegoSuccess,
  recordRegoFail,
  recordCarCreated,

  // prompt stages
  recordP1,
  recordP2,
  recordP3,
  recordPrompt,

  // extractors / actions
  recordExtract,
  recordExtractAll,

  // audit / notes
  identSuccess,
  identFail,
  change,
  auditLine,

  // output
  print,
};
