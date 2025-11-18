// src/services/ai/pipeline.js
const { z } = require("zod");
const { chatJSON } = require("./llmClient");
const P = require("../../prompts/pipelinePrompts");
const timeline = require("../logging/timelineLogger");
const ReconditionerCategory = require("../../models/ReconditionerCategory");
const { runAudit } = require("./qa/qaCheck");

// ---------- env / debug ----------
const DEBUG = String(process.env.PIPELINE_DEBUG || "1").trim() === "1";
const dbg = (...args) => {
  if (DEBUG) console.log(...args);
};

/* ================================
   Zod Schemas
================================ */
const Msg = z.object({
  speaker: z.string().default(""),
  text: z.string().default(""),
});

const FilterOut = z.object({
  messages: z.array(Msg).default([]),
});

const CatItem = z.object({
  speaker: z.string(),
  text: z.string(),
  category: z.string(),
});

const CatOut = z.object({
  items: z.array(CatItem).default([]),
});

const Common = {
  rego: z.string().default(""),
  make: z.string().default(""),
  model: z.string().default(""),
  badge: z.string().default(""),
  year: z.string().default(""),
  description: z.string().default(""),
};

const A_Loc = z.object({
  type: z.literal("LOCATION_UPDATE"),
  location: z.string().default(""),
  ...Common,
});
const A_Sold = z.object({
  type: z.literal("SOLD"),
  ...Common,
});
const A_Rep = z.object({
  type: z.literal("REPAIR"),
  checklistItem: z.string().default(""),
  ...Common,
});
const A_Ready = z.object({
  type: z.literal("READY"),
  readiness: z.string().default(""),
  ...Common,
});
const A_Drop = z.object({
  type: z.literal("DROP_OFF"),
  destination: z.string().default(""),
  note: z.string().default(""),
  ...Common,
});
const A_CAppt = z.object({
  type: z.literal("CUSTOMER_APPOINTMENT"),
  name: z.string().default(""),
  dateTime: z.string().default(""),
  notes: z.string().default(""),
  ...Common,
});
const A_RAppt = z.object({
  type: z.literal("RECON_APPOINTMENT"),
  name: z.string().default(""),
  service: z.string().default(""),
  category: z.string().default(""),
  dateTime: z.string().default(""),
  notes: z.string().default(""),
  ...Common,
});
const A_Next = z.object({
  type: z.literal("NEXT_LOCATION"),
  nextLocation: z.string().default(""),
  ...Common,
});
const A_Task = z.object({
  type: z.literal("TASK"),
  task: z.string().default(""),
  ...Common,
});

const ActionsOut = z.object({
  actions: z
    .array(
      z.union([
        A_Loc,
        A_Sold,
        A_Rep,
        A_Ready,
        A_Drop,
        A_CAppt,
        A_RAppt,
        A_Next,
        A_Task,
      ])
    )
    .default([]),
});

