// src/services/logging/timelineLogger.js
const { randomUUID } = require('crypto');

const _store = new Map();

// Optional TTY colors (auto-off if not a terminal)
const isTTY = !!(process.stdout && process.stdout.isTTY);
const C = isTTY ? {
  bold: s => `\x1b[1m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
} : { bold: s => s, dim: s => s };

const HR = "_".repeat(38);
const HR_LONG = "_".repeat(70);

function idOf() {
  return typeof randomUUID === 'function'
    ? randomUUID()
    : Math.random().toString(36).slice(2) + Date.now();
}

function safeStr(x) {
  if (x == null) return "";
  try { return String(x); } catch { return ""; }
}
function oneLine(s, max = 200) {
  s = safeStr(s).replace(/\s+/g, " ").trim();
  return s.length > max ? (s.slice(0, max - 1) + "…") : s;
}
function sect(title) {
  return `\n${HR}\n${title}\n\n`;
}

function newContext({ chatId }) {
  const id = idOf();
  const ctx = {
    id,
    chatId,

    // Sections
    messages: [],            // [{speaker,text}]
    photoAnalysis: [],       // [string]
    regoChecks: [],          // [{ok, make, model, rego, notes}]
    carCreates: [],          // [{make, model, rego, id?}]

    // Prompts (arbitrary)
    prompts: [],             // [{name, inputText, outputText}]

    // Legacy P1/P2/P3 capture for compatibility (also mirrored into prompts)
    p1: [],                  // [{speaker,text}]
    p2: [],                  // [{speaker,text}]
    p3: [],                  // [{speaker,text,category}]

    // Extractors
    extracts: [],            // [{label, jsonString}]
    extractAll: '',          // stringified {"actions":[...]}

    // QA audit payloads (normalized into a clean print)
    qa: null,                // {items:[...], summary:{...}} or raw obj

    // Identities / changes
    ident: [],               // ["✓ Identified: XYZ", ...]
    changes: [],             // ["Merged X into Y", ...]
  };
  _store.set(id, ctx);
  return ctx;
}

function get(idOrCtx) {
  const id = typeof idOrCtx === 'string' ? idOrCtx : idOrCtx?.id;
  return _store.get(id) || null;
}

/* ---------------------------
 * SECTION RECORDERS
 * ------------------------- */
// Messages
function recordBatch(ctx, messages = []) {
  const s = get(ctx); if (!s) return;
  s.messages = (Array.isArray(messages) ? messages : [])
    .map(m => ({ speaker: m.speaker || 'Unknown', text: safeStr(m.text) }));
}

// Photo analysis
function recordPhotoAnalysis(ctx, lines = []) {
  const s = get(ctx); if (!s) return;
  const arr = Array.isArray(lines) ? lines : [lines];
  s.photoAnalysis.push(...arr.map(oneLine));
}

// Rego checker / matcher
function recordRegoMatch(ctx, { ok = false, make = '', model = '', rego = '', notes = '' } = {}) {
  const s = get(ctx); if (!s) return;
  s.regoChecks.push({ ok: !!ok, make: safeStr(make), model: safeStr(model), rego: safeStr(rego).toUpperCase(), notes: oneLine(notes) });
}

// Car creator
function recordCarCreate(ctx, { make = '', model = '', rego = '', id = '' } = {}) {
  const s = get(ctx); if (!s) return;
  s.carCreates.push({ make: safeStr(make), model: safeStr(model), rego: safeStr(rego).toUpperCase(), id: safeStr(id) });
}

// Generic prompt recorder
function recordPrompt(ctx, name, { inputText = '', outputText = '' } = {}) {
  const s = get(ctx); if (!s) return;
  s.prompts.push({
    name: safeStr(name),
    inputText: oneLine(inputText, 2000),    // keep long but single-line
    outputText: oneLine(outputText, 2000),
  });
}

/* -------- Back-compat: P1/P2/P3 – also mirrored into prompts -------- */
function _fmtMsgs(messages = []) {
  return (messages || []).map(m => `${m.speaker || 'Unknown'}: '${safeStr(m.text)}'`).join('\n');
}
function recordP1(ctx, messages = []) {
  const s = get(ctx); if (!s) return;
  s.p1 = (messages || []).map(m => ({ speaker: m.speaker || 'Unknown', text: safeStr(m.text) }));
  recordPrompt(ctx, 'FILTER_SYSTEM', { inputText: '', outputText: JSON.stringify({ messages: s.p1 }) });
}
function recordP2(ctx, messages = []) {
  const s = get(ctx); if (!s) return;
  s.p2 = (messages || []).map(m => ({ speaker: m.speaker || 'Unknown', text: safeStr(m.text) }));
  recordPrompt(ctx, 'REFINE_SYSTEM', { inputText: '', outputText: JSON.stringify({ messages: s.p2 }) });
}
function recordP3(ctx, items = []) {
  const s = get(ctx); if (!s) return;
  s.p3 = (items || []).map(i => ({
    speaker: i.speaker || 'Unknown',
    text: safeStr(i.text),
    category: safeStr(i.category),
  }));
  recordPrompt(ctx, 'CATEGORIZE_SYSTEM', { inputText: '', outputText: JSON.stringify({ items: s.p3 }) });
}

/* -------- Extractors & combined -------- */
function recordExtract(ctx, label, rawObj) {
  const s = get(ctx); if (!s) return;
  try { s.extracts.push({ label: safeStr(label), jsonString: JSON.stringify(rawObj) }); }
  catch { s.extracts.push({ label: safeStr(label), jsonString: '{"actions":[]}' }); }
}
function recordExtractAll(ctx, actions = []) {
  const s = get(ctx); if (!s) return;
  try { s.extractAll = JSON.stringify({ actions }); }
  catch { s.extractAll = '{"actions":[]}'; }
}

/* -------- QA / Audit -------- */
function recordQAAudit(ctx, qaPayload) {
  const s = get(ctx); if (!s) return;
  // store raw; print() will render nicely
  s.qa = qaPayload || null;
}

/* -------- Identity / changes helpers (unchanged) -------- */
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

/* ---------------------------
 * PRINT (exact structure requested)
 * ------------------------- */
function print(ctx) {
  const s = get(ctx); if (!s) return;

  let out = "";

  // 1) Messages
  if (s.messages.length) {
    out += sect('Messages');
    for (const m of s.messages) {
      out += `${m.speaker}: ${m.text}\n`;
    }
  }

  // 2) Photo Analysis
  if (s.photoAnalysis.length) {
    out += sect('Photo Analysis');
    for (const line of s.photoAnalysis) out += line + "\n";
  }

  // 3) Rego Checker/Matcher
  if (s.regoChecks.length) {
    out += sect('Rego Checker/Matcher');
    for (const r of s.regoChecks) {
      const status = r.ok ? "Car identified" : "Not identified";
      const detail = [r.make, r.model, r.rego].filter(Boolean).join(", ");
      out += `${status}: ${detail || "-"}${r.notes ? ` (${r.notes})` : ""}\n`;
    }
  }

  // 4) Car Creator (if necessary)
  if (s.carCreates.length) {
    out += sect('(if necessary) Car Creator');
    for (const c of s.carCreates) {
      const detail = [c.make, c.model, c.rego].filter(Boolean).join(", ");
      out += `Car Created: ${detail}${c.id ? ` [${c.id}]` : ""}\n`;
    }
  }

  // 5) Prompts — each prompt as its own block, in order received
  if (s.prompts.length) {
    for (const p of s.prompts) {
      out += sect(`Prompt ${p.name}`);
      out += "INPUT\n";
      out += (p.inputText ? (p.inputText + "\n") : "[none]\n");
      out += "\nOUTPUT\n";
      out += (p.outputText ? (p.outputText + "\n") : "[none]\n");
    }
  }

  // 6) Final output and actions
  if (s.extractAll) {
    out += sect('Final output and actions');
    out += (s.extractAll + "\n");
  }

  // 7) AI Audit (QA) — printed last and clearly
  if (s.qa) {
    out += `\n${HR_LONG}\n${C.bold('AI AUDIT (QA)')}\n\n`;
    try {
      const qa = typeof s.qa === 'string' ? JSON.parse(s.qa) : s.qa;
      const items = Array.isArray(qa.items) ? qa.items : [];
      const summary = qa.summary || null;

      if (summary) {
        const sLine = `Summary: ok=${summary.ok ?? "-"}  flagged=${summary.flagged ?? "-"}  total=${summary.total ?? "-"}`;
        out += sLine + "\n\n";
      }

      if (items.length) {
        for (const it of items) {
          const idx = (it.idx != null) ? `#${it.idx} ` : "";
          const cat = it.category ? `[${it.category}] ` : "";
          const reg = it.rego ? `${it.rego.toUpperCase()} ` : "";
          out += `${idx}${cat}${reg}${it.ok === false ? 'FLAG' : 'OK'}\n`;
          if (it.flag) out += `  FLAG: ${it.flag}\n`;
          if (it.suggest) out += `  SUGGEST: ${it.suggest}\n`;
          if (it.src) out += `  SRC: ${oneLine(it.src, 200)}\n`;
          out += "\n";
        }
      } else {
        out += "(no QA items)\n";
      }
    } catch {
      out += oneLine(s.qa, 2000) + "\n";
    }
  }

  // 8) Identification (optional)
  if (s.ident.length) {
    out += sect('Identification');
    for (const line of s.ident) out += line + "\n";
  }

  // 9) Changes (optional)
  if (s.changes.length) {
    out += sect('Changes');
    for (const line of s.changes) out += "• " + line + "\n";
  }

  // Final print + cleanup
  console.log("\n" + out.trimEnd() + "\n");
  _store.delete(s.id);
}

module.exports = {
  newContext,
  get,

  // Sections
  recordBatch,
  recordPhotoAnalysis,
  recordRegoMatch,
  recordCarCreate,
  recordPrompt,

  // Back-compat
  recordP1,
  recordP2,
  recordP3,

  // Extractors / final
  recordExtract,
  recordExtractAll,

  // QA
  recordQAAudit,

  // Identity / changes
  identSuccess,
  identFail,
  change,

  // Print
  print,
};
