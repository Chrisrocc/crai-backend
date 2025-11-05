// src/services/carIdentifier.js
const Car = require('../models/Car');
const audit = require('./logging/auditLogger');
const { weightedEditDistance, DEFAULT_POLICY } = require('./matching/regoMatcher');

// -------- utils --------
const sanitize = (s = '') => String(s).trim();
const normStr = (s = '') => sanitize(s).toLowerCase();
const normRego = (s = '') => sanitize(s).replace(/\s+/g, '').toUpperCase();
const asYear = (y) => (y == null ? null : Number(String(y).trim()));

function statusNormalize(s = '') {
  const t = normStr(s);
  if (/sold/.test(t)) return 'sold';
  if (/online/.test(t)) return 'online';
  if (/(in\s*works|works)/.test(t)) return 'in works';
  if (/ready/.test(t)) return 'ready';
  return t || '';
}
function carStageNormalize(car) {
  const t = normStr(car?.stage || '');
  if (/sold/.test(t)) return 'sold';
  if (/online/.test(t)) return 'online';
  if (/(in\s*works|works)/.test(t)) return 'in works';
  if (/ready/.test(t)) return 'ready';
  return t;
}

// -------- primary finders --------
async function findByRego(rego) {
  const needle = normRego(rego);
  if (!needle) return null;
  return Car.findOne({ rego: new RegExp(`^${needle}$`, 'i') });
}

async function findByMakeModel(make, model) {
  const qMake = sanitize(make);
  const qModel = sanitize(model);
  if (!qMake || !qModel) return [];
  return Car.find({
    make: new RegExp(`^${qMake}$`, 'i'),
    model: new RegExp(`^${qModel}$`, 'i'),
  }).lean();
}

// -------- create-or-link (NEW) --------
/**
 * Ensure we have a Car document:
 * 1) exact rego
 * 2) fuzzy best match among same make+model (unique margin)
 * 3) CREATE if still not found and we have make+model(+rego)
 */
async function ensureCar(base = {}, hints = {}, auditCtx, policy = DEFAULT_POLICY) {
  const rego = normRego(base.rego || hints.rego || '');
  const make = sanitize(base.make || hints.make || '');
  const model = sanitize(base.model || hints.model || '');
  const color = sanitize(base.color || hints.color || '');
  const year  = asYear(base.year ?? hints.year);

  // 1) exact rego
  if (rego) {
    const exact = await findByRego(rego);
    if (exact) {
      audit.write(auditCtx, 'identify.ensure.exact', {
        summary: `exact ${exact.rego}`,
        car: { id: String(exact._id), rego: exact.rego, make: exact.make, model: exact.model }
      });
      return exact;
    }
  }

  // 2) fuzzy among same make+model
  let best = null, second = null, scored = [];
  if (make && model) {
    const candidates = await findByMakeModel(make, model);
    if (candidates.length && rego) {
      scored = candidates.map(c => ({
        car: c,
        score: weightedEditDistance(rego, c.rego),
      })).sort((a,b) => a.score - b.score);
      best = scored[0] || null;
      second = scored[1] || null;

      audit.write(auditCtx, 'identify.ensure.scored', {
        summary: `candidates:${candidates.length} best:${best?.car?.rego || '-'} score:${best?.score ?? '-'}`,
        make, model, rego, list: scored.slice(0,10).map(s=>({ id:String(s.car._id), rego:s.car.rego, score:s.score }))
      });

      const unique = second ? (second.score - best.score) >= (policy.uniqueMargin ?? 0.2) : true;
      if (best && unique && best.score <= (policy.reviewThreshold ?? 1.2)) {
        audit.write(auditCtx, 'identify.ensure.linked', {
          summary: `linked to ${best.car.rego} (score:${best.score}, unique:${unique})`,
        });
        return await Car.findById(best.car._id); // return hydrated doc
      }
    }
  }

  // 3) CREATE new minimal car when we have enough info
  if (make && model && rego) {
    try {
      const doc = new Car({
        rego,
        make,
        model,
        badge: sanitize(base.badge || hints.badge || ''),
        year,
        color,
        stage: 'In Works',
        description: sanitize(hints.description || ''),
        checklist: [],
        notes: '',
        location: sanitize(hints.location || ''),
        readinessStatus: '',
        nextLocations: [],
        history: [],
      });
      await doc.save();
      audit.write(auditCtx, 'identify.ensure.created', {
        summary: `created ${rego} (${make} ${model})`,
        car: { id: String(doc._id), rego: doc.rego, make: doc.make, model: doc.model }
      });
      return doc;
    } catch (e) {
      // handle race: if dup rego appeared meanwhile, fetch it
      if (e?.code === 11000) {
        const dup = await findByRego(rego);
        if (dup) {
          audit.write(auditCtx, 'identify.ensure.dup-linked', {
            summary: `dup linked ${dup.rego}`,
            car: { id: String(dup._id), rego: dup.rego }
          });
          return dup;
        }
      }
      audit.write(auditCtx, 'identify.ensure.create.error', {
        summary: String(e?.message || e),
      });
      throw e;
    }
  }

  // Not enough info to create
  audit.write(auditCtx, 'identify.ensure.insufficient', {
    summary: `insufficient to create (rego:${rego||'-'} make:${make||'-'} model:${model||'-'})`
  });
  return null;
}

