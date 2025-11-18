// src/services/ai/pipeline.js

const { z } = require('zod');
const { chatJSON } = require('./llmClient');
const P = require('../../prompts/pipelinePrompts');
const timeline = require('../logging/timelineLogger');
const ReconditionerCategory = require('../../models/ReconditionerCategory');
const { runAudit } = require('./qa/qaCheck');

// ===============================
// ZOD SCHEMAS
// ===============================
const Msg = z.object({ speaker: z.string(), text: z.string() });
const FilterOut = z.object({ messages: z.array(Msg) });

const CatItem = z.object({ speaker: z.string(), text: z.string(), category: z.string() });
const CatOut = z.object({ items: z.array(CatItem) });

const Common = {
  rego: z.string().default(''),
  make: z.string().default(''),
  model: z.string().default(''),
  badge: z.string().default(''),
  description: z.string().default(''),
  year: z.string().default('')
};

const A_Loc   = z.object({ type: z.literal('LOCATION_UPDATE'), location: z.string().default(''), ...Common });
const A_Sold  = z.object({ type: z.literal('SOLD'), ...Common });
const A_Rep   = z.object({ type: z.literal('REPAIR'), checklistItem: z.string().default(''), ...Common });
const A_Ready = z.object({ type: z.literal('READY'), readiness: z.string().default(''), ...Common });
const A_Drop  = z.object({ type: z.literal('DROP_OFF'), destination: z.string().default(''), note: z.string().default(''), ...Common });
const A_CAppt = z.object({ type: z.literal('CUSTOMER_APPOINTMENT'), name: z.string().default(''), dateTime: z.string().default(''), notes: z.string().default(''), ...Common });
const A_RAppt = z.object({ type: z.literal('RECON_APPOINTMENT'), name: z.string().default(''), service: z.string().default(''), category: z.string().default(''), dateTime: z.string().default(''), notes: z.string().default(''), ...Common });
const A_Next  = z.object({ type: z.literal('NEXT_LOCATION'), nextLocation: z.string().default(''), ...Common });
const A_Task  = z.object({ type: z.literal('TASK'), task: z.string().default(''), ...Common });

const ActionsOut = z.object({
  actions: z.array(z.union([A_Loc, A_Sold, A_Rep, A_Ready, A_Drop, A_CAppt, A_RAppt, A_Next, A_Task]))
});

// ===============================
// Helpers
// ===============================
const fmt = (msgs) =>
  (msgs || []).map((m) => `${m.speaker}: '${m.text}'`).join('\n');

