// src/services/ai/qa/qaCheck.js
const { z } = require("zod");
const { chatJSON } = require("../llmClient");

// ---------- Env ----------
const QA_AI = String(process.env.QA_AI || "1").trim() === "1"; // default ON
const DEBUG = String(process.env.QA_DEBUG || "0").trim() === "1";
const dbg = (...a) => DEBUG && console.log("[QA]", ...a);

// ---------- Schemas ----------
const AuditFlag = z.object({
  code: z.string(),                          // e.g. "POSSIBLE_DUPLICATE", "REGO_MISMATCH"
  severity: z.enum(["info", "warn", "error"]).default("warn"),
  message: z.string().default(""),
  actionIndexes: z.array(z.number().int().nonnegative()).default([]),
});

const AuditOut = z.object({
  summary: z.string().default(""),
  lines: z.array(z.string()).default([]),    // pretty, human-friendly bullet lines
  flags: z.array(AuditFlag).default([]),     // machine-usable flags
});

// ---------- Helpers ----------
function briefAction(a, idx) {
  const base = [];
  if (a.type) base.push(a.type);
  const carBits = [a.rego, a.make, a.model].filter(Boolean).join(" • ");
  if (carBits) base.push(carBits);
  const details = [];
  if (a.task) details.push(`task: ${a.task}`);
  if (a.category) details.push(`category: ${a.category}`);
  if (a.location) details.push(`location: ${a.location}`);
  if (a.destination) details.push(`to: ${a.destination}`);
  if (a.nextLocation) details.push(`next: ${a.nextLocation}`);
  if (a.dateTime) details.push(`when: ${a.dateTime}`);
  if (a.readiness) details.push(`ready: ${a.readiness}`);
  if (a.notes) details.push(`notes: ${a.notes}`);
  return `[${idx}] ${base.join(" — ")}${details.length ? ` — ${details.join(", ")}` : ""}`;
}

function packInputs({ messages = [], actions = [] }) {
  const msgLines = (Array.isArray(messages) ? messages : []).map(
    (m) => `${m.speaker || "Unknown"}: ${m.text}`
  );
  const actionLines = (Array.isArray(actions) ? actions : []).map(briefAction);
  return { msgLines, actionLines };
}

// ---------- System Prompt ----------
const AUDIT_SYSTEM = `
You are an expert QA auditor for a car-yard WhatsApp/Telegram pipeline.

You receive:
1) The normalized, actionable chat messages (speaker:text).
2) The pipeline's extracted actions (typed JSON already summarized to one-line per action).

Your job (READ-ONLY):
- Check that actions are faithful to the messages (no hallucinated cars, times, people, places).
- Check rego/make/model consistency across actions referring to the same car.
- Spot obvious duplicates (same car + same meaning).
- Spot conflicting actions (e.g., same car both SOLD and READY at same time).
- Point out missing key info (e.g., customer name/time for appointments) when the message implied it should be there.

Return STRICT minified JSON ONLY with this schema:
{
  "summary": "",                 // one short sentence
  "lines": ["..."],              // clear bullet lines for humans (status like "OK • ...", "FLAG • ...")
  "flags": [
    {"code":"", "severity":"info|warn|error", "message":"", "actionIndexes":[0,2]}
  ]
}

Flag codes to use (choose best fit):
- "POSSIBLE_DUPLICATE"
- "REGO_MISMATCH"
- "CONFLICT"
- "MISSING_DETAILS"
- "NOT_SUPPORTED"
- "LOW_CONFIDENCE"
- "INFERRED_FACT"
- "AMBIGUOUS"

Rules:
- Do NOT invent new actions or fix anything — this is a read-only audit.
- Keep lines short and scannable (one sentence each).
`;

// ---------- Public API ----------
async function audit({ messages = [], actions = [] }) {
  // If disabled, return pass-through "no-op" audit.
  if (!QA_AI) {
    return {
      summary: "QA disabled.",
      lines: ["QA disabled (QA_AI=0)."],
      flags: [],
    };
  }

  const { msgLines, actionLines } = packInputs({ messages, actions });
  const user = [
    "MESSAGES",
    ...msgLines.map((x) => `- ${x}`),
    "",
    "ACTIONS",
    ...actionLines.map((x) => `- ${x}`),
  ].join("\n");

  dbg("\n==== QA AUDIT USER PAYLOAD ====\n" + user + "\n===============================\n");

  const raw = await chatJSON({ system: AUDIT_SYSTEM, user });
  const parsed = AuditOut.safeParse(raw);

  if (!parsed.success) {
    dbg("QA parse failed, raw:", raw);
    return {
      summary: "QA parsing failed.",
      lines: ["Audit result could not be parsed."],
      flags: [{ code: "NOT_SUPPORTED", severity: "warn", message: "Audit result invalid JSON", actionIndexes: [] }],
    };
  }

  return parsed.data;
}

module.exports = { audit };
