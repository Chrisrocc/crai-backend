// src/services/ai/pipeline.js
const { z } = require('zod');
const { chatJSON } = require('./llmClient');
const P = require('../../prompts/pipelinePrompts');
const timeline = require('../logging/timelineLogger');
const ReconditionerCategory = require('../../models/ReconditionerCategory'); // DB categories

// ---------- env / debug ----------
const DEBUG = String(process.env.PIPELINE_DEBUG || '').trim() === '1';
const dbg = (...args) => { if (DEBUG) console.log(...args); };

/**
 * -------- Schemas for LLM I/O --------
 */
const Msg = z.object({
  speaker: z.string().default(''),
  text: z.string().default(''),
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

// All actions include these common vehicle-ident fields
const Common = {
  rego: z.string().default(''),
  make: z.string().default(''),
  model: z.string().default(''),
  badge: z.string().default(''),
  year: z.string().default(''),
  description: z.string().default(''),
};

// Individual action shapes
const A_Loc = z.object({
  type: z.literal('LOCATION_UPDATE'),
  location: z.string().default(''),
  ...Common,
});

const A_Sold = z.object({
  type: z.literal('SOLD'),
  ...Common,
});

const A_Rep = z.object({
  type: z.literal('REPAIR'),
  checklistItem: z.string().default(''),
  ...Common,
});

const A_Ready = z.object({
  type: z.literal('READY'),
  readiness: z.string().default(''),
  ...Common,
});

const A_Drop = z.object({
  type: z.literal('DROP_OFF'),
  destination: z.string().default(''),
  note: z.string().default(''),
  ...Common,
});

const A_CAppt = z.object({
  type: z.literal('CUSTOMER_APPOINTMENT'),
  name: z.string().default(''),
  dateTime: z.string().default(''),
  notes: z.string().default(''),
  ...Common,
});

const A_RAppt = z.object({
  type: z.literal('RECON_APPOINTMENT'),
  name: z.string().default(''),
  service: z.string().default(''),
  category: z.string().default(''),
  dateTime: z.string().default(''),
  notes: z.string().default(''),
  ...Common,
});

const A_Next = z.object({
  type: z.literal('NEXT_LOCATION'),
  nextLocation: z.string().default(''),
  ...Common,
});

const A_Task = z.object({
  type: z.literal('TASK'),
  task: z.string().default(''),
  ...Common,
});

// Union of all actions
const ActionsOut = z.object({
  actions: z
    .array(
      z.union([A_Loc, A_Sold, A_Rep, A_Ready, A_Drop, A_CAppt, A_RAppt, A_Next, A_Task])
    )
    .default([]),
});

/**
 * Build the dynamic lists used by prompts
 */
function buildAllowedCatsString(cats = []) {
  if (!Array.isArray(cats) || cats.length === 0) return '"Other"';
  return cats.map((c) => `"${String(c.name).trim()}"`).join(', ');
}
function buildCatKeywordMapString(cats = []) {
  if (!Array.isArray(cats) || cats.length === 0) return '';
  return cats
    .map((c) => {
      const name = String(c.name || '').trim();
      const kws = (c.keywords || []).map((k) => `"${String(k).trim().toLowerCase()}"`).join(', ');
      return `${name}: [${kws}]`;
    })
    .join('\n');
}
function buildReconKeywordsFlat(cats = []) {
  const set = new Set();
  for (const c of cats) {
    for (const k of (c.keywords || [])) {
      const v = String(k || '').trim().toLowerCase();
      if (v) set.add(v);
    }
  }
  if (set.size === 0) return '';
  return Array.from(set).map((s) => `- "${s}"`).join('\n');
}

/**
 * Format a list of {speaker,text} into the plain text that prompts expect
 */
const fmt = (msgs) => msgs.map((m) => `${m.speaker || 'Unknown'}: '${m.text}'`).join('\n');

/**
 * Duplication rules (hard guarantees, not just prompt guidance)
 * - REPAIR <-> RECON_APPOINTMENT (both ways)
 * - DROP_OFF -> NEXT_LOCATION (one-way)
 * Also de-duplicate identical (speaker,text,category) triples.
 */
function applyDuplicationRules(items) {
  const base = Array.isArray(items) ? items.slice() : [];
  const out = base.slice(); // start with originals
  for (const it of base) {
    if (it.category === 'REPAIR') {
      out.push({ ...it, category: 'RECON_APPOINTMENT' });
    }
    if (it.category === 'RECON_APPOINTMENT') {
      out.push({ ...it, category: 'REPAIR' });
    }
    if (it.category === 'DROP_OFF') {
      out.push({ ...it, category: 'NEXT_LOCATION' });
    }
  }
  // dedupe
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

/**
 * Step 1-3: Filter → Refine → Categorize (dynamic categorizer to honor user keywords)
 */
async function filterRefineCategorize(batch, tctx) {
  timeline.recordBatch(tctx, batch);

  const f = FilterOut.parse(
    await chatJSON({ system: P.FILTER_SYSTEM, user: fmt(batch) })
  );
  timeline.recordP1(tctx, f.messages);

  const r = FilterOut.parse(
    await chatJSON({ system: P.REFINE_SYSTEM, user: fmt(f.messages) })
  );
  timeline.recordP2(tctx, r.messages);

  // --- Dynamic categorizer: promote RECON when a keyword is present ---
  let cats = [];
  try {
    cats = await ReconditionerCategory.find().lean();
  } catch (e) {
    timeline.recordP3(tctx, { warn: 'failed to load categories for dynamic categorizer', error: e.message });
  }
  const reconKeywordsList = buildReconKeywordsFlat(cats); // flat bullet list for system
  const categorizeSystem = reconKeywordsList
    ? P.CATEGORIZE_SYSTEM_DYNAMIC(reconKeywordsList)
    : P.CATEGORIZE_SYSTEM;

  // DEBUG: Show exactly what the model sees for the categorizer
  if (DEBUG) {
    console.log('\n==== PIPELINE DEBUG :: CATEGORIZER (Step 3) ====');
    console.log('Recon keywords (flat):\n' + (reconKeywordsList || '(none)'));
    console.log('\n-- System prompt sent --\n' + categorizeSystem);
    const userPayload = fmt(r.messages);
    console.log('\n-- User payload --\n' + (userPayload || '(empty)'));
    console.log('==============================================\n');
  }

  const c = CatOut.parse(
    await chatJSON({ system: categorizeSystem, user: fmt(r.messages) })
  );

  // ✅ Enforce duplication rules here
  const withDupes = applyDuplicationRules(c.items);

  timeline.recordP3(tctx, withDupes);
  return { refined: r.messages, categorized: withDupes };
}

/**
 * Step 4: Extraction (per category → extractor prompt)
 */
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

  for (const it of items) {
    (by[it.category] || by.OTHER).push(it);
  }

  const actions = [];

  async function run(cat, sys, label) {
    const user = by[cat].map((i) => `${i.speaker}: '${i.text}'`).join('\n');
    if (!user) return;

    // DEBUG: generic extractor payloads (for visibility)
    if (DEBUG && label !== 'recon_appointment_db') {
      console.log(`\n==== PIPELINE DEBUG :: EXTRACTOR [${label}] ====`);
      console.log('-- System prompt sent --\n' + sys);
      console.log('\n-- User payload --\n' + user);
      console.log('==============================================\n');
    }

    const raw = await chatJSON({ system: sys, user });
    timeline.recordExtract(tctx, label, raw);
    const parsed = ActionsOut.safeParse(raw);
    if (parsed.success) {
      actions.push(...parsed.data.actions);
    }
  }

  await run('LOCATION_UPDATE', P.EXTRACT_LOCATION_UPDATE, 'location_update');
  await run('SOLD', P.EXTRACT_SOLD, 'sold');
  await run('REPAIR', P.EXTRACT_REPAIR, 'repair');
  await run('READY', P.EXTRACT_READY, 'ready');
  await run('DROP_OFF', P.EXTRACT_DROP_OFF, 'drop_off');
  await run('CUSTOMER_APPOINTMENT', P.EXTRACT_CUSTOMER_APPOINTMENT, 'customer_appointment');

  // ---- DB-driven RECON extractor (NO hard-coded heuristics) ----
  if (by.RECON_APPOINTMENT.length > 0) {
    let cats = [];
    try {
      cats = await ReconditionerCategory.find().lean();
    } catch (e) {
      timeline.recordExtract(tctx, 'recon_cats_error', { error: e.message });
    }

    const allowed = buildAllowedCatsString(cats);     // e.g. "Auto Electrical","Tint","Battery"
    const mapping = buildCatKeywordMapString(cats);   // e.g. Battery: ["brad floyd","battery","aerial"]
    const sys = P.EXTRACT_RECON_APPOINTMENT_FROM_DB(allowed, mapping);

    // Build the user payload (what lines we’re extracting)
    const user = by.RECON_APPOINTMENT.map((i) => `${i.speaker}: '${i.text}'`).join('\n');

    // DEBUG: show exactly what the model sees for RECON extractor
    if (DEBUG) {
      console.log('\n==== PIPELINE DEBUG :: RECON EXTRACTOR (Step 4) ====');
      console.log('Allowed categories:\n' + allowed);
      console.log('\nKeyword mapping:\n' + (mapping || '(none)'));
      console.log('\n-- System prompt sent --\n' + sys);
      console.log('\n-- User payload --\n' + (user || '(empty)'));
      console.log('==================================================\n');
    }

    // Run RECON extractor directly (bypass generic run() to keep custom debug above)
    if (user) {
      const raw = await chatJSON({ system: sys, user });
      timeline.recordExtract(tctx, 'recon_appointment_db', raw);
      const parsed = ActionsOut.safeParse(raw);
      if (parsed.success) actions.push(...parsed.data.actions);
    }
  }

  await run('NEXT_LOCATION', P.EXTRACT_NEXT_LOCATION, 'next_location');
  await run('TASK', P.EXTRACT_TASK, 'task');

  // Normalize rego to UPPERCASE/no spaces
  for (const a of actions) {
    if ('rego' in a && a.rego) a.rego = a.rego.replace(/\s+/g, '').toUpperCase();
  }

  timeline.recordExtractAll(tctx, actions);
  return actions;
}

/**
 * Public entry: process a batch of chat sub-messages into actions
 */
async function processBatch(messages, tctx) {
  const { categorized } = await filterRefineCategorize(messages, tctx);
  const actions = await extractActions(categorized, tctx);
  return { actions, categorized };
}

module.exports = { processBatch };
