// src/services/ai/qa/qaCheck.js
const { z } = require("zod");
const { chatJSON } = require("../llmClient");

/* ────────────────────────────────────────────
   SCHEMA
──────────────────────────────────────────── */
const AuditItem = z.object({
  actionIndex: z.number().int().nonnegative(),
  verdict: z.enum(["CORRECT", "PARTIAL", "INCORRECT", "UNSURE"]),
  reason: z.string().default(""),
  evidenceText: z.string().default(""),
  evidenceSourceIndex: z.number().optional(),
});

const AuditOut = z.object({
  summary: z.object({
    total: z.number().int(),
    correct: z.number().int(),
    partial: z.number().int(),
    incorrect: z.number().int(),
    unsure: z.number().int(),
  }),
  items: z.array(AuditItem),
});

/* ────────────────────────────────────────────
   FORMATTERS
──────────────────────────────────────────── */
function fmtMsgs(msgs) {
  return msgs
    .map((m, i) => `${i + 1}. ${m.speaker}: ${m.text}`)
    .join("\n");
}

function fmtActions(actions) {
  return actions
    .map((a, i) => `${i + 1}. ${a.type} ${a.rego} ${a.make} ${a.model}`)
    .join("\n");
}

/* ────────────────────────────────────────────
   SYSTEM PROMPT — AUDIT LOGIC
──────────────────────────────────────────── */
const SYSTEM = `
You audit actions extracted from chat messages.

Return STRICT minified JSON:
{"summary":{"total":0,"correct":0,"partial":0,"incorrect":0,"unsure":0},"items":[{"actionIndex":0,"verdict":"CORRECT","reason":"","evidenceText":"","evidenceSourceIndex":1}]}

Rules:
- CORRECT = message clearly supports the action.
- PARTIAL = car matches but detail partially unclear.
- INCORRECT = invented or contradicts message.
- UNSURE = not enough evidence.

Always quote minimal snippets for evidence.
Keep reasons short.
`;

/* ────────────────────────────────────────────
   PUBLIC API
──────────────────────────────────────────── */
async function runAudit({ batch = [], refined = [], actions = [] }) {
  const sourceMessages = [
    ...batch,
    ...refined,
  ].map(m => ({
    speaker: m.speaker || "Unknown",
    text: m.text || "",
  }));

  const user = [
    "MESSAGES:",
    fmtMsgs(sourceMessages),
    "",
    "ACTIONS:",
    fmtActions(actions),
  ].join("\n");

  const raw = await chatJSON({ system: SYSTEM, user });
  const parsed = AuditOut.safeParse(raw);

  if (parsed.success) return parsed.data;

  return {
    summary: {
      total: actions.length,
      correct: 0,
      partial: 0,
      incorrect: 0,
      unsure: actions.length,
    },
    items: actions.map((_, i) => ({
      actionIndex: i,
      verdict: "UNSURE",
      reason: "Audit could not parse",
      evidenceText: "",
    })),
  };
}

module.exports = { runAudit };