/* ================================
   Helpers for dynamic prompts
================================ */
function buildAllowedCatsStringSorted(cats = []) {
  if (!Array.isArray(cats) || cats.length === 0) return '"Other"';
  const sorted = [...cats].sort((a, b) => {
    const ao = Number(a.sortOrder ?? 0);
    const bo = Number(b.sortOrder ?? 0);
    if (ao !== bo) return ao - bo;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  return sorted.map((c) => `"${String(c.name).trim()}"`).join(", ");
}

function buildCatKeywordRuleMapString(cats = []) {
  if (!Array.isArray(cats) || cats.length === 0) return "";
  return cats
    .map((c) => {
      const name = String(c.name || "").trim();
      const items = [
        ...((c.keywords || [])
          .map((k) => String(k).trim().toLowerCase())
          .filter(Boolean)),
        ...((c.rules || [])
          .map((r) => String(r).trim().toLowerCase())
          .filter(Boolean)),
      ];
      const uniq = Array.from(new Set(items));
      const list = uniq.map((t) => `"${t}"`).join(", ");
      return `${name}: [${list}]`;
    })
    .join("\n");
}

function buildCatDefaultServiceMapString(cats = []) {
  if (!Array.isArray(cats) || cats.length === 0) return "";
  return cats
    .map((c) => {
      const name = String(c.name || "").trim();
      const def = String(c.defaultService || "").trim();
      return `${name}: "${def}"`;
    })
    .join("\n");
}

function buildReconHintsFlat(cats = []) {
  const set = new Set();
  for (const c of (Array.isArray(cats) ? cats : [])) {
    for (const k of c.keywords || []) {
      const v = String(k || "").trim().toLowerCase();
      if (v) set.add(v);
    }
    for (const r of c.rules || []) {
      const v = String(r || "").trim().toLowerCase();
      if (v) set.add(v);
    }
  }
  if (set.size === 0) return "";
  return Array.from(set)
    .map((s) => `- "${s}"`)
    .join("\n");
}

const fmt = (msgs) =>
  (Array.isArray(msgs) ? msgs : [])
    .map((m) => `${m.speaker || "Unknown"}: '${m.text}'`)
    .join("\n");

/* ================================
   Duplication Guarantees
================================ */
function applyDuplicationRules(items) {
  const base = Array.isArray(items) ? items : [];
  const out = base.slice();

  for (const it of base) {
    if (it.category === "REPAIR")
      out.push({ ...it, category: "RECON_APPOINTMENT" });
    if (it.category === "RECON_APPOINTMENT")
      out.push({ ...it, category: "REPAIR" });
    if (it.category === "DROP_OFF")
      out.push({ ...it, category: "NEXT_LOCATION" });
  }

  const seen = new Set();
  const deduped = [];
  for (const it of out) {
    const key = `${it.speaker}||${it.text}||${it.category}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(it);
    }
  }
  return deduped;
}

/* ================================
   Step 1–3: Filter → Refine → Categorize
================================ */
async function filterRefineCategorize(batch, tctx) {
  // MESSAGES (human)
  timeline.section(tctx, "MESSAGES", fmt(batch).split("\n"));
  // MESSAGES (JSON)
  timeline.section(
    tctx,
    "MESSAGES (JSON)",
    [JSON.stringify({ messages: batch || [] }, null, 2)]
  );

  // FILTER
  const f = FilterOut.parse(
    await chatJSON({ system: P.FILTER_SYSTEM, user: fmt(batch) })
  );
  timeline.section(
    tctx,
    "FILTER",
    f.messages.map((m) => `${m.speaker}: ${m.text}`)
  );
  timeline.section(
    tctx,
    "FILTER (JSON)",
    [JSON.stringify(f, null, 2)]
  );

  // REFINE
  const r = FilterOut.parse(
    await chatJSON({ system: P.REFINE_SYSTEM, user: fmt(f.messages) })
  );
  timeline.section(
    tctx,
    "REFINE",
    r.messages.map((m) => `${m.speaker}: ${m.text}`)
  );
  timeline.section(
    tctx,
    "REFINE (JSON)",
    [JSON.stringify(r, null, 2)]
  );

  // Categories (dynamic)
  let cats = [];
  try {
    cats = await ReconditionerCategory.find().lean();
  } catch (err) {
    dbg("[PIPELINE] ReconditionerCategory.find() failed:", err?.message || err);
  }

  const reconHintsFlat = buildReconHintsFlat(cats);
  const categorizeSystem = reconHintsFlat
    ? P.CATEGORIZE_SYSTEM_DYNAMIC(reconHintsFlat)
    : P.CATEGORIZE_SYSTEM;

  if (DEBUG) {
    console.log("\n==== PIPELINE DEBUG :: CATEGORIZER (Step 3) ====");
    console.log(
      "Recon hints: (configured from DB, suppressed in logs)"
    );
    const userPayload = fmt(r.messages);
    console.log("\n-- User payload --\n" + (userPayload || "(empty)"));
    console.log("\n-- System prompt: CATEGORIZE (dynamic or static) --");
    console.log("  (full prompt suppressed in logs to keep output clean)");
    console.log("==============================================\n");
  }

  const c = CatOut.parse(
    await chatJSON({ system: categorizeSystem, user: fmt(r.messages) })
  );

  timeline.section(
    tctx,
    "CATEGORIZE",
    c.items.map((i) => `${i.category} — ${i.speaker}: '${i.text}'`)
  );
  timeline.section(
    tctx,
    "CATEGORIZE (JSON)",
    [JSON.stringify(c, null, 2)]
  );

  const withDupes = applyDuplicationRules(c.items);
  return { refined: r.messages, categorized: withDupes };
}

/* ================================
   Step 4: Extraction
================================ */
async function extractActions(items, tctx) {
  const by = {
    LOCATION_UPDATE: [],
    SOLD: [],
    REPAIR: [],
    READY: [],
    DROP_OFF: [],
    CUSTOMER_APPOINTMENT: [],
    RECON_APPOINTMENT: [],
    NEXT_LOCATION: [],
    TASK: [],
    OTHER: [],
  };

  for (const it of Array.isArray(items) ? items : []) {
    (by[it.category] || by.OTHER).push(it);
  }

  const actions = [];

  function findBestSource(candidates = [], act = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    const rego = (act.rego || "").replace(/\s+/g, "").toUpperCase();
    const make = String(act.make || "").toLowerCase();
    const model = String(act.model || "").toLowerCase();

    // 1) Exact rego (whitespace-insensitive) in text
    if (rego) {
      for (const c of candidates) {
        const txt = String(c.text || "");
        const norm = txt.replace(/\s+/g, "").toUpperCase();
        if (norm.includes(rego)) return c;
      }
    }

    // 2) Make + model tokens in text
    const tokens = [make, model].filter(Boolean);
    if (tokens.length) {
      for (const c of candidates) {
        const txt = String(c.text || "").toLowerCase();
        if (tokens.every((t) => txt.includes(t))) {
          return c;
        }
      }
    }

    // 3) Fallback: first candidate
    return candidates[0] || null;
  }

  async function run(cat, sys, label) {
    const candidates = by[cat];
    const userText = (Array.isArray(candidates) ? candidates : [])
      .map((i) => `${i.speaker}: '${i.text}'`)
      .join("\n");
    if (!userText) return;

    const raw = await chatJSON({ system: sys, user: userText });

    // PROMPT log: human + JSON output
    timeline.prompt(tctx, label, {
      inputText: userText,
      outputText: JSON.stringify(raw, null, 2),
    });

    const parsed = ActionsOut.safeParse(raw);
    if (parsed.success) {
      for (const act of parsed.data.actions) {
        const src = findBestSource(candidates, act);
        actions.push({
          ...act,
          _sourceSpeaker: src?.speaker || "",
          _sourceText: src?.text || "",
        });
      }
    }
  }

  await run("LOCATION_UPDATE", P.EXTRACT_LOCATION_UPDATE, "EXTRACT_LOCATION_UPDATE");
  await run("SOLD", P.EXTRACT_SOLD, "EXTRACT_SOLD");
  await run("REPAIR", P.EXTRACT_REPAIR, "EXTRACT_REPAIR");
  await run("READY", P.EXTRACT_READY, "EXTRACT_READY");
  await run("DROP_OFF", P.EXTRACT_DROP_OFF, "EXTRACT_DROP_OFF");
  await run(
    "CUSTOMER_APPOINTMENT",
    P.EXTRACT_CUSTOMER_APPOINTMENT,
    "EXTRACT_CUSTOMER_APPOINTMENT"
  );

  if (by.RECON_APPOINTMENT.length > 0) {
    let cats = [];
    try {
      cats = await ReconditionerCategory.find().lean();
    } catch (err) {
      dbg(
        "[PIPELINE] ReconditionerCategory.find() failed (recon step):",
        err?.message || err
      );
    }

    const allowed = buildAllowedCatsStringSorted(cats);
    const mapKwRules = buildCatKeywordRuleMapString(cats);
    const mapDefaults = buildCatDefaultServiceMapString(cats);

    const sys = P.EXTRACT_RECON_APPOINTMENT_FROM_DB(
      allowed,
      mapKwRules,
      mapDefaults
    );

    const candidates = by.RECON_APPOINTMENT;
    const userText = (Array.isArray(candidates) ? candidates : [])
      .map((i) => `${i.speaker}: '${i.text}'`)
      .join("\n");

    if (userText) {
      const raw = await chatJSON({ system: sys, user: userText });

      // Do NOT spam keywords in logs; just label that they're used.
      const inputLabelled = [
        "=== RECON APPOINTMENT INPUT (text) ===",
        userText,
        "",
        "=== CATEGORY CONFIG (used, not expanded here) ===",
        `allowed: [${allowed}]`,
      ].join("\n");

      timeline.prompt(tctx, "EXTRACT_RECON_APPOINTMENT", {
        inputText: inputLabelled,
        outputText: JSON.stringify(raw, null, 2),
      });

      const parsed = ActionsOut.safeParse(raw);
      if (parsed.success) {
        for (const act of parsed.data.actions) {
          const src = findBestSource(candidates, act);
          actions.push({
            ...act,
            _sourceSpeaker: src?.speaker || "",
            _sourceText: src?.text || "",
          });
        }
      }
    }
  }

  await run("NEXT_LOCATION", P.EXTRACT_NEXT_LOCATION, "EXTRACT_NEXT_LOCATION");
  await run("TASK", P.EXTRACT_TASK, "EXTRACT_TASK");

  // Normalize rego
  for (const a of actions) {
    if ("rego" in a && a.rego) {
      a.rego = a.rego.replace(/\s+/g, "").toUpperCase();
    }
  }

  // For logging: keep the full, raw action set (with _source fields)
  timeline.actions(tctx, actions);
  return actions;
}

/* ================================
   Audit Gatekeeper
================================ */
/**
 * Apply AI audit as a gatekeeper.
 * We drop any action the audit marks as INCORRECT.
 * CORRECT / PARTIAL / UNSURE pass through.
 */
function applyAuditGate(actions, audit) {
  if (!audit || !Array.isArray(audit.items)) return actions;

  const verdictByIndex = new Map();
  for (const item of audit.items) {
    if (typeof item.actionIndex === "number") {
      verdictByIndex.set(item.actionIndex, item.verdict);
    }
  }

  const gated = [];
  actions.forEach((a, idx) => {
    const verdict = verdictByIndex.get(idx);
    if (verdict === "INCORRECT") {
      // Hard block explicit hallucinations / contradictions
      return;
    }
    gated.push(a);
  });

  return gated;
}

/* ================================
   Public API
================================ */
async function processBatch(messages, tctx) {
  // 1) Filter / Refine / Categorize
  const { refined, categorized } = await filterRefineCategorize(messages, tctx);

  // 2) Extract actions (raw, potentially with some hallucinations)
  const actions = await extractActions(categorized, tctx);

  // 3) AI AUDIT (read-only, per-action justification)
  const audit = await runAudit({ batch: messages, refined, actions });
  timeline.recordAudit(tctx, audit);

  // 4) Gatekeeper: drop actions marked INCORRECT by the audit
  const gatedActions = applyAuditGate(actions, audit);

  // What we return to the caller is the cleaned, gated list
  return { actions: gatedActions, categorized };
}

module.exports = { processBatch };
