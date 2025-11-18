// src/services/ai/pipeline.js
const { z } = require('zod');
const { chatJSON } = require('./llmClient');
const P = require('../../prompts/pipelinePrompts');
const timeline = require('../logging/timelineLogger');
const ReconditionerCategory = require('../../models/ReconditionerCategory');

const DEBUG = String(process.env.PIPELINE_DEBUG || '1').trim() === '1';
const dbg = (...args) => { if (DEBUG) console.log(...args); };

/* ================================
   Zod Schemas
================================ */
const Msg = z.object({ speaker: z.string().default(''), text: z.string().default('') });
const FilterOut = z.object({ messages: z.array(Msg).default([]) });

const CatItem = z.object({ speaker: z.string(), text: z.string(), category: z.string() });
const CatOut = z.object({ items: z.array(CatItem).default([]) });

const Common = {
  rego: z.string().default(''),
  make: z.string().default(''),
  model: z.string().default(''),
  badge: z.string().default(''),
  year: z.string().default(''),
  description: z.string().default(''),
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
  actions: z.array(z.union([A_Loc, A_Sold, A_Rep, A_Ready, A_Drop, A_CAppt, A_RAppt, A_Next, A_Task])).default([]),
});

/* ================================
   Helpers (dynamic prompts)
================================ */
function buildAllowedCatsStringSorted(cats = []) {
  if (!Array.isArray(cats) || cats.length === 0) return '"Other"';
  const sorted = [...cats].sort((a, b) => {
    const ao = Number(a.sortOrder ?? 0);
    const bo = Number(b.sortOrder ?? 0);
    if (ao !== bo) return ao - bo;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  return sorted.map((c) => `"${String(c.name).trim()}"`).join(', ');
}

function buildCatKeywordRuleMapString(cats = []) {
  if (!Array.isArray(cats) || cats.length === 0) return '';
  return cats
    .map((c) => {
      const name = String(c.name || '').trim();
      const items = [
        ...((c.keywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean)),
        ...((c.rules || []).map((r) => String(r).trim().toLowerCase()).filter(Boolean)),
      ];
      const uniq = Array.from(new Set(items));
      const list = uniq.map((t) => `"${t}"`).join(', ');
      return `${name}: [${list}]`;
    })
    .join('\n');
}

function buildCatDefaultServiceMapString(cats = []) {
  if (!Array.isArray(cats) || cats.length === 0) return '';
  return cats
    .map((c) => {
      const name = String(c.name || '').trim();
      const def = String(c.defaultService || '').trim();
      return `${name}: "${def}"`;
    })
    .join('\n');
}

function buildReconHintsFlat(cats = []) {
  const set = new Set();
  for (const c of (Array.isArray(cats) ? cats : [])) {
    for (const k of (c.keywords || [])) {
      const v = String(k || '').trim().toLowerCase();
      if (v) set.add(v);
    }
    for (const r of (c.rules || [])) {
      const v = String(r || '').trim().toLowerCase();
      if (v) set.add(v);
    }
  }
  if (set.size === 0) return '';
  return Array.from(set).map((s) => `- "${s}"`).join('\n');
}

const fmt = (msgs) => (Array.isArray(msgs) ? msgs : [])
  .map((m) => `${m.speaker || 'Unknown'}: '${m.text}'`).join('\n');

/* ================================
   Duplication rules
================================ */
function applyDuplicationRules(items) {
  const base = Array.isArray(items) ? items : [];
  const out = base.slice();

  for (const it of base) {
    if (it.category === 'REPAIR') out.push({ ...it, category: 'RECON_APPOINTMENT' });
    if (it.category === 'RECON_APPOINTMENT') out.push({ ...it, category: 'REPAIR' });
    if (it.category === 'DROP_OFF') out.push({ ...it, category: 'NEXT_LOCATION' });
  }

  const seen = new Set();
  const deduped = [];
  for (const it of out) {
    const key = `${it.speaker}||${it.text}||${it.category}`;
    if (!seen.has(key)) { seen.add(key); deduped.push(it); }
  }
  return deduped;
}

/* ================================
   Step 1–3: Filter → Refine → Categorize
================================ */
async function filterRefineCategorize(batch, tctx) {
  timeline.recordBatch(tctx, batch); // Messages section

  // FILTER
  const p1Input = fmt(batch);
  const f = FilterOut.parse(await chatJSON({ system: P.FILTER_SYSTEM, user: p1Input }));
  timeline.recordP1(tctx, f.messages);
  timeline.recordPrompt(tctx, 'PHOTO_MERGER_SYSTEM', { // if you run it earlier, overwrite here with real I/O
    inputText: '(handled earlier in pipeline)',
    outputText: '[attach photo outputs here if you call it in this module]',
  });
  timeline.recordPrompt(tctx, 'FILTER_SYSTEM', {
    inputText: p1Input,
    outputText: JSON.stringify({ messages: f.messages }),
  });

  // REFINE
  const p2Input = fmt(f.messages);
  const r = FilterOut.parse(await chatJSON({ system: P.REFINE_SYSTEM, user: p2Input }));
  timeline.recordP2(tctx, r.messages);
  timeline.recordPrompt(tctx, 'REFINE_SYSTEM', {
    inputText: p2Input,
    outputText: JSON.stringify({ messages: r.messages }),
  });

  // CATEGORIZE
  let cats = [];
  try {
    cats = await ReconditionerCategory.find().lean();
  } catch (e) {
    // still proceed with static prompt
  }
  const reconHintsFlat = buildReconHintsFlat(cats);
  const categorizeSystem = reconHintsFlat
    ? P.CATEGORIZE_SYSTEM_DYNAMIC(reconHintsFlat)
    : P.CATEGORIZE_SYSTEM;

  const p3Input = fmt(r.messages);
  if (DEBUG) {
    console.log('\n==== PIPELINE DEBUG :: CATEGORIZER (Step 3) ====');
    console.log('Recon hints (keywords + rules):\n' + (reconHintsFlat || '(none)'));
    console.log('\n-- System prompt sent --\n' + categorizeSystem);
    console.log('\n-- User payload --\n' + (p3Input || '(empty)'));
    console.log('==============================================\n');
  }

  const c = CatOut.parse(await chatJSON({ system: categorizeSystem, user: p3Input }));
  const withDupes = applyDuplicationRules(c.items);
  timeline.recordP3(tctx, withDupes);
  timeline.recordPrompt(tctx, 'CATEGORIZE_SYSTEM', {
    inputText: p3Input,
    outputText: JSON.stringify({ items: withDupes }),
  });

  return { refined: r.messages, categorized: withDupes };
}

/* ================================
   Step 4: Extraction
================================ */
async function extractActions(items, tctx) {
  const by = {
    LOCATION_UPDATE: [], SOLD: [], REPAIR: [], READY: [],
    DROP_OFF: [], CUSTOMER_APPOINTMENT: [], RECON_APPOINTMENT: [],
    NEXT_LOCATION: [], TASK: [], OTHER: [],
  };
  for (const it of items) (by[it.category] || by.OTHER).push(it);

  const actions = [];

  async function run(cat, sys, label) {
    const user = by[cat].map((i) => `${i.speaker}: '${i.text}'`).join('\n');
    if (!user) return;

    const raw = await chatJSON({ system: sys, user });
    timeline.recordExtract(tctx, label, raw);
    timeline.recordPrompt(tctx, `EXTRACT_${label.toUpperCase()}`, {
      inputText: user,
      outputText: JSON.stringify(raw),
    });

    const parsed = ActionsOut.safeParse(raw);
    if (parsed.success) actions.push(...parsed.data.actions);
  }

  await run('LOCATION_UPDATE', P.EXTRACT_LOCATION_UPDATE, 'location_update');
  await run('SOLD', P.EXTRACT_SOLD, 'sold');
  await run('REPAIR', P.EXTRACT_REPAIR, 'repair');
  await run('READY', P.EXTRACT_READY, 'ready');
  await run('DROP_OFF', P.EXTRACT_DROP_OFF, 'drop_off');
  await run('CUSTOMER_APPOINTMENT', P.EXTRACT_CUSTOMER_APPOINTMENT, 'customer_appointment');

  // RECON_APPOINTMENT — DB-driven (keywords/rules/defaults)
  if (by.RECON_APPOINTMENT.length > 0) {
    let cats = [];
    try { cats = await ReconditionerCategory.find().lean(); } catch {}

    const allowed     = buildAllowedCatsStringSorted(cats);
    const mapKwRules  = buildCatKeywordRuleMapString(cats);
    const mapDefaults = buildCatDefaultServiceMapString(cats);

    const sys = P.EXTRACT_RECON_APPOINTMENT_FROM_DB(allowed, mapKwRules, mapDefaults);
    const user = by.RECON_APPOINTMENT.map((i) => `${i.speaker}: '${i.text}'`).join('\n');

    if (user) {
      const raw = await chatJSON({ system: sys, user });
      timeline.recordExtract(tctx, 'recon_appointment_db', raw);
      timeline.recordPrompt(tctx, 'EXTRACT_RECON_APPOINTMENT', {
        inputText: `Allowed:\n${allowed}\n\nKeywords/Rules:\n${mapKwRules || '(none)'}\n\nDefault services:\n${mapDefaults || '(none)'}\n\nUSER:\n${user}`,
        outputText: JSON.stringify(raw),
      });

      const parsed = ActionsOut.safeParse(raw);
      if (parsed.success) actions.push(...parsed.data.actions);
    }
  }

  await run('NEXT_LOCATION', P.EXTRACT_NEXT_LOCATION, 'next_location');
  await run('TASK', P.EXTRACT_TASK, 'task');

  // normalize rego
  for (const a of actions) {
    if ('rego' in a && a.rego) a.rego = a.rego.replace(/\s+/g, '').toUpperCase();
  }

  timeline.recordExtractAll(tctx, actions);
  return actions;
}

/* ================================
   Public API
================================ */
async function processBatch(messages, tctx) {
  // If earlier pipeline stages do Photo Analysis / Rego match / Car create,
  // call timeline.recordPhotoAnalysis(...) / recordRegoMatch(...) / recordCarCreate(...) in those stages.
  const { categorized } = await filterRefineCategorize(messages, tctx);
  const actions = await extractActions(categorized, tctx);

  // If you run an AI QA audit after actions, call:
  // timeline.recordQAAudit(tctx, qaPayload);

  return { actions, categorized };
}

module.exports = { processBatch };
