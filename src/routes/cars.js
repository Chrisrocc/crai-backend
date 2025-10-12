const express = require('express');
const router = express.Router();
const Car = require('../models/Car');

// AI helpers
const { decideCategoryForChecklist } = require('../services/ai/categoryDecider');
const { upsertReconFromChecklist } = require('../services/reconUpsert');
const { normalizeChecklist } = require('../services/ai/checklistDeduper');

// ---------- helpers ----------
const normalizeRego = (s) =>
  typeof s === 'string' ? s.toUpperCase().replace(/[^A-Z0-9]/g, '') : s;

const toCsvArray = (val) => {
  if (Array.isArray(val)) {
    return [...new Set(val.map((s) => String(s).trim()).filter(Boolean))];
  }
  if (typeof val === 'string') {
    return [...new Set(val.split(',').map((s) => s.trim()).filter(Boolean))];
  }
  return [];
};

const dedupePush = (arr, value) => {
  const v = String(value || '').trim();
  if (!v) return arr;
  if (!Array.isArray(arr)) arr = [];
  if (!arr.includes(v)) arr.push(v);
  return arr;
};

// canonicalize lists and strip the current location from next locations
const normalizeList = (arr) =>
  [...new Set((Array.isArray(arr) ? arr : [])
    .map((s) => String(s).trim())
    .filter(Boolean))];

const stripCurrentFromNext = (nextArr, currentLoc) => {
  const next = normalizeList(nextArr);
  const curr = String(currentLoc || '').trim();
  if (!curr) return next;
  const currLC = curr.toLowerCase();
  return next.filter((n) => n.toLowerCase() !== currLC);
};

const msPerDay = 1000 * 60 * 60 * 24;
const dateOnly = (d) => {
  const dt = new Date(d || Date.now());
  dt.setHours(0, 0, 0, 0);
  return dt;
};
const daysClosed = (start, end) => {
  const s = dateOnly(start).getTime();
  const e = dateOnly(end).getTime();
  const diff = Math.max(0, e - s);
  return Math.max(1, Math.floor(diff / msPerDay));
};

// ------- fuzzy helpers for OCR resolve -------
const lookAlikeMap = new Map(Object.entries({
  '0':'O','O':'0',
  '1':'I','I':'1','L':'1',
  '2':'Z','Z':'2',
  '5':'S','S':'5',
  '6':'G','G':'6',
  '8':'B','B':'8',
  '4':'A','A':'4',
  'V':'U','U':'V',
  'C':'G','G':'C',
  'K':'X','X':'K',
}));

function charConf(a, b) {
  if (a === b) return 1.0;
  return lookAlikeMap.get(a) === b ? 0.5 : 0.0;
}

function levenshtein(a = '', b = '') {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function perCharConfidence(ocr, cand) {
  const A = (ocr || '').toUpperCase();
  const B = (cand || '').toUpperCase();
  const len = Math.max(A.length, B.length);
  if (!len) return 0;
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const ca = A[i] || '';
    const cb = B[i] || '';
    if (!ca || !cb) continue;
    sum += charConf(ca, cb);
  }
  return sum / len;
}

// compute which checklist items are newly added (after normalization)
function diffNewChecklistItems(oldList, newList) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const oldSet = new Set((Array.isArray(oldList) ? oldList : []).map(norm).filter(Boolean));
  const added = [];
  for (const x of (Array.isArray(newList) ? newList : [])) {
    const t = String(x || '').trim();
    if (t && !oldSet.has(norm(t))) added.push(t);
  }
  return added;
}

// ---------- GET /api/cars ----------
router.get('/', async (_req, res) => {
  try {
    const cars = await Car.find().lean();
    res.json({ message: 'Cars retrieved successfully', data: cars });
  } catch (err) {
    res.status(500).json({ message: 'Error retrieving cars', error: err.message });
  }
});

