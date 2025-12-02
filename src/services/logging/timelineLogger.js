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
    startedAt: new Date().toISOString(),
    sections: [],      // MESSAGES, FILTER, REFINE, CATEGORIZE, PHOTO_MERGER...
    promptOutputs: [], // EXTRACT_* prompts
    actions: [],       // final actions (after audit gate)
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
    output: outputText, // string or object
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
   PRINTER — CRYSTAL CLEAR, ONE BATCH
──────────────────────────────────────────── */
function print(ctx) {
  const s = get(ctx);
  if (!s) return;

  const headerTs = s.startedAt || new Date().toISOString();
  const chatId = s.chatId != null ? s.chatId : "unknown";

  const messagesLines = [];
  const photoLines = [];
  const filterLines = [];
  const refineLines = [];
  const categorizeLines = [];

  for (const blk of s.sections) {
    const title = (blk.title || "").toUpperCase();

    if (title === "MESSAGES") {
      messagesLines.push(...blk.lines);
    } else if (title === "PHOTO_MERGER") {
      photoLines.push(...blk.lines);
    } else if (title === "FILTER") {
      filterLines.push(...blk.lines);
    } else if (title === "REFINE") {
      refineLines.push(...blk.lines);
    } else if (title === "CATEGORIZE") {
      categorizeLines.push(...blk.lines);
    }
  }

  console.log(
    "\n============================================================"
  );
  console.log(`🧾 PIPELINE LOG — chat ${chatId} — ctx ${s.id}`);
  console.log(`   started: ${headerTs}`);
  console.log(
    "============================================================\n"
  );

  /* 0️⃣ RAW MESSAGES */
  if (messagesLines.length) {
    console.log("0️⃣ RAW MESSAGES\n");
    messagesLines.forEach((line, idx) => {
      console.log(`${idx + 1}. ${line}`);
    });
    console.log("");
  }

  /* 0.5️⃣ PHOTO MERGER (if any) */
  if (photoLines.length) {
    console.log("0.5️⃣ PHOTO_MERGER\n");
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
    console.log("4️⃣ EXTRACTORS (model outputs)");
    for (const p of extractorPrompts) {
      console.log(`\n🔹 ${p.name}`);

      let out = p.output;

      // attempt JSON parse if it's a string
      if (typeof out === "string") {
        try {
          out = JSON.parse(out);
        } catch {
          // not JSON, just print raw
          console.log(out);
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
          if (a.checklistItem)
            parts.push(`checklistItem:"${a.checklistItem}"`);
          if (a.readiness) parts.push(`readiness:"${a.readiness}"`);
          if (a.category) parts.push(`category:"${a.category}"`);
          if (a.destination) parts.push(`destination:"${a.destination}"`);
          if (a.nextLocation)
            parts.push(`nextLocation:"${a.nextLocation}"`);
          if (a.dateTime) parts.push(`dateTime:"${a.dateTime}"`);
          if (a.task) parts.push(`task:"${a.task}"`);
          if (a.name) parts.push(`name:"${a.name}"`);
          if (a.service) parts.push(`service:"${a.service}"`);
          if (a.notes) parts.push(`notes:"${a.notes}"`);

          console.log(`  {${parts.join(", ")}}`);
        }
      } else {
        console.log(String(p.output ?? ""));
      }
    }
    console.log("");
  }

  /* 5️⃣ ACTIONS APPLIED TO DB (after audit gate) */
  if (s.actions && s.actions.length) {
    console.log("5️⃣ ACTIONS APPLIED TO DB (after audit gate)\n");
    s.actions.forEach((a, idx) => {
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
      else if (a.type === "DROP_OFF" && a.destination)
        detail = `, destination: ${a.destination}`;
      else if (a.type === "TASK" && a.task)
        detail = `, task: ${a.task}`;

      console.log(
        `${idx + 1}. ${a.type} — ${src} {${car}${detail}}`
      );
    });
    console.log("");
  } else {
    console.log("5️⃣ ACTIONS APPLIED TO DB (after audit gate)\n");
    console.log("(no actions)\n");
  }

  /* 6️⃣ AUDIT SUMMARY */
  if (s.audit && s.audit.summary) {
    const sum = s.audit.summary;
    console.log("6️⃣ AUDIT SUMMARY\n");
    console.log(
      `   total: ${sum.total}, ` +
        `correct: ${sum.correct}, ` +
        `partial: ${sum.partial}, ` +
        `incorrect: ${sum.incorrect}, ` +
        `unsure: ${sum.unsure}`
    );
    console.log("");
  }

  /* 7️⃣ AUDIT DETAIL PER ACTION */
  console.log("7️⃣ AUDIT DETAIL PER ACTION\n");

  if (s.audit && Array.isArray(s.audit.items) && s.actions.length) {
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
      else if (act.type === "DROP_OFF" && act.destination)
        detail = `, destination: ${act.destination}`;
      else if (act.type === "TASK" && act.task)
        detail = `, task: ${act.task}`;

      const src = `${act._sourceSpeaker || ""}: '${act._sourceText || ""}'`;
      const base = `${act.type} — ${src} {${car}${detail}}`;

      const reasonPart = it.reason ? ` — reason: ${it.reason}` : "";
      const evidencePart = it.evidenceText
        ? ` — evidence: "${it.evidenceText}"`
        : "";

      console.log(
        `- [${it.verdict}] ${base}${reasonPart}${evidencePart}`
      );
    }
  } else {
    console.log("(no audit items)");
  }

  console.log(
    "\n==================== END PIPELINE LOG ====================\n"
  );

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
  // legacy (no-op)
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
