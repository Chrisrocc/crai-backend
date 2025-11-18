// src/services/ai/pipeline.js
const { z } = require('zod');
const { chatJSON } = require('./llmClient');
const P = require('../../prompts/pipelinePrompts');
const timeline = require('../logging/timelineLogger');
const ReconditionerCategory = require('../../models/ReconditionerCategory');
const { runAudit } = require('./qa/qaCheck'); // AI audit

// ---------- env / debug ----------
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
   Helpers for dynamic prompts
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

const fmt = (msgs) =>
  (Array.isArray(msgs) ? msgs : [])
    .map((m) => `${m.speaker || 'Unknown'}: '${m.text}'`)
    .join('\n');

/* ================================
   Duplication Guarantees
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
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(it);
    }
  }
  return deduped;
}

/* ================================
   Step 1–3: Filter → Refine → Categorize
================================ */
async function filterRefineCategorize(batch, tctx) {
  timeline.section(tctx, "MESSAGES", fmt(batch).split("\n"));

  const f = FilterOut.parse(await chatJSON({ system: P.FILTER_SYSTEM, user: fmt(batch) }));
  timeline.section(tctx, "FILTER", f.messages.map(m => `${m.speaker}: ${m.text}`));

  const r = FilterOut.parse(await chatJSON({ system: P.REFINE_SYSTEM, user: fmt(f.messages) }));
  timeline.section(tctx, "REFINE", r.messages.map(m => `${m.speaker}: ${m.text}`));

  // Categories (dynamic)
  let cats = [];
  try {
    cats = await ReconditionerCategory.find().lean();
  } catch {}

  const reconHintsFlat = buildReconHintsFlat(cats);
  const categorizeSystem = reconHintsFlat
    ? P.CATEGORIZE_SYSTEM_DYNAMIC(reconHintsFlat)
    : P.CATEGORIZE_SYSTEM;

  if (DEBUG) {
    console.log('\n==== PIPELINE DEBUG :: CATEGORIZER (Step 3) ====');
    console.log('Recon hints (keywords + rules):\n' + (reconHintsFlat || '(none)'));

    const userPayload = fmt(r.messages);
    console.log('\n-- User payload --\n' + (userPayload || '(empty)'));

    console.log('\n-- System prompt: CATEGORIZE (dynamic) --');
    console.log('  (full prompt suppressed in logs to keep output clean)');
    console.log('==============================================\n');
  }

  const c = CatOut.parse(await chatJSON({ system: categorizeSystem, user: fmt(r.messages) }));
  timeline.section(
    tctx,
    "CATEGORIZE",
    c.items.map(i => `${i.category} — ${i.speaker}: '${i.text}'`)
  );

  const withDupes = applyDuplicationRules(c.items);
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

  for (const it of (Array.isArray(items) ? items : [])) {
    (by[it.category] || by.OTHER).push(it);
  }

  const actions = [];

  function findBestSource(candidates = [], act = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    const rego = (act.rego || '').replace(/\s+/g, '').toUpperCase();
    const make = String(act.make || '').toLowerCase();
    const model = String(act.model || '').toLowerCase();

    // 1) Exact rego (whitespace-insensitive) in text
    if (rego) {
      for (const c of candidates) {
        const txt = String(c.text || '');
        const norm = txt.replace(/\s+/g, '').toUpperCase();
        if (norm.includes(rego)) return c;
      }
    }

    // 2) Make + model tokens in text
    const tokens = [make, model].filter(Boolean);
    if (tokens.length) {
      for (const c of candidates) {
        const txt = String(c.text || '').toLowerCase();
        if (tokens.every((t) => txt.includes(t))) {
          return c;
        }
      }
    }

    // 3) Fallback: first candidate
    return candidates[0] || null;
  }

  async function run(cat, sys, label) {
    const candidates = by[cat];
    const user = (Array.isArray(candidates) ? candidates : [])
      .map((i) => `${i.speaker}: '${i.text}'`)
      .join('\n');
    if (!user) return;

    const raw = await chatJSON({ system: sys, user });
    timeline.prompt(tctx, label, { inputText: user, outputText: JSON.stringify(raw) });

    const parsed = ActionsOut.safeParse(raw);
    if (parsed.success) {
      for (const act of parsed.data.actions) {
        const src = findBestSource(candidates, act);
        actions.push({
          ...act,
          _sourceSpeaker: src?.speaker || '',
          _sourceText: src?.text || '',
        });
      }
    }
  }

  await run('LOCATION_UPDATE', P.EXTRACT_LOCATION_UPDATE, 'EXTRACT_LOCATION_UPDATE');
  await run('SOLD', P.EXTRACT_SOLD, 'EXTRACT_SOLD');
  await run('REPAIR', P.EXTRACT_REPAIR, 'EXTRACT_REPAIR');
  await run('READY', P.EXTRACT_READY, 'EXTRACT_READY');
  await run('DROP_OFF', P.EXTRACT_DROP_OFF, 'EXTRACT_DROP_OFF');
  await run('CUSTOMER_APPOINTMENT', P.EXTRACT_CUSTOMER_APPOINTMENT, 'EXTRACT_CUSTOMER_APPOINTMENT');

  if (by.RECON_APPOINTMENT.length > 0) {
    let cats = [];
    try {
      cats = await ReconditionerCategory.find().lean();
    } catch {}

    const allowed     = buildAllowedCatsStringSorted(cats);
    const mapKwRules  = buildCatKeywordRuleMapString(cats);
    const mapDefaults = buildCatDefaultServiceMapString(cats);

    const sys = P.EXTRACT_RECON_APPOINTMENT_FROM_DB(allowed, mapKwRules, mapDefaults);
    const candidates = by.RECON_APPOINTMENT;
    const user = (Array.isArray(candidates) ? candidates : [])
      .map((i) => `${i.speaker}: '${i.text}'`)
      .join('\n');

    if (user) {
      const raw = await chatJSON({ system: sys, user });
      timeline.prompt(tctx, 'EXTRACT_RECON_APPOINTMENT', {
        inputText: `Allowed:\n${allowed}\n\nKeywords/Rules:\n${mapKwRules}\n\nDefault services:\n${mapDefaults}\n\nUSER:\n${user}`,
        outputText: JSON.stringify(raw),
      });
      const parsed = ActionsOut.safeParse(raw);
      if (parsed.success) {
        for (const act of parsed.data.actions) {
          const src = findBestSource(candidates, act);
          actions.push({
            ...act,
            _sourceSpeaker: src?.speaker || '',
            _sourceText: src?.text || '',
          });
        }
      }
    }
  }

  await run('NEXT_LOCATION', P.EXTRACT_NEXT_LOCATION, 'EXTRACT_NEXT_LOCATION');
  await run('TASK', P.EXTRACT_TASK, 'EXTRACT_TASK');

  // Normalize rego
  for (const a of actions) {
    if ('rego' in a && a.rego) {
      a.rego = a.rego.replace(/\s+/g, '').toUpperCase();
    }
  }

  timeline.actions(tctx, actions);
  return actions;
}

/* ================================
   Public API
================================ */
async function processBatch(messages, tctx) {
  const { refined, categorized } = await filterRefineCategorize(messages, tctx);
  const actions = await extractActions(categorized, tctx);

  // ---- AI AUDIT (read-only, per-action justification) ----
  const audit = await runAudit({ batch: messages, refined, actions });
  timeline.recordAudit(tctx, audit);

  return { actions, categorized };
}

module.exports = { processBatch };