// ---------- POST /api/cars ----------
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};

    const payload = {
      rego: normalizeRego(body.rego),
      make: body.make?.trim() || '',
      model: body.model?.trim() || '',
      badge: body.badge?.trim() || '',
      series: body.series?.trim() || '',
      year:
        typeof body.year === 'number'
          ? body.year
          : (String(body.year || '').trim() ? Number(body.year) : undefined),
      description: body.description?.trim() || '',
      checklist: normalizeChecklist(toCsvArray(body.checklist || [])), // ⬅ normalize+dedupe NOW
      location: body.location?.trim() || '',
      nextLocations: [],
      readinessStatus: body.readinessStatus?.trim() || '',
      stage: (body.stage?.trim() || 'In Works'),
      notes: body.notes?.trim() || '',
      history: [],
    };

    if (payload.location) {
      payload.history.push({
        location: payload.location,
        startDate: new Date(),
        endDate: null,
        days: 0,
      });
    }

    if (typeof body.nextLocation === 'string' && body.nextLocation.trim()) {
      payload.nextLocations = dedupePush(payload.nextLocations || [], body.nextLocation);
    } else if (Array.isArray(body.nextLocations)) {
      payload.nextLocations = [...new Set(body.nextLocations.map((s) => String(s).trim()).filter(Boolean))];
    }

    // ensure current location isn’t in nextLocations
    payload.nextLocations = stripCurrentFromNext(payload.nextLocations, payload.location);

    const doc = new Car(payload);
    // Final guard: keep checklist normalized
    doc.checklist = normalizeChecklist(doc.checklist);
    await doc.save();

    res.status(201).json({ message: 'Car created successfully', data: doc.toJSON() });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern && err.keyPattern.rego) {
      return res.status(409).json({ message: 'A car with this rego already exists.' });
    }
    res.status(400).json({ message: 'Error creating car', error: err.message });
  }
});

