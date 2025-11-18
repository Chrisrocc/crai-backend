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
    .map((a, i) => {
      const parts = [];
      parts.push(`${i + 1}. ${a.type}`);
      parts.push(`rego:${a.rego || ""}`);
      if (a.make || a.model) {
        parts.push(
          [a.make, a.model]
            .filter(Boolean)
            .join(" ")
        );
      }
      if (a.checklistItem) parts.push(`checklistItem:${a.checklistItem}`);
      if (a.readiness) parts.push(`readiness:${a.readiness}`);
      if (a.destination) parts.push(`destination:${a.destination}`);
      if (a.nextLocation) parts.push(`nextLocation:${a.nextLocation}`);
      if (a.category) parts.push(`category:${a.category}`);
      if (a.dateTime) parts.push(`dateTime:${a.dateTime}`);
      if (a.task) parts.push(`task:${a.task}`);
      return parts.join(" | ");
    })
    .join("\n");
}

// ---------- System prompt ----------
const SYSTEM = `
You are auditing extracted "actions" against the original chat messages from a car yard workflow.
Your job: for EACH action, decide if it is supported by the messages and show a very short justification.

Return STRICT minified JSON only with this schema:
{"summary":{"total":0,"correct":0,"partial":0,"incorrect":0,"unsure":0},"items":[{"actionIndex":0,"verdict":"CORRECT","reason":"","evidenceText":"","evidenceSourceIndex":0}]}

Interpretation rules:
- You MUST treat the original messages as the only source of truth.
- Do NOT reward hallucinations. If the action describes anything that is not clearly present in the messages, it is INCORRECT.
- If you are unsure, choose UNSURE instead of guessing CORRECT.

Verdict guidelines:
- CORRECT:
  - The message clearly supports this action (matching car and detail).
  - For RECON_APPOINTMENT: the text explicitly implies an appointment or someone coming / booking / taking the car for that service.
    Examples of valid appointment signals:
    - "Jan is coming to fix the Civic airbag light."
    - "Booked with Imad."
    - "Taking it to Al's for wheels."
- PARTIAL:
  - The car is correct, but some important detail (time/place/service/task) is missing or ambiguous compared to the action.
  - Or the action slightly over-interprets, but still mostly matches the text.
- INCORRECT:
  - The message contradicts the action (wrong car/detail), OR
  - The action invents info not present in any message (e.g., adding a category, appointment, or destination that the text never mentions).
  - For RECON_APPOINTMENT: if the message only describes damage/repairs (e.g., "needs new bonnet and bumper") but does NOT mention any appointment, booking, or person coming, then RECON_APPOINTMENT is INCORRECT.
- UNSURE:
  - The message hints at the action but is too vague to be confident.
  - Use UNSURE rather than CORRECT if you cannot quote a clear snippet.

Evidence rules:
- Keep "reason" very short (one sentence).
- "evidenceText" MUST be a minimal direct quote from the message (not your paraphrase).
- For "evidenceSourceIndex", use the 1-based index of the message line you quoted; omit the field if no single line fits.
- If you mark a verdict as CORRECT or PARTIAL, you SHOULD provide evidenceText from the messages that supports it.
- If you mark a verdict as INCORRECT because there is no support, you may leave evidenceText empty.

IMPORTANT:
- Do not modify actions — this is a READ-ONLY audit.
- Do not invent new messages or extra context.
`;

// ---------- Public API ----------
async function runAudit({ batch = [], refined = [], actions = [] }) {
  // Provide the auditor with both raw batch (as seen by the pipeline) and refined lines.
  // The auditor will pick whatever gives best evidence.
  const sourceMessages = [
    ...(Array.isArray(batch) ? batch : []),
    ...(Array.isArray(refined) ? refined : []),
  ].map((m) => ({
    speaker: m.speaker || "Unknown",
    text: m.text || "",
  }));

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
