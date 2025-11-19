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
    sections: [],      // MESSAGES, FILTER, REFINE, CATEGORIZE...
    promptOutputs: [], // EXTRACT_* prompts
    actions: [],       // final actions
    audit: null,       // audit object
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
    title: String(title || ""),
    lines: Array.isArray(lines) ? lines.map(String) : [String(lines || "")],
  });
}

function prompt(ctx, name, { inputText = "", outputText = "" } = {}) {
  const s = get(ctx);
  if (!s) return;

  s.promptOutputs.push({
    name: String(name || ""),
    input: inputText || "",
    output: outputText, // can be string or object
  });
}

/* ────────────────────────────────────────────
   ACTIONS + AUDIT STORAGE
──────────────────────────────────────────── */
function actions(ctx, acts = []) {
  const s = get(ctx);
  if (!s) return;
  s.actions = Array.isArray(acts) ? acts : [];
}

function recordAudit(ctx, auditObj) {
  const s = get(ctx);
  if (!s) return;
  s.audit = auditObj || null;
}

/* ────────────────────────────────────────────
   PRINTER — EXACT 0️⃣–4️⃣ STYLE
──────────────────────────────────────────── */
function print(ctx) {
  const s = get(ctx);
  if (!s) return;

  const photoLines = [];
  const filterLines = [];
  const refineLines = [];
  const categorizeLines = [];

  for (const blk of s.sections) {
    const title = (blk.title || "").toUpperCase();

    if (title === "PHOTO_MERGER") {
      photoLines.push(...blk.lines);
    } else if (title === "FILTER") {
      filterLines.push(...blk.lines);
    } else if (title === "REFINE") {
      refineLines.push(...blk.lines);
    } else if (title === "CATEGORIZE") {
      categorizeLines.push(...blk.lines);
    }
  }

  /* 0️⃣ PHOTO_MERGER */
  if (photoLines.length) {
    console.log("0️⃣ PHOTO_MERGER\n");
    console.log("Output:\n");
    for (const line of photoLines) console.log(line);
    console.log("");
  }

  /* 1️⃣ FILTER */
  if (filterLines.length) {
    console.log("1️⃣ FILTER\n");
    console.log("Output:\n");
    for (const line of filterLines) console.log(line);
    console.log("");
  }

  /* 2️⃣ REFINE */
  if (refineLines.length) {
    console.log("2️⃣ REFINE\n");
    console.log("Output:\n");
    for (const line of refineLines) console.log(line);
    console.log("");
  }

  /* 3️⃣ CATEGORIZE */
  if (categorizeLines.length) {
    console.log("3️⃣ CATEGORIZE\n");
    console.log("Output:\n");
    for (const line of categorizeLines) console.log(line);
    console.log("");
  }

  /* 4️⃣ EXTRACTORS (EXTRACT_*) */
  const extractorPrompts = s.promptOutputs.filter((p) =>
    String(p.name || "").toUpperCase().startsWith("EXTRACT_")
  );

  if (extractorPrompts.length) {
    console.log("4️⃣ EXTRACTORS");
    for (const p of extractorPrompts) {
      console.log(p.name);

      let out = p.output;

      // handle both JSON strings and plain objects
      if (typeof out === "string") {
        try {
          out = JSON.parse(out);
        } catch {
          // not JSON, just print raw
          console.log(out);
          console.log("");
          continue;
        }
      }

      if (out && Array.isArray(out.actions)) {
        for (const a of out.actions) {
          const parts = [];
          parts.push(`type:"${a.type}"`);
          parts.push(`rego:"${a.rego || ""}"`);
          parts.push(`make:"${a.make || ""}"`);
          parts.push(`model:"${a.model || ""}"`);
          if (a.badge) parts.push(`badge:"${a.badge}"`);
          if (a.description) parts.push(`description:"${a.description}"`);
          if (a.year) parts.push(`year:"${a.year}"`);
          if (a.checklistItem) parts.push(`checklistItem:"${a.checklistItem}"`);
          if (a.readiness) parts.push(`readiness:"${a.readiness}"`);
          if (a.category) parts.push(`category:"${a.category}"`);
          if (a.destination) parts.push(`destination:"${a.destination}"`);
          if (a.nextLocation) parts.push(`nextLocation:"${a.nextLocation}"`);
          if (a.dateTime) parts.push(`dateTime:"${a.dateTime}"`);
          if (a.task) parts.push(`task:"${a.task}"`);
          if (a.name) parts.push(`name:"${a.name}"`);
          if (a.service) parts.push(`service:"${a.service}"`);
          if (a.notes) parts.push(`notes:"${a.notes}"`);

          console.log(`{${parts.join(", ")}}`);
        }
      } else {
        console.log(String(p.output ?? ""));
      }
      console.log(""); // blank line between extractors
    }
  }

  /* FINAL OUTPUT LINES (already match your format) */
  if (s.actions && s.actions.length) {
    console.log("OUTPUT");
    for (const a of s.actions) {
      const src = `${a._sourceSpeaker || ""}: '${a._sourceText || ""}'`;
      const car =
        [a.rego, [a.make, a.model].filter(Boolean).join(" ")]
          .filter(Boolean)
          .join(" • ") || "no-rego";

      let detail = "";
      if (a.type === "REPAIR" && a.checklistItem)
        detail = `, task: ${a.checklistItem}`;
      else if (a.type === "READY" && a.readiness)
        detail = `, readiness: ${a.readiness}`;
      else if (a.type === "RECON_APPOINTMENT" && a.category)
        detail = `, category: ${a.category}`;

      console.log(`- ${a.type} — ${src} {${car}${detail}}`);
    }
  }

  /* ANALYSIS OF EACH LINE */
  console.log("\nANALYSIS OF EACH LINE");

  if (s.audit && Array.isArray(s.audit.items)) {
    for (const it of s.audit.items) {
      const act = s.actions[it.actionIndex];
      if (!act) continue;

      const car =
        [act.rego, [act.make, act.model].filter(Boolean).join(" ")]
          .filter(Boolean)
          .join(" • ") || "no-rego";

      let detail = "";
      if (act.type === "REPAIR" && act.checklistItem)
        detail = `, task: ${act.checklistItem}`;
      else if (act.type === "READY" && act.readiness)
        detail = `, readiness: ${act.readiness}`;
      else if (act.type === "RECON_APPOINTMENT" && act.category)
        detail = `, category: ${act.category}`;

      const src = `${act._sourceSpeaker || ""}: '${act._sourceText || ""}'`;
      const base = `${act.type} — ${src} {${car}${detail}}`;

      const reasonPart = it.reason ? ` — reason: ${it.reason}` : "";
      const evidencePart = it.evidenceText
        ? ` — evidence: "${it.evidenceText}"`
        : "";

      console.log(`- ${base}: ${it.verdict}${reasonPart}${evidencePart}`);
    }
  }

  _store.delete(s.id);
}

/* ────────────────────────────────────────────
   LEGACY NO-OP SHIMS
──────────────────────────────────────────── */
function recordPrompt() {}
function identSuccess() {}
function identFail() {}
function change() {}
function repair() {}
function ready() {}
function dropOff() {}
function customerAppointment() {}
function reconAppointment() {}
function nextLocation() {}
function task() {}
function sold() {}
function locationUpdate() {}

module.exports = {
  newContext,
  section,
  prompt,
  actions,
  recordAudit,
  print,
  // legacy
  recordPrompt,
  identSuccess,
  identFail,
  change,
  repair,
  ready,
  dropOff,
  customerAppointment,
  reconAppointment,
  nextLocation,
  task,
  sold,
  locationUpdate,
};
