// src/services/ai/pipeline.js
const { z } = require('zod');
const { chatJSON } = require('./llmClient');
const P = require('../../prompts/pipelinePrompts');
const timeline = require('../logging/timelineLogger');
const ReconditionerCategory = require('../../models/ReconditionerCategory'); // DB categories
const { ensureCarForAction } = require('../updaters/carUpdater');

/* ──────────────────────────────────────────────────────────────────────────
   Zod shapes for LLM I/O
────────────────────────────────────────────────────────────────────────── */
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

/* ──────────────────────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────────────────────── */
const normRego = (s='') => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const proper = (s='') => {
  const t = String(s).trim();
  if (!t) return '';
  // preserve common lower-case models like "i30", otherwise Capitalize Words
  if (/^(i\d{2}|cx-\d|bt-\d|xr\d|gti|sti|rs|mx-\d)$/i.test(t)) return t.toUpperCase() === 'GTI' ? 'GTI' : t;
  return t.replace(/\b([a-z])/g, (m) => m.toUpperCase());
};

/** Extract rough {rego, make, model, badge, year, description} from a line. */
function sniffVehicle(line='') {
  const s = String(line);
  const out = { rego:'', make:'', model:'', badge:'', year:'', description:'' };

  // rego
  const mRego = s.match(/\brego\s*([A-Z0-9\- ]{4,})\b/i) || s.match(/\b([A-Z0-9]{5,8})\b(?=.*\brego\b)/i);
  if (mRego) out.rego = normRego(mRego[1]);

  // very light make/model sniff (handles "[PHOTO] Photo analysis: Mazda CX-5 black …")
  const mMakeModel = s.match(/(?:analysis:\s*)?([A-Za-z]{2,})\s+([A-Za-z0-9\-]+)(?:\s|,|$)/i);
  if (mMakeModel) {
    out.make = proper(mMakeModel[1]);
    out.model = mMakeModel[2];
  }

  // year
  const mYear = s.match(/\b(20\d{2}|19\d{2})\b/);
  if (mYear) out.year = mYear[1];

  // description – grab colour-ish words if present
  const mDesc = s.match(/\b(white|black|grey|gray|silver|blue|red|green|yellow|gold|beige|brown)\b/i);
  if (mDesc) out.description = proper(mDesc[1]);

  return out;
}

/**
 * PRE-ENSURE PASS
 * Scan filtered messages, collect any lines that contain a rego + (make or model),
 * and create/link cars BEFORE categorization/extraction.
 */
async function preEnsureVehicles(filteredMessages = [], tctx) {
  const seen = new Set();
  for (const m of filteredMessages) {
    const v = sniffVehicle(m.text || '');
    const key = `${v.rego}|${v.make}|${v.model}`;
    if (!v.rego || (!v.make && !v.model) || seen.has(key)) continue;

    try {
      await ensureCarForAction({
        rego: v.rego,
        make: v.make,
        model: v.model,
        badge: v.badge,
        year: v.year,
        description: v.description,
      });
      timeline.change(tctx, `ensureCar (prepass): ${v.rego} (${[v.make, v.model].filter(Boolean).join(' ')})`);
      seen.add(key);
    } catch (e) {
      timeline.identFail(tctx, { reason: `ensureCar prepass failed: ${e.message}`, rego: v.rego, make: v.make, model: v.model });
    }
  }
}

/** Categorizer duplication invariants. */
function applyDuplicationRules(items) {
  const base = Array.isArray(items) ? items.slice() : [];
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
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(it);
    }
  }
  return deduped;
}

const fmt = (msgs) => msgs.map((m) => `${m.speaker || 'Unknown'}: '${m.text}'`).join('\n');

/* ──────────────────────────────────────────────────────────────────────────
   Step 1–3: Filter → (PRE-ENSURE) → Refine → Categorize
────────────────────────────────────────────────────────────────────────── */
async function filterRefineCategorize(batch, tctx) {
  timeline.recordBatch(tctx, batch);

  // Filter (bullets expanded, only actionable retained)
  const f = FilterOut.parse(await chatJSON({ system: P.FILTER_SYSTEM, user: fmt(batch) }));
  timeline.recordP1(tctx, f.messages);

  // 🔒 PRE-ENSURE VEHICLES **before** any prompting that creates actions
  await preEnsureVehicles(f.messages, tctx);

  // Refine wording (no new facts)
  const r = FilterOut.parse(await chatJSON({ system: P.REFINE_SYSTEM, user: fmt(f.messages) }));
  timeline.recordP2(tctx, r.messages);

  // Categorize (dynamic RECON keywords)
  let cats = [];
  try {
    cats = await ReconditionerCategory.find().lean();
  } catch (e) {
    timeline.recordP3(tctx, { warn: 'failed to load categories', error: e.message });
  }
  const reconKeywordsList = buildReconKeywordsFlat(cats);
  const categorizeSystem = reconKeywordsList ? P.CATEGORIZE_SYSTEM_DYNAMIC(reconKeywordsList) : P.CATEGORIZE_SYSTEM;

  const c = CatOut.parse(await chatJSON({ system: categorizeSystem, user: fmt(r.messages) }));
  const withDupes = applyDuplicationRules(c.items);

  timeline.recordP3(tctx, withDupes);
  return { refined: r.messages, categorized: withDupes };
}