// -------- legacy strict path (kept for completeness) --------
async function findByStrictAttributes(base = {}, hints = {}, auditCtx) {
  const make = sanitize(base.make);
  const model = sanitize(base.model);
  if (!make || !model) {
    const msg = 'Strict identification requires make and model when rego is missing.';
    audit.write(auditCtx, 'identify.error', { base, hints, summary: msg });
    throw new Error(msg);
  }

  const candidates = await findByMakeModel(make, model);

  audit.write(auditCtx, 'identify.candidates', {
    base: { make, model },
    count: candidates.length,
    cars: candidates.map(c => ({ id: String(c._id), rego: c.rego, make: c.make, model: c.model })),
    summary: `candidates:${candidates.length}`,
  });

  if (!candidates.length) {
    const msg = 'No cars match specified make+model.';
    audit.write(auditCtx, 'identify.error', { base, hints, summary: msg });
    throw new Error(msg);
  }

  const scored = scoreCandidates(candidates, base, hints);

  scored.sort((a, b) => b.score - a.score);
  audit.write(auditCtx, 'identify.scored', {
    hints,
    scored: scored.map(s => ({
      id: String(s.car._id),
      rego: s.car.rego,
      strongCount: s.strongCount,
      tokenMatch: s.tokenMatch,
      uniqueTokenMatch: s.uniqueTokenMatch,
      score: s.score,
    })),
  });

  const best = scored[0];
  const second = scored[1];
  if (!best || best.strongCount < 2) {
    const msg = 'Ambiguous: no candidate has ≥2 supporting attributes.';
    audit.write(auditCtx, 'identify.error', { summary: msg });
    throw new Error(msg);
  }
  const margin = (best?.score ?? 0) - (second?.score ?? 0);
  if (margin < 2) {
    const msg = 'Ambiguous: top candidates too close to distinguish.';
    audit.write(auditCtx, 'identify.error', { summary: msg });
    throw new Error(msg);
  }

  audit.write(auditCtx, 'identify.result', {
    chosen: { id: String(best.car._id), rego: best.car.rego, make: best.car.make, model: best.car.model },
    summary: `chosen ${best.car.rego} (score:${best.score}, strong:${best.strongCount})`,
  });

  return await Car.findById(best.car._id);
}

// -------- public entry --------
async function identifyCar(base = {}, hints = {}, auditCtx, opts = { createIfMissing: true }) {
  audit.write(auditCtx, 'identify.in', { base, hints, summary: `rego:${base.rego || '-'} make:${base.make || ''} model:${base.model || ''}` });

  // 1) try exact rego immediately
  if (base.rego) {
    const byRego = await findByRego(base.rego);
    if (byRego) {
      audit.write(auditCtx, 'identify.result', {
        chosen: { id: String(byRego._id), rego: byRego.rego, make: byRego.make, model: byRego.model },
        summary: `found by rego ${byRego.rego}`,
      });
      return byRego;
    }
    audit.write(auditCtx, 'identify.path.regoNotFound', { rego: base.rego });
  }

  // 2) create-or-link path when allowed
  if (opts?.createIfMissing !== false) {
    const ensured = await ensureCar(base, hints, auditCtx);
    if (ensured) return ensured;
  }

  // 3) fall back to legacy strict flow (may throw)
  return findByStrictAttributes(base, hints, auditCtx);
}

// -------- scoring used by strict flow --------
function wordTokens(s = '') {
  const text = (s || '').toLowerCase();
  const stop = new Set(['the','and','with','for','to','of','at','is','in','on','a','an','this','that','it','now','car','vehicle']);
  return (text.match(/[a-z0-9]+/g) || []).filter(w => w.length >= 3 && !stop.has(w));
}
const containsToken = (hay = '', token = '') => {
  if (!hay || !token) return false;
  const re = new RegExp(`(?:^|[^a-z0-9])${token}(?:$|[^a-z0-9])`, 'i');
  return re.test(hay);
};
function scoreCandidates(candidates, base, hints) {
  const need = {
    badge: sanitize(hints.badge),
    year: asYear(hints.year),
    location: sanitize(hints.location),
    status: statusNormalize(hints.status),
  };

  const descParts = [hints.description, hints.readiness, hints.nextLocation].filter(Boolean);
  const inputTokens = wordTokens(descParts.join(' '));

  const candAggText = candidates.map((car) => {
    const fields = [
      car.description,
      car.notes,
      car.readinessStatus,
      car.location,
      car.stage,
      car.badge,
      car.series,
      Array.isArray(car.checklist) ? car.checklist.join(' ') : '',
      String(car.year || ''),
      String(car.color || ''),
    ].filter(Boolean).map(String).join(' ').toLowerCase();
    return fields;
  });

  const tokenPresence = new Map();
  inputTokens.forEach((tok) => {
    const pres = [];
    candAggText.forEach((txt, idx) => {
      if (containsToken(txt, tok)) pres.push(idx);
    });
    tokenPresence.set(tok, pres);
  });

  return candidates.map((car, idx) => {
    let strong = 0;
    let tokenMatch = 0;
    let uniqueTokenMatch = 0;

    if (need.badge && normStr(car.badge) === normStr(need.badge)) strong++;
    if (need.year && Number(car.year) === Number(need.year)) strong++;
    if (need.location && normStr(car.location) === normStr(need.location)) strong++;

    if (need.status) {
      const cStage = carStageNormalize(car);
      if (need.status === cStage) strong++;
    }

    const agg = candAggText[idx];
    for (const tok of inputTokens) {
      const present = containsToken(agg, tok);
      if (present) {
        tokenMatch++;
        const presList = tokenPresence.get(tok) || [];
        if (presList.length === 1 && presList[0] === idx) uniqueTokenMatch++;
      }
    }

    const score = strong * 10 + uniqueTokenMatch * 3 + tokenMatch;
    return { car, strongCount: strong, tokenMatch, uniqueTokenMatch, score };
  });
}

module.exports = {
  identifyCar,
  ensureCar,          // NEW export
  findByRego,
};
