// src/services/logging/timelineLogger.js
const { randomUUID } = require("crypto");

const _store = new Map();

function newContext({ chatId }) {
  const id = typeof randomUUID === "function" ? randomUUID() : Math.random().toString(36).slice(2) + Date.now();
  const ctx = {
    id,
    chatId,
    batched: [],
    p1: [],
    p2: [],
    p3: [],
    extracts: [],
    extractAll: "",
    ident: [],
    changes: [],
    // QA
    qaSummary: "",
    qaLines: [],
    qaFlags: [],
  };
  _store.set(id, ctx);
  return ctx;
}

function get(idOrCtx) {
  const id = typeof idOrCtx === "string" ? idOrCtx : idOrCtx?.id;
  return _store.get(id) || null;
}

// -------- Basic sections --------
function recordBatch(ctx, messages = []) {
  const s = get(ctx); if (!s) return;
  s.batched = messages.map((m) => `${m.speaker || "Unknown"}: '${m.text}'`);
}
function recordP1(ctx, messages = []) {
  const s = get(ctx); if (!s) return;
  s.p1 = messages.map((m) => `${m.speaker || "Unknown"}: '${m.text}'`);
}
function recordP2(ctx, messages = []) {
  const s = get(ctx); if (!s) return;
  s.p2 = messages.map((m) => `${m.speaker || "Unknown"}: '${m.text}'`);
}
function recordP3(ctx, items = []) {
  const s = get(ctx); if (!s) return;
  s.p3 = items.map((i) => ({ text: `${i.speaker || "Unknown"}: '${i.text}'`, category: i.category }));
}

// -------- Extractors --------
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

// -------- Identification & changes --------
function identSuccess(ctx, { rego = "", make = "", model = "" } = {}) {
  const s = get(ctx); if (!s) return;
  const label = rego || [make, model].filter(Boolean).join(" ");
  s.ident.push(`✓ Identified: ${label || "(unknown)"}`);
}
function identFail(ctx, { reason = "", rego = "", make = "", model = "" } = {}) {
  const s = get(ctx); if (!s) return;
  const input = rego || [make, model].filter(Boolean).join(" ");
  s.ident.push(`✗ Not identified${input ? ` (${input})` : ""}: ${reason}`);
}
function change(ctx, text = "") {
  const s = get(ctx); if (!s) return;
  if (text) s.changes.push(text);
}

// -------- QA (Audit) --------
function recordAudit(ctx, { summary = "", lines = [], flags = [] } = {}) {
  const s = get(ctx); if (!s) return;
  s.qaSummary = summary || "";
  s.qaLines = Array.isArray(lines) ? lines.slice() : [];
  s.qaFlags = Array.isArray(flags) ? flags.slice() : [];
}
function auditLine(ctx, line) {
  const s = get(ctx); if (!s) return;
  if (line) s.qaLines.push(line);
}

// -------- Printer --------
function print(ctx) {
  const s = get(ctx); if (!s) return;

  // Small helper to format as your clean boxes
  const box = (title, bodyLines) => {
    if (!bodyLines || (Array.isArray(bodyLines) && bodyLines.length === 0)) return "";
    const body = Array.isArray(bodyLines) ? bodyLines.join("\n  - ") : bodyLines;
    return [
      "",
      `──────────────────────────────────`,
      ` ${title}`,
      `──────────────────────────────────`,
      Array.isArray(bodyLines) ? `  - ${body}` : bodyLines,
    ].join("\n");
  };

  const sec = [];

  // Messages
  if (s.batched.length) sec.push(box("MESSAGES", s.batched.map((x) => x.replace(/^(.+)$/, "$1"))));

  // Prompts
  if (s.p1.length) sec.push(box("FILTER", s.p1));
  if (s.p2.length) sec.push(box("REFINE", s.p2));
  if (s.p3.length) {
    const cats = s.p3.map((i) => `${i.category} — ${i.text}`);
    sec.push(box("CATEGORIZE", cats));
  }

  // Extractors (pretty)
  if (s.extracts.length) {
    const lines = [];
    for (const ex of s.extracts) {
      lines.push(`# ${ex.label.toUpperCase()}`);
      lines.push(ex.jsonString);
    }
    sec.push(box("EXTRACTORS — RAW OUTPUTS", lines));
  }

  // Combined actions
  if (s.extractAll) sec.push(box("ACTIONS (COMBINED)", [s.extractAll]));

  // Identification + Changes
  if (s.ident.length) sec.push(box("IDENTIFICATION", s.ident));
  if (s.changes.length) sec.push(box("CHANGES", s.changes));

  // QA AUDIT — clean & compact
  if (s.qaSummary || s.qaLines.length || s.qaFlags.length) {
    const qaOut = [];
    if (s.qaSummary) qaOut.push(`Summary: ${s.qaSummary}`);
    if (s.qaLines.length) {
      // already human-readable lines from the model
      qaOut.push(...s.qaLines);
    }
    if (s.qaFlags.length) {
      for (const f of s.qaFlags) {
        const idxs = (f.actionIndexes || []).join(",");
        qaOut.push(`FLAG • ${f.severity.toUpperCase()} • ${f.code}${idxs ? ` • actions [${idxs}]` : ""} — ${f.message}`);
      }
    }
    sec.push(box("AI AUDIT (READ-ONLY)", qaOut));
  }

  console.log(sec.join("\n") + "\n");
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
  recordAudit,
  auditLine,
  // Print
  print,
};
