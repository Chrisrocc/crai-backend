// src/routes/autogateSync.js
const express = require('express');
const router = express.Router();
const Car = require('../models/Car');

const normalizeRego = (s) =>
  typeof s === 'string' ? s.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';

/**
 * Extract regos from an arbitrary pasted text.
 * We target tokens between pipes (| ABC123 |) and also loose tokens,
 * but ignore VINs (17 chars) and obviously wrong lengths.
 */
function extractRegos(raw = '') {
  const text = String(raw || '');

  const set = new Set();

  // 1) pipe-delimited e.g.  " | AUO540 | " or " | 1FA7HM | "
  const pipeRe = /\|\s*([A-Za-z0-9]{2,8})\s*\|/g;
  let m;
  while ((m = pipeRe.exec(text))) {
    const r = normalizeRego(m[1]);
    if (r && r.length >= 2 && r.length <= 8) set.add(r);
  }

  // 2) fallback: scan for short alnum tokens on standalone lines (avoid 17-char VINs)
  const lineTokens = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const line of lineTokens) {
    // skip lines that are clearly VIN (17 chars, letters+digits)
    if (/^[A-Za-z0-9]{17}$/.test(line)) continue;

    // grab short plate-like tokens
    const tokens = line.match(/\b[A-Za-z0-9]{2,8}\b/g) || [];
    for (const t of tokens) {
      const r = normalizeRego(t);
      // heuristic: avoid lines that look like pure amounts/percents e.g. "97", "100"
      if (!r) continue;
      if (/^\d+$/.test(r) && (r.length <= 2 || Number(r) > 99999)) continue; // very small or huge pure numbers = unlikely plates
      if (r.length >= 2 && r.length <= 8) set.add(r);
    }
  }

  return [...set];
}

/**
 * POST /api/cars/mark-online-from-text
 * Body: { text: string }
 * Effect: For any car whose rego appears in the pasted text,
 *         if its current stage is EXACTLY "In Works", change to "Online".
 *         Do NOT change "Sold", "In Works/Online", or anything else.
 */
router.post('/mark-online-from-text', async (req, res) => {
  try {
    const { text = '' } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ message: 'No text provided.' });
    }

    const regos = extractRegos(text);
    if (!regos.length) {
      return res.json({ message: 'No regos found in text.', data: { regos: [], changed: [], skipped: [], notFound: [] } });
    }

    // Find cars by rego
    const cars = await Car.find({ rego: { $in: regos } }).lean();

    const byRego = new Map(cars.map((c) => [String(c.rego).toUpperCase(), c]));
    const changed = [];
    const skipped = [];
    const notFound = [];

    // Prepare bulk ops ONLY for exact "In Works"
    const ops = [];
    for (const r of regos) {
      const car = byRego.get(r);
      if (!car) { notFound.push(r); continue; }

      const stage = String(car.stage || '').trim();
      if (/^in works$/i.test(stage)) {
        ops.push({
          updateOne: {
            filter: { _id: car._id, stage: { $regex: /^in works$/i } },
            update: { $set: { stage: 'Online' } }
          }
        });
        changed.push({ rego: r, from: stage, to: 'Online' });
      } else {
        // explicitly not changing anything else
        skipped.push({ rego: r, stage });
      }
    }

    if (ops.length) await Car.bulkWrite(ops, { ordered: false });

    res.json({
      message: 'Processed pasted list.',
      data: { regos, changed, skipped, notFound, totals: { found: cars.length, changed: changed.length, skipped: skipped.length, notFound: notFound.length } }
    });
  } catch (err) {
    console.error('mark-online-from-text error:', err);
    res.status(400).json({ message: 'Failed to process text', error: err.message });
  }
});

module.exports = router;
