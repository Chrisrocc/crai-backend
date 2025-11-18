// src/services/ai/qa/qaCheck.js
//
// Read-only AI audit for pipeline outputs.
// Compares each extracted action against the source messages and returns
// short, human-readable justifications per action.
//
// Usage:
//   const audit = await runAudit({ batch, refined, categorized, actions });
//   timeline.recordAudit(tctx, audit); // pretty printing handled by timeline logger

const { z } = require("zod");
const { chatJSON } = require("../llmClient");

// ---------- Zod schemas (LLM contract) ----------
const AuditItem = z.object({
  actionIndex: z.number().int().nonnegative(),
  verdict: z.enum(["CORRECT", "PARTIAL", "INCORRECT", "UNSURE"]),
  // very short reason like: "Message explicitly mentions 'engine replacement'."
  reason: z.string().default(""),
  // the minimal snippet from source that justifies the verdict
  evidenceText: z.string().default(""),
  // which source line the snippet came from (index into provided messages)
  evidenceSourceIndex: z.number().int().nonnegative().optional(),
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

// ---------- Helpers ----------
function fmtMsgs(msgs) {
  return (Array.isArray(msgs) ? msgs : [])
    .map((m, i) => `${i + 1}. ${m.speaker || "Unknown"}: ${m.text}`)
    .join("\n");
}

function fmtActions(actions) {
  return (Array.isArray(actions) ? actions : [])
    .map(
      (a, i) =>
        `${i + 1}. ${a.type}` +
        ` | rego:${a.rego || ""}` +
        (a.make || a.model ? ` | ${[a.make, a.model].filter(Boolean).join(" ")}` : "") +
        (a.checklistItem ? ` | checklistItem:${a.checklistItem}` : "") +
        (a.readiness ? ` | readiness:${a.readiness}` : "") +
        (a.destination ? ` | destination:${a.destination}` : "") +
        (a.nextLocation ? ` | nextLocation:${a.nextLocation}` : "") +
        (a.category ? ` | category:${a.category}` : "") +
        (a.dateTime ? ` | dateTime:${a.dateTime}` : "") +
        (a.task ? ` | task:${a.task}` : "")
    )
    .join("\n");
}

// ---------- System prompt ----------
const SYSTEM = `
You are auditing extracted "actions" against the original chat messages from a car yard workflow.
Your job: for EACH action, decide if it is supported by the messages and show a very short justification.

Return STRICT minified JSON only with this schema:
{"summary":{"total":0,"correct":0,"partial":0,"incorrect":0,"unsure":0},"items":[{"actionIndex":0,"verdict":"CORRECT","reason":"","evidenceText":"","evidenceSourceIndex":0}]}

Guidelines:
- CORRECT: The message clearly supports this action (matching car and detail). Quote the smallest helpful snippet as evidenceText.
- PARTIAL: The car is correct, but some important detail (time/place/service/task) is missing or ambiguous. Show the closest snippet.
- INCORRECT: The message contradicts the action (wrong car/detail) or the action invents info not present in any message.
- UNSURE: The message hints at the action but is too vague to be confident.

Keep reason very short (one sentence). evidenceText must be a minimal quote from the message (not your paraphrase).
For evidenceSourceIndex, use the 1-based index of the message line you quoted; omit the field if no single line fits.

IMPORTANT: Do not modify actions — this is a READ-ONLY audit.
`;

// ---------- Public API ----------
async function runAudit({ batch = [], refined = [], actions = [] }) {
  // Provide the auditor with both raw batch (as seen by the pipeline) and refined lines.
  // The auditor will pick whatever gives best evidence.
  const sourceMessages = [
    ...(Array.isArray(batch) ? batch : []),
    ...(Array.isArray(refined) ? refined : []),
  ].map((m) => ({ speaker: m.speaker || "Unknown", text: m.text || "" }));

  const user = [
    "MESSAGES (1-based):",
    fmtMsgs(sourceMessages),
    "",
    "ACTIONS (1-based):",
    fmtActions(actions),
  ].join("\n");

  const raw = await chatJSON({ system: SYSTEM, user });
  const parsed = AuditOut.safeParse(raw);
  if (parsed.success) return parsed.data;

  // If the model returned something malformed, degrade gracefully with a neutral audit.
  const fallback = {
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
      reason: "Audit response could not be parsed",
      evidenceText: "",
    })),
  };
  return fallback;
}

module.exports = { runAudit };
