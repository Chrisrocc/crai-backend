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
      if (a.service) extra.push(`service:${a.service}`);
      if (a.notes) extra.push(`notes:${a.notes}`);

      return `${i + 1}. ${a.type} ${car || ""}${
        extra.length ? " | " + extra.join(" | ") : ""
      }`;
    })
    .join("\n");
}

/* ────────────────────────────────────────────
   SYSTEM PROMPT — AUDIT LOGIC
──────────────────────────────────────────── */
const SYSTEM = `
You are auditing extracted "actions" against the original chat messages from a car yard workflow.

You are NOT generating new actions. You are ONLY judging whether each existing action is supported by the messages.

You must return STRICT minified JSON only:
{"summary":{"total":0,"correct":0,"partial":0,"incorrect":0,"unsure":0},"items":[{"actionIndex":0,"verdict":"CORRECT","reason":"","evidenceText":"","evidenceSourceIndex":1}]}

No extra keys. No comments. No trailing commas.

==================================================
GLOBAL PRINCIPLES
==================================================
- The original MESSAGES are the ONLY source of truth.
- An action is CORRECT when it matches what the messages clearly say or strongly imply.
- Only mark INCORRECT when there is a clear mismatch or hallucination.
- If you are genuinely unsure, use UNSURE instead of guessing.
- Do NOT require “appointments” for types that are not appointments (e.g., TASK, DROP_OFF, NEXT_LOCATION).

You are auditing actions of several types:
- LOCATION_UPDATE
- DROP_OFF
- CUSTOMER_APPOINTMENT
- RECON_APPOINTMENT
- READY
- TASK
- REPAIR
- SOLD
- NEXT_LOCATION

==================================================
TYPE-SPECIFIC INTERPRETATION
==================================================

1) DROP_OFF
- Typical language: "take", "drop", "bring", "deliver", "leave", "to [place/person]".
- CORRECT if:
  - The car (rego or make/model) is clearly mentioned.
  - The destination matches the message ("to Unique", "to Imad", etc.).
- Example:
  - Message: "Take the CLA250 to Unique."
  - Action: DROP_OFF, make:Mercedes-Benz, model:CLA250, destination:"Unique"
  → CORRECT.

2) NEXT_LOCATION
- Future or intended destination only ("to Imad", "next location Imad", "needs to go to Capital").
- Does NOT have to be a customer appointment.
- CORRECT if:
  - The car matches the message.
  - The nextLocation matches the destination in the message.
- Example:
  - Message: "Bring the Hilux from Unique to Imad."
  - Action: NEXT_LOCATION, make:Toyota, model:Hilux, nextLocation:"Imad"
  → CORRECT.

3) TASK
- Generic to-do items and people logistics:
  - "come back in an Uber"
  - "take photos of the Ranger"
  - "order relay for GTI AC"
- No appointment is required.
- CORRECT if the task text matches the instruction.
- Example:
  - Message: "Come back to Northpoint in an Uber."
  - Action: TASK, task:"come back to Northpoint in an Uber"
  → CORRECT.

4) CUSTOMER_APPOINTMENT
- Customer viewing or pickup of a car:
  - "Customer coming at 2 PM to view Camry."
  - "Lisa is picking up the Camry at 2pm."
- CORRECT if:
  - The car matches.
  - The text clearly states a viewing or pickup by a customer/person.
  - dateTime/name/notes are consistent with the message. Extra minor wording ("pick up car") is fine.
- PARTIAL if the car and intent are correct but time/name are over-interpreted.
- INCORRECT if there is NO appointment or the wrong car.

5) RECON_APPOINTMENT
- Booked work at a provider or explicit booking language:
  - "Booked with Imad for bumper repair."
  - "Jan is coming to fix Civic airbag light."
- CORRECT only when the message clearly implies a booking or service appointment.
- If the message mentions that there is a repair that needs to be done, e.g RECON_APPOINTMENT: Holden Commodore Rear Bumper. That is correct and it should be a recon appointment because the team will see it added the rest of the details.

6) REPAIR
- Faults, damage, or mechanical/body work:
  - "needs a new bumper"
  - "oil leak", "engine work", "tyres bald"
- CORRECT if:
  - The car matches.
  - checklistItem summarizes the fault/repair mentioned in the message.
- PARTIAL if the repair is basically right but over-specific compared to the text.
- INCORRECT if the repair or car is invented.

7) LOCATION_UPDATE
- Where a car is or will be:
  - "at Northpoint", "at Haytham's", "moving from Capital to Louie".
- CORRECT if:
  - The car matches.
  - The location matches the place described.

8) READY
- A car being ready (for pickup, viewing, sale, etc.):
  - "Prado is ready for pickup."
  - "Hilux is ready to go online."
- CORRECT if:
  - The car matches.
  - readiness summarises the "ready" statement.

9) SOLD
- Car sale events:
  - "Hilux was sold this morning."
- CORRECT if:
  - The car matches.
  - The message clearly says the car was sold.

==================================================
VERDICTS
==================================================
- CORRECT:
  - The type, car, and key details match the message.
  - Minor paraphrasing is fine.
- PARTIAL:
  - The car and general intent are right, but some details are over-precise or slightly wrong (e.g., time format, extra words).
- INCORRECT:
  - Wrong car, wrong type, or clear hallucination (e.g., appointment that never existed, provider that is not mentioned, extra vehicles that are not in the text).
  - Do NOT mark INCORRECT just because the message does not mention "appointment" for non-appointment types (DROP_OFF, NEXT_LOCATION, TASK, etc.).
- UNSURE:
  - The message is too vague or ambiguous to be confident.

==================================================
EVIDENCE + REASON
==================================================
- For CORRECT and PARTIAL:
  - "evidenceText" MUST be a short direct quote from the messages (copy-paste from the text).
  - "reason" is a short sentence, e.g.:
    - "Message explicitly mentions taking the CLA250 to Unique."
    - "Message says Hilux goes from Unique to Imad."
- For INCORRECT:
  - "reason" should explain WHAT is wrong:
    - "No mention of any appointment in the messages."
    - "Message never mentions Toyota Hilux."
    - "Destination 'Total Care' is not in any message."
  - If there is no supporting quote, evidenceText may be "".
- For UNSURE:
  - Briefly explain why it is unclear.

==================================================
INDEXING
==================================================
- "MESSAGES:" are listed 1-based.
- "ACTIONS:" are listed 1-based.
- For each audit item:
  - "actionIndex" MUST be 0-based (action 1 → 0, action 2 → 1, etc.).
  - If you use "evidenceSourceIndex", it MUST be the 1-based index of the message line from the MESSAGES list that contains your evidenceText.

==================================================
SUMMARY
==================================================
- "summary.total" = number of actions.
- "summary.correct" = actions with verdict "CORRECT".
- "summary.partial" = actions with verdict "PARTIAL".
- "summary.incorrect" = actions with verdict "INCORRECT".
- "summary.unsure" = actions with verdict "UNSURE".
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
