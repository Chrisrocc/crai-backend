// src/services/matching/regoMatcher.js
const Car = require('../../models/Car');

/** Normalize helpers */
const normPlate = (s = '') => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const norm = (s = '') => String(s).trim();
const same = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();

/** Confusable character map (bi-directional) */
const CONFUSABLE = new Map([
  // letters ↔ digits
  ['O:0', 0.2], ['0:O', 0.2],
  ['I:1', 0.2], ['1:I', 0.2],
  ['B:8', 0.2], ['8:B', 0.2],
  ['S:5', 0.2], ['5:S', 0.2],
  ['Z:2', 0.2], ['2:Z', 0.2],
  ['G:6', 0.2], ['6:G', 0.2],
  ['Q:O', 0.2], ['O:Q', 0.2],
]);

const COST = {
  substitute: 1.0,       // normal substitution
  confusable: 0.2,       // if in CONFUSABLE
  insertion: 1.0,
  deletion: 1.0,
  transpose: 0.4,        // adjacent swap cost
};

function substCost(a, b) {
  if (a === b) return 0;
  const key = `${a}:${b}`;
  if (CONFUSABLE.has(key)) return CONFUSABLE.get(key);
  return COST.substitute;
}

/**
 * Weighted Damerau–Levenshtein with:
 * - custom substitution weights (confusables cheap)
 * - adjacent transposition cost
 */
function weightedEditDistance(aRaw, bRaw) {
  const a = normPlate(aRaw);
  const b = normPlate(bRaw);
  const n = a.length;
  const m = b.length;

  // DP table
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) dp[i][0] = i * COST.deletion;
  for (let j = 1; j <= m; j++) dp[0][j] = j * COST.insertion;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const costSub = dp[i - 1][j - 1] + substCost(a[i - 1], b[j - 1]);
      const costDel = dp[i - 1][j] + COST.deletion;
      const costIns = dp[i][j - 1] + COST.insertion;
      let best = Math.min(costSub, costDel, costIns);

      // transposition (adjacent)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, dp[i - 2][j - 2] + COST.transpose);
      }
      dp[i][j] = best;
    }
  }
  return dp[n][m];
}

/**
 * Decision policy
 * - autoFixThreshold: <= 0.6 and unique → auto-fix
 * - reviewThreshold:  <= 1.2 → human review
 */
const DEFAULT_POLICY = {
  autoFixThreshold: 0.6,
  reviewThreshold: 1.2,
  minConfidenceForAuto: 0.8, // OCR confidence gate (optional)
  uniqueMargin: 0.2,         // best must beat 2nd by this margin
  disallowIfSold: true,
};

async function findCandidates({ make, model, color, year }) {
  const q = {
    ...(make ? { make: new RegExp(`^${norm(make)}$`, 'i') } : {}),
    ...(model ? { model: new RegExp(`^${norm(model)}$`, 'i') } : {}),
  };
  // color/year are optional and *not* strict here — you can tighten later
  const cars = await Car.find(q).lean();
  return cars;
}

/**
 * Main matching function
 */
async function matchRego({
  ocrRego,
  make,
  model,
  color,
  year,
  ocrConfidence, // 0..1 optional
  policy = DEFAULT_POLICY,
}) {
  const result = {
    action: 'reject', // 'auto-fix' | 'review' | 'reject'
    reason: 'no-candidates',
    best: null,
    second: null,
    scores: [],
  };

  const plate = normPlate(ocrRego);
  if (!plate) {
    result.reason = 'empty-plate';
    return result;
  }

  const cars = await findCandidates({ make, model, color, year });
  if (!cars.length) {
    result.reason = 'no-candidates';
    return result;
  }

  // Score all candidate plates
  const scored = cars.map((c) => ({
    car: c,
    plate: c.rego,
    score: weightedEditDistance(plate, c.rego),
  }));

  scored.sort((a, b) => a.score - b.score);
  result.scores = scored.map(s => ({ rego: s.plate, score: Number(s.score.toFixed(3)), id: String(s.car._id) }));
  result.best = scored[0] || null;
  result.second = scored[1] || null;

  if (!result.best) {
    result.reason = 'no-best';
    return result;
  }

  // Optional: block auto on sold
  if (policy.disallowIfSold && same(result.best.car.stage, 'sold')) {
    if (result.best.score <= policy.reviewThreshold) {
      result.action = 'review';
      result.reason = 'best-is-sold';
    } else {
      result.action = 'reject';
      result.reason = 'best-is-sold-far';
    }
    return result;
  }

  // Decision tree
  const bestScore = result.best.score;
  const secondScore = result.second ? result.second.score : Infinity;
  const unique = (secondScore - bestScore) >= policy.uniqueMargin;
  const confOK = (ocrConfidence == null) || (ocrConfidence >= policy.minConfidenceForAuto);

  if (bestScore <= policy.autoFixThreshold && unique && confOK) {
    result.action = 'auto-fix';
    result.reason = 'unique-under-auto-threshold';
    return result;
  }

  if (bestScore <= policy.reviewThreshold) {
    result.action = 'review';
    result.reason = unique ? 'under-review-threshold' : 'tie-needs-human';
    return result;
  }

  result.action = 'reject';
  result.reason = 'over-review-threshold';
  return result;
}

module.exports = {
  matchRego,
  weightedEditDistance,
  DEFAULT_POLICY,
  normPlate,
};