/* ──────────────────────────────────────────────────────────────────────────
   Step 4: Extraction (per category)
────────────────────────────────────────────────────────────────────────── */
function buildAllowedCatsString(cats = []) {
  if (!Array.isArray(cats) || cats.length === 0) return '"Other"';
  return cats.map((c) => `"${String(c.name).trim()}"`).join(', ');
}
function buildCatKeywordMapString(cats = []) {
  if (!Array.isArray(cats) || cats.length === 0) return '';
  return cats.map((c) => {
    const name = String(c.name || '').trim();
    const kws = (c.keywords || []).map((k) => `"${String(k).trim().toLowerCase()}"`).join(', ');
    return `${name}: [${kws}]`;
  }).join('\n');
}
function buildReconKeywordsFlat(cats = []) {
  const set = new Set();
  for (const c of cats) for (const k of (c.keywords || [])) {
    const v = String(k || '').trim().toLowerCase();
    if (v) set.add(v);
  }
  if (!set.size) return '';
  return Array.from(set).map((s) => `- "${s}"`).join('\n');
}

async function extractActions(items, tctx) {
  const by = {
    LOCATION_UPDATE: [], SOLD: [], REPAIR: [], READY: [], DROP_OFF: [],
    CUSTOMER_APPOINTMENT: [], RECON_APPOINTMENT: [], NEXT_LOCATION: [], TASK: [], OTHER: [],
  };
  for (const it of items) (by[it.category] || by.OTHER).push(it);

  const actions = [];
  async function run(cat, sys, label) {
    const user = by[cat].map((i) => `${i.speaker}: '${i.text}'`).join('\n');
    if (!user) return;
    const raw = await chatJSON({ system: sys, user });
    timeline.recordExtract(tctx, label, raw);
    const parsed = ActionsOut.safeParse(raw);
    if (parsed.success) actions.push(...parsed.data.actions);
  }

  await run('LOCATION_UPDATE', P.EXTRACT_LOCATION_UPDATE, 'location_update');
  await run('SOLD',            P.EXTRACT_SOLD,            'sold');
  await run('REPAIR',          P.EXTRACT_REPAIR,          'repair');
  await run('READY',           P.EXTRACT_READY,           'ready');
  await run('DROP_OFF',        P.EXTRACT_DROP_OFF,        'drop_off');
  await run('CUSTOMER_APPOINTMENT', P.EXTRACT_CUSTOMER_APPOINTMENT, 'customer_appointment');

  if (by.RECON_APPOINTMENT.length > 0) {
    let cats = [];
    try { cats = await ReconditionerCategory.find().lean(); } catch (e) {
      timeline.recordExtract(tctx, 'recon_cats_error', { error: e.message });
    }
    const allowed = buildAllowedCatsString(cats);
    const mapping = buildCatKeywordMapString(cats);
    const sys = P.EXTRACT_RECON_APPOINTMENT_FROM_DB(allowed, mapping);
    await run('RECON_APPOINTMENT', sys, 'recon_appointment_db');
  }

  await run('NEXT_LOCATION',   P.EXTRACT_NEXT_LOCATION,   'next_location');
  await run('TASK',            P.EXTRACT_TASK,            'task');

  // normalize rego
  for (const a of actions) if ('rego' in a && a.rego) a.rego = normRego(a.rego);

  timeline.recordExtractAll(tctx, actions);
  return actions;
}

/* ──────────────────────────────────────────────────────────────────────────
   Public entry
────────────────────────────────────────────────────────────────────────── */
async function processBatch(messages, tctx) {
  const { categorized } = await filterRefineCategorize(messages, tctx);
  const actions = await extractActions(categorized, tctx);
  return { actions, categorized };
}

module.exports = { processBatch };
