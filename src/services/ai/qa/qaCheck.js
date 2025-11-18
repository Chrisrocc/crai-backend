// backend/src/services/ai/qa/qaCheck.js
//
// Lightweight post-LLM validator that cross-checks the refined lines
// against extracted actions. It looks for preservation of rego/make/model,
// required fields by action type, and obvious contradictions/omissions.
//
// Usage:
//   const report = await runQA({ refined, actions, tctx });
//   // report = { summary:{ total, ok, flagged }, items:[...] }

function normalizeRego(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, '').toUpperCase() : '';
}

function words(str) {
  return String(str || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function extractRegosFromText(text) {
  // Very permissive AU plate heuristic: 5–7 alphanumerics (skip obvious time-like tokens)
  const out = new Set();
  const t = String(text || '').toUpperCase();
  const m = t.match(/[A-Z0-9]{5,7}/g) || [];
  for (const tok of m) {
    if (/^\d{1,2}(:|\.)\d{2}$/.test(tok)) continue; // times
    if (/^\d{4,}$/.test(tok)) continue; // likely year or long number
    out.add(tok);
  }
  return Array.from(out);
}

function scoreSourceAgainstAction(srcText, action) {
  // Score by: rego hit > (make+model) hits > badge/year tokens
  const t = String(srcText || '');
  let score = 0;

  const aRego = normalizeRego(action.rego || '');
  if (aRego && t.toUpperCase().includes(aRego)) score += 10;

  const tWords = words(t);
  const has = (w) => (w && tWords.includes(String(w).toLowerCase()));
  if (has(action.make)) score += 3;
  if (has(action.model)) score += 4;
  if (has(action.badge)) score += 1;
  if (has(action.year)) score += 1;

  // If source itself contains a plausible rego and action has none — still relevant
  const srcRegos = extractRegosFromText(t);
  if (srcRegos.length && !aRego) score += 3;

  return score;
}

function findBestSource(refined, action) {
  let best = null;
  let bestScore = -1;
  for (let i = 0; i < refined.length; i++) {
    const line = refined[i];
    const s = scoreSourceAgainstAction(line.text, action);
    if (s > bestScore) { bestScore = s; best = { index: i, line }; }
  }
  return best; // may be null if refined is empty
}

function requirementFlagsForAction(a) {
  const flags = [];
  const type = a.type;

  const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

  // Required fields by type (minimal, pragmatic)
  if (type === 'LOCATION_UPDATE') {
    if (!trimmed(a.location)) flags.push('FIELD_MISSING:location');
  }
  if (type === 'DROP_OFF') {
    if (!trimmed(a.destination)) flags.push('FIELD_MISSING:destination');
  }
  if (type === 'REPAIR') {
    if (!trimmed(a.checklistItem)) flags.push('FIELD_MISSING:checklistItem');
  }
  if (type === 'READY') {
    // readiness is optional (free text like "ready", "washed"), keep soft
  }
  if (type === 'CUSTOMER_APPOINTMENT') {
    // dateTime and/or name often present but optional; don't hard fail
    // No strict flags here – avoid over-noising UX.
  }
  if (type === 'RECON_APPOINTMENT') {
    // category may be "Other", service may be empty; don't hard fail
  }
  if (type === 'NEXT_LOCATION') {
    if (!trimmed(a.nextLocation)) flags.push('FIELD_MISSING:nextLocation');
  }
  if (type === 'TASK') {
    if (!trimmed(a.task)) flags.push('FIELD_MISSING:task');
  }

  return flags;
}

function compareSourceAndAction(srcText, action) {
  const flags = [];
  const suggestions = [];

  const srcUpper = String(srcText || '').toUpperCase();

  // 1) Rego preservation / injection checks
  const srcRegos = extractRegosFromText(srcText);
  const srcHasRego = srcRegos.length > 0;
  const actRego = normalizeRego(action.rego);

  if (srcHasRego && actRego) {
    if (!srcRegos.includes(actRego)) {
      flags.push('MISMATCH_REGO');
      suggestions.push(`Action rego "${actRego}" not found in source text (saw: ${srcRegos.join(', ')}).`);
    }
  } else if (srcHasRego && !actRego) {
    flags.push('REGO_DROPPED');
    suggestions.push(`Source mentions rego (${srcRegos.join(', ')}) but action.rego is empty.`);
  } else if (!srcHasRego && actRego) {
    // The model may have pulled rego from context/photo; flag gently as 'ADDED_REGO'
    flags.push('ADDED_REGO_NOT_IN_SOURCE');
    suggestions.push(`Action rego "${actRego}" added but source text has no rego token.`);
  }

  // 2) Make/Model preservation where clearly present in source
  const srcHasMake = action.make && srcUpper.includes(String(action.make || '').toUpperCase());
  const srcHasModel = action.model && srcUpper.includes(String(action.model || '').toUpperCase());

  if (!srcHasMake && action.make) {
    // Source may not explicitly have it (comes from context); keep soft
    // Only flag if source has some other make that disagrees (rare), skip for now.
  }
  if (!srcHasModel && action.model) {
    // same as above; skip hard flag
  }

  // 3) Minimal loss heuristic: if the source clearly mentions a model token but action.model is empty -> flag
  // Find any model-ish token (very mild: capitalized word after a make) – we avoid heavy heuristics.
  if (!action.model) {
    // naive probe: if source has a token that equals action.make followed by another word
    const m = srcText.match(/\b([A-Z][a-zA-Z0-9\-]+)\s+([A-Z0-9][a-zA-Z0-9\-\+.]+)\b/);
    if (m && m[1] && m[2]) {
      const maybeMake = m[1].toLowerCase();
      const maybeModel = m[2];
      if (action.make && action.make.toLowerCase() === maybeMake) {
        flags.push('MODEL_LOST_POSSIBLE');
        suggestions.push(`Source likely mentions a model "${maybeModel}" after make "${action.make}", but action.model is empty.`);
      }
    }
  }

  return { flags, suggestions };
}

function findDuplicates(actions) {
  // Duplicate detection by (type, rego, make, model, badge, key-extra)
  const keyOf = (a) => {
    const base = [a.type, normalizeRego(a.rego), (a.make || '').toLowerCase(), (a.model || '').toLowerCase(), (a.badge || '').toLowerCase()].join('|');
    if (a.type === 'DROP_OFF') return base + '|dest:' + (a.destination || '').toLowerCase();
    if (a.type === 'LOCATION_UPDATE') return base + '|loc:' + (a.location || '').toLowerCase();
    if (a.type === 'REPAIR') return base + '|item:' + (a.checklistItem || '').toLowerCase();
    if (a.type === 'CUSTOMER_APPOINTMENT' || a.type === 'RECON_APPOINTMENT') return base + '|dt:' + (a.dateTime || '').toLowerCase();
    if (a.type === 'NEXT_LOCATION') return base + '|next:' + (a.nextLocation || '').toLowerCase();
    if (a.type === 'TASK') return base + '|task:' + (a.task || '').toLowerCase();
    return base;
  };

  const map = new Map();
  actions.forEach((a, idx) => {
    const k = keyOf(a);
    const arr = map.get(k) || [];
    arr.push(idx);
    map.set(k, arr);
  });

  const dupIdxGroups = [];
  for (const arr of map.values()) {
    if (arr.length > 1) dupIdxGroups.push(arr);
  }
  return dupIdxGroups;
}

async function runQA({ refined = [], actions = [], tctx = null } = {}) {
  const items = [];

  // 0) Duplicates across actions
  const dups = findDuplicates(actions);
  for (const group of dups) {
    for (const i of group) {
      items.push({
        kind: 'duplicate',
        actionIndex: i,
        action: actions[i],
        sourceIndex: null,
        sourceText: '',
        flags: ['POSSIBLE_DUPLICATE'],
        suggestions: [`Duplicate group: ${group.join(', ')}`],
        status: 'FLAG'
      });
    }
  }

  // 1) Per-action checks against best matching refined source
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const reqFlags = requirementFlagsForAction(a);

    let best = null;
    if (refined && refined.length) {
      best = findBestSource(refined, a);
    }

    let cmp = { flags: [], suggestions: [] };
    if (best && best.line) {
      cmp = compareSourceAndAction(best.line.text, a);
    } else {
      // No source lines — still produce requirement flags
    }

    const flags = [...reqFlags, ...cmp.flags];
    const suggestions = [...cmp.suggestions];

    items.push({
      kind: 'field_check',
      actionIndex: i,
      action: a,
      sourceIndex: best ? best.index : null,
      sourceText: best ? best.line.text : '',
      flags,
      suggestions,
      status: flags.length ? 'FLAG' : 'OK'
    });
  }

  const flagged = items.filter(x => x.status === 'FLAG').length;
  const total = items.length;
  const report = {
    summary: { total, ok: total - flagged, flagged },
    items
  };

  return report;
}

module.exports = { runQA, normalizeRego, extractRegosFromText };