function applyDuplicationRules(items) {
  const out = [];
  const seen = new Set();

  for (const it of items) {
    out.push(it);

    if (it.category === 'REPAIR')
      out.push({ ...it, category: 'RECON_APPOINTMENT' });

    if (it.category === 'RECON_APPOINTMENT')
      out.push({ ...it, category: 'REPAIR' });

    if (it.category === 'DROP_OFF')
      out.push({ ...it, category: 'NEXT_LOCATION' });
  }

  const deduped = [];
  for (const it of out) {
    const key = `${it.speaker}|${it.text}|${it.category}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(it);
    }
  }
  return deduped;
}

// ===============================
// Step 1–3  (Filter → Refine → Categorize)
// ===============================
async function filterRefineCategorize(batch, tctx) {
  timeline.section(tctx, "MESSAGES", fmt(batch));

  const f = FilterOut.parse(await chatJSON({ system: P.FILTER_SYSTEM, user: fmt(batch) }));
  timeline.section(tctx, "FILTER", JSON.stringify(f, null, 2));

  const r = FilterOut.parse(await chatJSON({ system: P.REFINE_SYSTEM, user: fmt(f.messages) }));
  timeline.section(tctx, "REFINE", JSON.stringify(r, null, 2));

  const cats = await ReconditionerCategory.find().lean().catch(() => []);
  const reconHints = cats
    .flatMap((c) => [
      ...(c.keywords || []).map(s => s.toLowerCase()),
      ...(c.rules || []).map(s => s.toLowerCase())
    ]);

  const categorizeSystem = P.CATEGORIZE_SYSTEM_DYNAMIC(reconHints);

  const c = CatOut.parse(await chatJSON({ system: categorizeSystem, user: fmt(r.messages) }));
  timeline.section(tctx, "CATEGORIZE", JSON.stringify(c, null, 2));

  const withDupes = applyDuplicationRules(c.items);
  return { refined: r.messages, categorized: withDupes };
}

// ===============================
// Step 4: Extraction
// ===============================
async function extractActions(items, tctx) {
  const buckets = {
    LOCATION_UPDATE: [], SOLD: [], REPAIR: [], READY: [],
    DROP_OFF: [], CUSTOMER_APPOINTMENT: [], RECON_APPOINTMENT: [],
    NEXT_LOCATION: [], TASK: [], OTHER: []
  };

  for (const it of items) (buckets[it.category] || buckets.OTHER).push(it);

  const actions = [];

  async function run(cat, sys, label) {
    const group = buckets[cat];
    if (!group.length) return;

    const inputText = group.map(i => `${i.speaker}: '${i.text}'`).join('\n');
    const raw = await chatJSON({ system: sys, user: inputText });

    timeline.prompt(tctx, label, {
      inputText,
      outputText: JSON.stringify(raw)
    });

    const parsed = ActionsOut.safeParse(raw);
    if (!parsed.success) return;

    for (const act of parsed.data.actions) {
      const src = group.find(g => g.text.includes(act.rego)) || group[0];
      actions.push({
        ...act,
        _sourceSpeaker: src?.speaker || '',
        _sourceText: src?.text || ''
      });
    }
  }

  await run('LOCATION_UPDATE', P.EXTRACT_LOCATION_UPDATE, 'EXTRACT_LOCATION_UPDATE');
  await run('SOLD', P.EXTRACT_SOLD, 'EXTRACT_SOLD');
  await run('REPAIR', P.EXTRACT_REPAIR, 'EXTRACT_REPAIR');
  await run('READY', P.EXTRACT_READY, 'EXTRACT_READY');
  await run('DROP_OFF', P.EXTRACT_DROP_OFF, 'EXTRACT_DROP_OFF');
  await run('CUSTOMER_APPOINTMENT', P.EXTRACT_CUSTOMER_APPOINTMENT, 'EXTRACT_CUSTOMER_APPOINTMENT');

  // RECON_APPT
  if (buckets.RECON_APPOINTMENT.length) {
    const cats = await ReconditionerCategory.find().lean().catch(() => []);
    const sys = P.EXTRACT_RECON_APPOINTMENT_FROM_DB(
      cats.map(c => c.name).join(', '),
      "",
      ""
    );

    const group = buckets.RECON_APPOINTMENT;
    const inputText = group.map(i => `${i.speaker}: '${i.text}'`).join('\n');
    const raw = await chatJSON({ system: sys, user: inputText });

    timeline.prompt(tctx, "EXTRACT_RECON_APPOINTMENT", {
      inputText,
      outputText: JSON.stringify(raw)
    });

    const parsed = ActionsOut.safeParse(raw);
    if (parsed.success) {
      for (const act of parsed.data.actions) {
        const src = group.find(g => g.text.includes(act.rego)) || group[0];
        actions.push({ ...act, _sourceSpeaker: src?.speaker || '', _sourceText: src?.text || '' });
      }
    }
  }

  await run('NEXT_LOCATION', P.EXTRACT_NEXT_LOCATION, 'EXTRACT_NEXT_LOCATION');
  await run('TASK', P.EXTRACT_TASK, 'EXTRACT_TASK');

  timeline.actions(tctx, actions);
  return actions;
}

// ===============================
// Audit Gatekeeper
// ===============================
function applyAuditGate(actions, audit) {
  if (!audit?.items) return actions;

  const verdict = new Map();
  audit.items.forEach(i => {
    if (typeof i.actionIndex === 'number')
      verdict.set(i.actionIndex, i.verdict);
  });

  return actions.filter((a, idx) => verdict.get(idx) !== 'INCORRECT');
}

// ===============================
// Main
// ===============================
async function processBatch(batch, tctx) {
  const { refined, categorized } = await filterRefineCategorize(batch, tctx);

  const rawActions = await extractActions(categorized, tctx);

  const audit = await runAudit({ batch, refined, actions: rawActions });
  timeline.recordAudit(tctx, audit);

  const gated = applyAuditGate(rawActions, audit);

  return { actions: gated, categorized };
}

module.exports = { processBatch };
