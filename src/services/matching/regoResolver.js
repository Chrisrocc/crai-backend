// src/services/matching/regoResolver.js
const Car = require('../../models/Car');
const { levenshtein } = require('./levenshtein');
const { confusionDistance } = require('./plateConfusions');
const audit = require('../logging/auditLogger');

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const cmp = (a, b) => (a.total - b.total) || (a.lev - b.lev);

function totalScore({ lev, confusion, confWeight = 0.7, levWeight = 0.3 }) {
  return levWeight * lev + confWeight * confusion;
}

function isSafeAutoFix(best, second, ocrConf = 0.9) {
  // heuristics: strong similarity + margin over second + decent OCR conf
  if (!best) return false;
  const margin = second ? (second.total - best.total) : 2; // treat no-second as strong margin
  return best.total <= 1.2 && margin >= 0.8 && ocrConf >= 0.75;
}

async function resolveRego({ regoOCR, make, model, color, ocrConfidence = 0.9, apply = false, auditCtx }) {
  const ocr = norm(regoOCR);
  const qMake = String(make || '').trim();
  const qModel = String(model || '').trim();

  const baseSummary = `ocr:${ocr || '-'} make:${qMake || '-'} model:${qModel || '-'}`;

  const cars = await Car.find({
    make: new RegExp(`^${qMake}$`, 'i'),
    model: new RegExp(`^${qModel}$`, 'i'),
  }).lean();

  audit.write(auditCtx, 'rego.resolve.candidates', {
    summary: `${baseSummary} candidates:${cars.length}`,
    make: qMake, model: qModel, count: cars.length,
    regs: cars.map(c => c.rego),
  });

  // ✅ If no candidates found — signal to create a new car
  if (!cars.length || !ocr) {
    audit.write(auditCtx, 'rego.resolve.no-candidates', { summary: baseSummary });
    return { action: 'create', best: null, alts: [], distances: null };
  }

  // score each
  const scored = cars.map(c => {
    const lev = levenshtein(ocr, c.rego);
    const conf = confusionDistance(ocr, c.rego);
    const total = totalScore({ lev, confusion: conf });
    return { car: c, rego: c.rego, lev, confusion: conf, total };
  }).sort(cmp);

  const best = scored[0];
  const second = scored[1];

  audit.write(auditCtx, 'rego.resolve.scored', {
    summary: `best:${best?.rego || '-'} total:${best?.total ?? '-'} lev:${best?.lev ?? '-'} conf:${best?.confusion ?? '-'}`,
    list: scored.slice(0, 10).map(s => ({
      rego: s.rego, total: s.total, lev: s.lev, conf: s.confusion,
    })),
  });

  // exact match
  if (best && best.lev === 0) {
    audit.write(auditCtx, 'rego.resolve.exact', { summary: `exact:${best.rego}` });
    return { action: 'exact', best, alts: scored.slice(1, 5), distances: { lev: best.lev, confusion: best.confusion, total: best.total } };
  }

  if (!best) {
    audit.write(auditCtx, 'rego.resolve.reject', { summary: 'no-best' });
    return { action: 'create', best: null, alts: [], distances: null };
  }

  const safe = isSafeAutoFix(best, second, ocrConfidence);
  const result = {
    action: safe ? 'auto-fix' : 'review',
    best,
    alts: scored.slice(1, 5),
    distances: { lev: best.lev, confusion: best.confusion, total: best.total },
  };

  if (apply && safe) {
    audit.write(auditCtx, 'rego.resolve.apply', {
      summary: `auto-fix:${best.rego} (from:${ocr})`,
      best,
    });
  } else {
    audit.write(auditCtx, 'rego.resolve.decision', {
      summary: `${result.action} best:${best.rego} total:${best.total}`,
      best, second,
    });
  }

  return result;
}

module.exports = { resolveRego };