// ---------- PUT /api/cars/:id ----------
router.put('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const body = req.body || {};
    const doc = await Car.findById(id);
    if (!doc) return res.status(404).json({ message: 'Car not found' });

    // snapshot (normalized) before
    const beforeChecklist = normalizeChecklist(doc.checklist || []);

    // Scalars
    if (body.rego !== undefined) doc.rego = normalizeRego(body.rego || '');
    if (body.make !== undefined) doc.make = String(body.make || '').trim();
    if (body.model !== undefined) doc.model = String(body.model || '').trim();
    if (body.badge !== undefined) doc.badge = String(body.badge || '').trim();
    if (body.series !== undefined) doc.series = String(body.series || '').trim();

    if (body.year !== undefined) {
      const y = String(body.year).trim();
      doc.year = y ? Number(y) : undefined;
    }

    if (body.description !== undefined) doc.description = String(body.description || '').trim();

    if (body.checklist !== undefined) {
      // accept CSV or array → normalize into our strict "Inspect X - Y" + de-dupe
      doc.checklist = normalizeChecklist(toCsvArray(body.checklist));
    }

    // nextLocations
    if (Array.isArray(body.nextLocations)) {
      doc.nextLocations = [...new Set(body.nextLocations.map((s) => String(s).trim()).filter(Boolean))];
    } else if (typeof body.nextLocation === 'string' && body.nextLocation.trim()) {
      doc.nextLocations = dedupePush(doc.nextLocations || [], body.nextLocation);
    }

    if (body.readinessStatus !== undefined) doc.readinessStatus = String(body.readinessStatus || '').trim();
    if (body.stage !== undefined) doc.stage = String(body.stage || '').trim();
    if (body.notes !== undefined) doc.notes = String(body.notes || '').trim();

    // strip current from next (use incoming location if present)
    {
      const incomingLoc =
        body.location !== undefined ? String(body.location || '').trim() : (doc.location || '');
      doc.nextLocations = stripCurrentFromNext(doc.nextLocations, incomingLoc);
    }

    // Location + History logic
    if (body.location !== undefined) {
      const newLoc = String(body.location || '').trim();
      const prevLoc = doc.location || '';

      if (newLoc && newLoc !== prevLoc) {
        if (Array.isArray(doc.history) && doc.history.length) {
          const last = doc.history[doc.history.length - 1];
          if (last && !last.endDate) {
            last.endDate = new Date();
            last.days = daysClosed(last.startDate, last.endDate);
          }
        } else {
          doc.history = [];
        }

        doc.history.push({
          location: newLoc,
          startDate: new Date(),
          endDate: null,
          days: 0,
        });

        doc.location = newLoc;
      } else if (!prevLoc && newLoc) {
        if (!Array.isArray(doc.history)) doc.history = [];
        doc.history.push({
          location: newLoc,
          startDate: new Date(),
          endDate: null,
          days: 0,
        });
        doc.location = newLoc;
      } else if (!newLoc && prevLoc) {
        if (Array.isArray(doc.history) && doc.history.length) {
          const last = doc.history[doc.history.length - 1];
          if (last && !last.endDate) {
            last.endDate = new Date();
            last.days = daysClosed(last.startDate, last.endDate);
          }
        }
        doc.location = '';
      }

      // guarantee current location is not present in nextLocations
      doc.nextLocations = stripCurrentFromNext(doc.nextLocations, doc.location);
    }

    // Final guard before save: normalize current checklist (even if not in body)
    doc.checklist = normalizeChecklist(doc.checklist || []);

    await doc.save();

    // ingest newly-added normalized items → recon
    try {
      const afterChecklist = normalizeChecklist(doc.checklist || []);
      const newlyAdded = diffNewChecklistItems(beforeChecklist, afterChecklist);

      if (newlyAdded.length) {
        const label =
          [doc.rego, [doc.make, doc.model].filter(Boolean).join(' ')].filter(Boolean).join(' — ') ||
          String(doc._id);

        for (const itemText of newlyAdded) {
          const trimmed = String(itemText || '').trim();
          try {
            console.log(`- checklist item added : ${label} — "${trimmed}"`);

            // AI category decision (with safe fallback)
            let decided = { categoryName: 'Other', service: '' };
            try {
              decided = await decideCategoryForChecklist(trimmed, null);
            } catch (e) {
              console.error(`- AI analysis failed, defaulting to "Other":`, e.message);
            }
            console.log(`- AI analysis: ${decided.categoryName || 'Other'} (service: ${decided.service || '-'})`);

            // Upsert recon (create or append)
            const result = await upsertReconFromChecklist(
              { carId: doc._id, categoryName: decided.categoryName, noteText: trimmed, service: decided.service },
              null
            );

            if (result?.created) {
              console.log(`- Recon Appointment created [${decided.categoryName}] with note "${trimmed}"`);
            } else if (result?.updated) {
              console.log(`- Recon notes updated [${decided.categoryName}] add "${trimmed}"`);
            } else {
              console.log(`- No change (already present) in "${decided.categoryName}"`);
            }
          } catch (e) {
            console.error(`- checklist ingest error (car ${doc._id}):`, e.stack || e.message);
          }
        }
      }
    } catch (e) {
      console.error('post-save ingest block failed:', e.stack || e.message);
    }

    res.json({ message: 'Car updated successfully', data: doc.toJSON() });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern && err.keyPattern.rego) {
      return res.status(409).json({ message: 'A car with this rego already exists.' });
    }
    console.error('Update car error:', err);
    res.status(400).json({ message: 'Error updating car', error: err.message });
  }
});

// ---------- DELETE /api/cars/:id ----------
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Car.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Car not found' });
    res.json({ message: 'Car deleted successfully', data: deleted.toJSON() });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting car', error: err.message });
  }
});

