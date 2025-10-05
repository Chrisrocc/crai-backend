// src/services/matching/plateConfusions.js
const GROUPS = [
  ['0','O','D','Q'],
  ['1','I','L','T','7'],
  ['2','Z'],
  ['5','S'],
  ['8','B'],
  ['6','G'],
  ['U','V','Y'],
  ['M','N','W'],
  ['C','G'],
  ['K','X'],
  ['H','M'],
];

const COST_MAP = new Map();
for (const g of GROUPS) {
  for (const a of g) for (const b of g) {
    if (a === b) continue;
    COST_MAP.set(`${a}${b}`, 0.5);
  }
}

/** Weighted char distance with OCR-confusion penalties */
function confusionDistance(a = '', b = '') {
  const A = String(a).toUpperCase();
  const B = String(b).toUpperCase();
  const len = Math.max(A.length, B.length);
  let total = 0;
  for (let i = 0; i < len; i++) {
    const ca = A[i] || '';
    const cb = B[i] || '';
    if (ca === cb) continue;
    if (!ca || !cb) { total += 1; continue; }
    const key = `${ca}${cb}`;
    total += COST_MAP.get(key) ?? 1;
  }
  return total;
}

module.exports = { confusionDistance };
