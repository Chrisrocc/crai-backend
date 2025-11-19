// src/services/ai/qa/qaCheck.js
//
// Read-only AI audit for pipeline outputs.
// Compares each extracted action against the source messages and returns
// short, human-readable justifications per action.

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

/* ────────────────────────────────────────────
   FORMATTERS
──────────────────────────────────────────── */
function fmtMsgs(msgs) {
  return (Array.isArray(msgs) ? msgs : [])
    .map((m, i) => `${i + 1}. ${m.speaker || "Unknown"}: ${m.text || ""}`)
    .join("\n");
}

function fmtActions(actions) {
  return (Array.isArray(actions) ? actions : [])
    .map((a, i) => {
      // Keep this compact but informative for the auditor
      const car = [
        a.rego || "",
        [a.make || "", a.model || ""].filter(Boolean).join(" "),
      ]
        .filter(Boolean)
        .join(" • ");

      const extra = [];
      if (a.checklistItem) extra.push(`checklistItem:${a.checklistItem}`);
      if (a.readiness) extra.push(`readiness:${a.readiness}`);
      if (a.category) extra.push(`category:${a.category}`);
      if (a.destination) extra.push(`destination:${a.destination}`);
      if (a.nextLocation) extra.push(`nextLocation:${a.nextLocation}`);
      if (a.dateTime) extra.push(`dateTime:${a.dateTime}`);
      if (a.task) extra.push(`task:${a.task}`);
      if (a.name) extra.push(`name:${a.name}`);

      return `${i + 1}. ${a.type} ${car || ""}${extra.length ? " | " + extra.join(" | ") : ""}`;
    })
    .join("\n");
}

/* ────────────────────────────────────────────
   SYSTEM PROMPT — AUDIT LOGIC
──────────────────────────────────────────── */
const SYSTEM = `
You are auditing extracted "actions" against the original chat messages from a car yard workflow.

You must return STRICT minified JSON only:
{"summary":{"total":0,"correct":0,"partial":0,"incorrect":0,"unsure":0},"items":[{"actionIndex":0,"verdict":"CORRECT","reason":"","evidenceText":"","evidenceSourceIndex":1}]}

No extra keys. No comments. No trailing commas.

INTERPRETATION RULES
- Treat the original messages as the ONLY source of truth.
- Each action must be checked against the content of the messages.
- Never reward hallucinations: if any part of the action is not clearly supported by the text, mark it INCORRECT or PARTIAL.
- If you are genuinely unsure, use UNSURE instead of guessing CORRECT.

VERDICTS
- CORRECT:
  - The car (rego/make/model) matches what appears in the messages.
  - The action type matches the intent (REPAIR vs RECON_APPOINTMENT vs CUSTOMER_APPOINTMENT vs SOLD etc.).
  - The key details (e.g. checklistItem for REPAIR, readiness for READY, category for RECON_APPOINTMENT, dateTime/name for CUSTOMER_APPOINTMENT) are clearly stated or directly implied.

- PARTIAL:
  - The car is correct, but some important detail is incomplete, slightly off, or over-interpreted.
  - Example: message says "this afternoon", action says "3pm today".

- INCORRECT:
  - The action invents a car, rego, category, appointment, destination, or other details that are not in the messages.
  - The type is wrong (e.g. RECON_APPOINTMENT when the message only says "needs a bonnet" with no appointment).
  - Or it attaches the right detail to the wrong car.

- UNSURE:
  - The message hints at the action but is too vague to be confident.
  - Use UNSURE if you cannot find a clean quote as evidence.

EVIDENCE + REASON
- For CORRECT and PARTIAL:
  - "evidenceText" MUST be a minimal direct quote from the messages (copy-paste from the text).
  - "reason" is a short sentence like:
    - "Message explicitly mentions engine replacement for ATS355."
    - "Message says XR6 ute is fixed and ready for a quick clean."
- For INCORRECT:
  - Prefer a short reason explaining what is wrong:
    - "No appointment mentioned in any message."
    - "Message never mentions category 'Mechanical'."
  - If there is no supporting quote, evidenceText may be "".
- For UNSURE:
  - Explain briefly why it is unclear.

INDEXING
- You will see "MESSAGES:" listed 1-based.
- You will see "ACTIONS:" listed 1-based.
- For each audit item:
  - "actionIndex" MUST be 0-based (action 1 → 0, action 2 → 1, etc.).
  - If you use "evidenceSourceIndex", it MUST be the 1-based index of the message line from the MESSAGES list that contains your evidenceText.

SUMMARY
- "summary.total" = number of actions.
- "summary.correct" = count of items with verdict "CORRECT".
- "summary.partial" = count of items with verdict "PARTIAL".
- "summary.incorrect" = count of items with verdict "INCORRECT".
- "summary.unsure" = count of items with verdict "UNSURE".
`;

/* ────────────────────────────────────────────
   PUBLIC API
──────────────────────────────────────────── */
async function runAudit({ batch = [], refined = [], actions = [] }) {
  // Combine raw + refined so auditor can quote from either
  const sourceMessages = [
    ...(Array.isArray(batch) ? batch : []),
    ...(Array.isArray(refined) ? refined : []),
  ].map((m) => ({
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

  // Fallback: neutral audit if parsing fails
  return {
    summary: {
      total: actions.length,
      correct: 0,
      partial: 0,
      incorrect: 0,
      unsure: actions.length,
    },
    items: (Array.isArray(actions) ? actions : []).map((_, i) => ({
      actionIndex: i,
      verdict: "UNSURE",
      reason: "Audit response could not be parsed",
      evidenceText: "",
    })),
  };
}

module.exports = { runAudit };