// ---------- POST /api/cars/resolve-rego ----------
router.post('/resolve-rego', async (req, res) => {
  try {
    const {
      regoOCR = '',
      make = '',
      model = '',
      color = '',
      badge = '',
      year = '',
      description = '',
      ocrConfidence = 0.9,
      apply = false,
      createIfMissing = true,
    } = req.body || {};

    const makeT = String(make || '').trim();
    const modelT = String(model || '').trim();
    const regoT = normalizeRego(regoOCR || '');

    if (!makeT || !modelT) {
      return res.status(400).json({ message: 'make and model are required' });
    }
    if (!regoT || !/^[A-Z0-9]+$/.test(regoT)) {
      return res.status(400).json({ message: 'regoOCR must contain letters/numbers only' });
    }

    const candidates = await Car.find({
      make: new RegExp(`^${makeT}$`, 'i'),
      model: new RegExp(`^${modelT}$`, 'i'),
    });

    if (!candidates.length) {
      if (!createIfMissing) {
        return res.json({ message: 'No candidates', data: { action: 'reject', best: null } });
      }
      const existing = await Car.findOne({ rego: new RegExp(`^${regoT}$`, 'i') });
      if (existing) {
        return res.json({ message: 'Rego already exists', data: { action: 'exact', best: { rego: existing.rego }, car: existing.toJSON() } });
      }

      const desc = [description, color].filter(Boolean).join(' ').trim();
      const doc = new Car({
        rego: regoT,
        make: makeT,
        model: modelT,
        badge: String(badge || '').trim(),
        year: String(year || '').trim() ? Number(year) : undefined,
        description: desc,
        stage: 'In Works',
        checklist: [],
        location: '',
        nextLocations: [],
        history: [],
      });
      await doc.save();

      return res.status(201).json({
        message: 'No match; created new car',
        data: { action: 'created', best: null, car: doc.toJSON() },
      });
    }

    const scored = candidates.map((c) => {
      const lev = levenshtein(regoT, (c.rego || '').toUpperCase());
      const conf = perCharConfidence(regoT, c.rego || '');
      const total = lev - conf * Math.max(1, regoT.length) - ocrConfidence * 0.2;
      return { car: c, lev, conf, total };
    }).sort((a, b) => a.total - b.total);

    const best = scored[0];
    const second = scored[1];

    if (best && best.lev === 0) {
      return res.json({
        message: 'Exact rego',
        data: { action: 'exact', best: { rego: best.car.rego }, scored: scored.slice(0, 3).map(s => ({ rego: s.car.rego, lev: s.lev, conf: s.conf, total: s.total })) },
      });
    }

    const AUTO_FIX_TOTAL = 1.2;
    const REVIEW_TOTAL = 2.0;
    const margin = second ? (second.total - best.total) : 99;

    if (best && best.total <= AUTO_FIX_TOTAL && margin >= 0.8) {
      if (apply) {
        return res.json({
          message: 'Auto-fix match',
          data: { action: 'auto-fix', best: { rego: best.car.rego, id: String(best.car._id) } },
        });
      }
      return res.json({
        message: 'Would auto-fix',
        data: { action: 'review', best: { rego: best.car.rego, id: String(best.car._id) } },
      });
    }

    if (best && best.total <= REVIEW_TOTAL) {
      return res.json({
        message: 'Needs review',
        data: {
          action: 'review',
          best: { rego: best.car.rego, id: String(best.car._id) },
          scored: scored.slice(0, 3).map(s => ({ rego: s.car.rego, lev: s.lev, conf: s.conf, total: s.total })),
        },
      });
    }

    if (createIfMissing) {
      const existing = await Car.findOne({ rego: new RegExp(`^${regoT}$`, 'i') });
      if (existing) {
        return res.json({ message: 'Rego exists elsewhere', data: { action: 'exact', best: { rego: existing.rego }, car: existing.toJSON() } });
      }

      const desc = [description, color].filter(Boolean).join(' ').trim();
      const doc = new Car({
        rego: regoT,
        make: makeT,
        model: modelT,
        badge: String(badge || '').trim(),
        year: String(year || '').trim() ? Number(year) : undefined,
        description: desc,
        stage: 'In Works',
        checklist: [],
        location: '',
        nextLocations: [],
        history: [],
      });
      await doc.save();

      return res.status(201).json({
        message: 'Rejected match; created new car',
        data: { action: 'created', best: null, car: doc.toJSON() },
      });
    }

    return res.json({ message: 'No confident match', data: { action: 'reject', best: null } });
  } catch (err) {
    console.error('resolve-rego error:', err);
    res.status(400).json({ message: 'resolve-rego failed', error: err.message });
  }
});

module.exports = router;
