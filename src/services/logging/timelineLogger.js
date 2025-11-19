// src/services/logging/timelineLogger.js
const { randomUUID } = require("crypto");
const _store = new Map();

/* ────────────────────────────────────────────
   Context Maker
──────────────────────────────────────────── */
function newContext({ chatId }) {
  const id =
    typeof randomUUID === "function"
      ? randomUUID()
      : Math.random().toString(36).slice(2) + Date.now();

  const ctx = {
    id,
    chatId,
    sections: [],
    promptOutputs: [],
    actions: [],
    audit: null,
    rawMessages: [], // initial messages for audit formatting
  };

  _store.set(id, ctx);
  return ctx;
}

function get(idOrCtx) {
  const id = typeof idOrCtx === "string" ? idOrCtx : idOrCtx?.id;
  return _store.get(id) || null;
}

/* ────────────────────────────────────────────
   SECTION + PROMPT LOGGING
──────────────────────────────────────────── */
function section(ctx, title, lines = []) {
  const s = get(ctx);
  if (!s) return;

  s.sections.push({
    title,
    lines: Array.isArray(lines) ? lines : [String(lines || "")],
  });
}

function prompt(ctx, name, { inputText = "", outputText = "" } = {}) {
  const s = get(ctx);
  if (!s) return;

  s.promptOutputs.push({
    name,
    input: inputText,
    output: outputText,
  });
}

/* ────────────────────────────────────────────
   ACTIONS + AUDIT STORAGE
──────────────────────────────────────────── */
function actions(ctx, acts = []) {
  const s = get(ctx);
  if (!s) return;
  s.actions = acts;
}

function recordAudit(ctx, auditObj) {
  const s = get(ctx);
  if (!s) return;
  s.audit = auditObj;
}

function setRawMessages(ctx, msgs = []) {
  const s = get(ctx);
  if (!s) return;
  s.rawMessages = msgs;
}

/* ────────────────────────────────────────────
   PRINTER — OPTION 1 FORMAT
──────────────────────────────────────────── */
function print(ctx) {
  const s = get(ctx);
  if (!s) return;

  /* ===== INITIAL MESSAGES ===== */
  console.log("INITIAL MESSAGE");
  for (const m of s.rawMessages) {
    console.log(`message text: ${m.text}`);
  }

  /* ===== PROMPT OUTPUTS ===== */
  for (const p of s.promptOutputs) {
    console.log("\n~~~~~~~~~~~~");
    console.log(`PROMPT: ${p.name}`);
    console.log("~~~~~~~~~~~~");
    console.log("INPUT:");
    console.log(p.input);
    console.log("\nOUTPUT:");
    console.log(p.output);
  }

  /* ===== FINAL ACTIONS ===== */
  console.log("\nOUTPUT");
  for (const a of s.actions) {
    const src = `${a._sourceSpeaker || ""}: '${a._sourceText || ""}'`;
    const car =
      [a.rego, [a.make, a.model].filter(Boolean).join(" ")].filter(Boolean).join(" • ") ||
      "no-rego";

    let detail = "";
    if (a.type === "REPAIR" && a.checklistItem)
      detail = `, task: ${a.checklistItem}`;
    else if (a.type === "READY" && a.readiness)
      detail = `, readiness: ${a.readiness}`;
    else if (a.type === "RECON_APPOINTMENT")
      detail = `, category: ${a.category}`;

    console.log(
      `- ${a.type} — ${src} {${car}${detail}}`
    );
  }

  /* ===== AUDIT ===== */
  console.log("\nANALYSIS OF EACH LINE");

  if (!s.audit || !s.audit.items) return;

  for (const it of s.audit.items) {
    const act = s.actions[it.actionIndex];
    if (!act) continue;

    const label = `${act.type}${
      act.checklistItem ? " (" + act.checklistItem + ")" : ""
    }${act.category ? " (" + act.category + ")" : ""}`;

    console.log(
      `- ${label}: ${it.verdict} — reason: ${it.reason}` +
        (it.evidenceText ? ` — evidence: "${it.evidenceText}"` : "")
    );
  }

  _store.delete(s.id);
}

/* ──────────────────────────────────────────── */

module.exports = {
  newContext,
  section,
  prompt,
  actions,
  recordAudit,
  print,
  setRawMessages,
};
