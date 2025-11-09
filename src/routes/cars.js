const express = require('express');
const router = express.Router();
const Car = require('../models/Car');

// AI helpers
const { decideCategoryForChecklist } = require('../services/ai/categoryDecider');
const { upsertReconFromChecklist } = require('../services/reconUpsert');
const { normalizeChecklist } = require('../services/ai/checklistDeduper');
const { getSignedViewUrl } = require('../services/aws/s3'); // ✅ keep photo preview signing

// ---------- helpers ----------
const normalizeRego = (s) =>
  typeof s === 'string' ? s.toUpperCase().replace(/[^A-Z0-9]/g, '') : s;

const toCsvArray = (val) => {
  if (Array.isArray(val)) return [...new Set(val.map((s) => String(s).trim()).filter(Boolean))];
  if (typeof val === 'string') return [...new Set(val.split(',').map((s) => s.trim()).filter(Boolean))];
  return [];
};

const dedupePush = (arr, value) => {
  const v = String(value || '').trim();
  if (!v) return arr;
  if (!Array.isArray(arr)) arr = [];
  if (!arr.includes(v)) arr.push(v);
  return arr;
};

const normalizeList = (arr) =>
  [...new Set((Array.isArray(arr) ? arr : []).map((s) => String(s).trim()).filter(Boolean))];

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

// ---------- DELETE /api/cars/:id ----------
router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await Car.findByIdAndDelete(id);
    if (!doc) return res.status(404).json({ message: 'Car not found' });
    return res.status(204).end();
  } catch (err) {
    console.error('Delete car error:', err);
    return res.status(400).json({ message: 'Error deleting car', error: err.message });
  }
});

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
          : String(body.year || '').trim()
          ? Number(body.year)
          : undefined,
      description: body.description?.trim() || '',
      checklist: normalizeChecklist(toCsvArray(body.checklist || [])),
      location: body.location?.trim() || '',
      nextLocations: [],
      readinessStatus: body.readinessStatus?.trim() || '',
      stage: body.stage?.trim() || 'In Works',
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
      payload.nextLocations = [
        ...new Set(body.nextLocations.map((s) => String(s).trim()).filter(Boolean)),
      ];
    }

    payload.nextLocations = stripCurrentFromNext(payload.nextLocations, payload.location);

    const doc = new Car(payload);
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

    const beforeChecklist = normalizeChecklist(doc.checklist || []);

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
      doc.checklist = normalizeChecklist(toCsvArray(body.checklist));
    }

    if (Array.isArray(body.nextLocations)) {
      doc.nextLocations = [
        ...new Set(body.nextLocations.map((s) => String(s).trim()).filter(Boolean)),
      ];
    } else if (typeof body.nextLocation === 'string' && body.nextLocation.trim()) {
      doc.nextLocations = dedupePush(doc.nextLocations || [], body.nextLocation);
    }

    if (body.readinessStatus !== undefined)
      doc.readinessStatus = String(body.readinessStatus || '').trim();
    if (body.stage !== undefined) doc.stage = String(body.stage || '').trim();
    if (body.notes !== undefined) doc.notes = String(body.notes || '').trim();

    {
      const incomingLoc =
        body.location !== undefined
          ? String(body.location || '').trim()
          : doc.location || '';
      doc.nextLocations = stripCurrentFromNext(doc.nextLocations, incomingLoc);
    }

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

      doc.nextLocations = stripCurrentFromNext(doc.nextLocations, doc.location);
    }

    // 🧩 --- NEW PHOTO ORDER SYNC BLOCK ---
    if (Array.isArray(body.photos)) {
      doc.photos = body.photos.map((p) => ({
        key: p.key,
        caption: p.caption || '',
      }));
      doc.markModified('photos'); // ✅ ensure reordering persists
    }
    // 🧩 -------------------------------

    doc.checklist = normalizeChecklist(doc.checklist || []);
    await doc.save();

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
            let decided = { categoryName: 'Other', service: '' };
            try {
              decided = await decideCategoryForChecklist(trimmed, null);
            } catch (e) {
              console.error(`- AI analysis failed, defaulting to "Other":`, e.message);
            }
            console.log(
              `- AI analysis: ${decided.categoryName || 'Other'} (service: ${
                decided.service || '-'
              })`
            );
            const result = await upsertReconFromChecklist(
              {
                carId: doc._id,
                categoryName: decided.categoryName,
                noteText: trimmed,
                service: decided.service,
              },
              null
            );
            if (result?.created) {
              console.log(
                `- Recon Appointment created [${decided.categoryName}] with note "${trimmed}"`
              );
            } else if (result?.updated) {
              console.log(
                `- Recon notes updated [${decided.categoryName}] add "${trimmed}"`
              );
            } else {
              console.log(
                `- No change (already present) in "${decided.categoryName}"`
              );
            }
          } catch (e) {
            console.error(
              `- checklist ingest error (car ${doc._id}):`,
              e.stack || e.message
            );
          }
        }
      }
    } catch (e) {
      console.error('post-save ingest block failed:', e.stack || e.message);
    }

    res.json({ message: 'Car updated successfully', data: doc.toJSON() });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern && err.keyPattern.rego) {
      return res
        .status(409)
        .json({ message: 'A car with this rego already exists.' });
    }
    console.error('Update car error:', err);
    res
      .status(400)
      .json({ message: 'Error updating car', error: err.message });
  }
});

// ---------- PHOTO PREVIEW ----------
router.get('/:carId/photo-preview', async (req, res) => {
  try {
    const car = await Car.findById(req.params.carId);
    if (!car || !car.photos?.length) return res.json({ data: null });
    const first = car.photos[0];
    const key = first.key || first;
    const signedUrl = await getSignedViewUrl(key, 3600);
    res.json({ data: signedUrl });
  } catch (e) {
    console.error('❌ [PHOTO PREVIEW FAIL]', e);
    res.status(500).json({ message: e.message });
  }
});

// -------------- PUBLIC CONTROLLER: /api/cars/resolve-rego --------------
const audit = require('../services/logging/auditLogger');
async function resolveRegoController(req, res) {
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
      apply = true,
      createIfMissing = false,
    } = req.body || {};

    const makeT = String(make || '').trim();
    const modelT = String(model || '').trim();
    const regoT = normalizeRego(regoOCR || '');

    const actx = audit.newContext({ chatId: req.header('X-Chat-Id') || null });
    audit.write(actx, 'rego.resolve.in', {
      summary: `ocr:${regoT || '-'} ${makeT} ${modelT} ${color} conf:${ocrConfidence} apply:${apply}`,
      body: req.body,
    });

    if (!makeT || !modelT) {
      audit.write(actx, 'rego.resolve.error', { summary: 'make+model missing' });
      return res.status(400).json({ ok: false, error: 'make and model are required' });
    }
    if (!regoT || !/^[A-Z0-9]+$/.test(regoT)) {
      audit.write(actx, 'rego.resolve.error', { summary: 'invalid regoOCR' });
      return res.status(400).json({ ok: false, error: 'regoOCR must be alphanumeric' });
    }

    const candidates = await Car.find({
      make: new RegExp(`^${makeT}$`, 'i'),
      model: new RegExp(`^${modelT}$`, 'i'),
    }).lean();

    audit.write(actx, 'rego.resolve.candidates', {
      summary: `candidates:${candidates.length}`,
      regs: candidates.map((c) => c.rego),
    });

    if (!candidates.length) {
      audit.write(actx, 'rego.resolve.decision', { summary: 'reject: no candidates' });
      return res.json({ ok: true, data: { action: 'reject', best: null } });
    }

    const { weightedEditDistance } = require('../services/matching/regoMatcher');
    const scored = candidates
      .map((c) => ({
        car: c,
        rego: c.rego,
        score: weightedEditDistance(regoT, c.rego),
      }))
      .sort((a, b) => a.score - b.score);

    const best = scored[0];
    const second = scored[1];
    const autoFixThreshold = 0.6;
    const reviewThreshold = 1.2;
    const uniqueMargin = 0.2;

    if (best && best.score === 0) {
      audit.write(actx, 'rego.resolve.decision', { summary: `exact ${best.rego}` });
      return res.json({ ok: true, data: { action: 'exact', best: { rego: best.rego } } });
    }

    if (!best) {
      audit.write(actx, 'rego.resolve.decision', { summary: 'reject: no best' });
      return res.json({ ok: true, data: { action: 'reject', best: null } });
    }

    const secondScore = second ? second.score : Infinity;
    const unique = secondScore - best.score >= uniqueMargin;

    if (best.score <= autoFixThreshold && unique) {
      audit.write(actx, 'rego.resolve.apply', {
        summary: `auto-fix ${best.rego} (from ${regoT})`,
      });
      return res.json({
        ok: true,
        data: {
          action: 'auto-fix',
          best: { rego: best.rego, id: String(best.car._id) },
        },
      });
    }

    if (best.score <= reviewThreshold) {
      audit.write(actx, 'rego.resolve.decision', { summary: `review ${best.rego}` });
      return res.json({
        ok: true,
        data: {
          action: 'review',
          best: { rego: best.rego, id: String(best.car._id) },
        },
      });
    }

    audit.write(actx, 'rego.resolve.decision', { summary: 'reject: over threshold' });
    return res.json({ ok: true, data: { action: 'reject', best: null } });
  } catch (err) {
    console.error('resolve-rego error:', err);
    return res
      .status(500)
      .json({ ok: false, error: err.message || 'resolver-failed' });
  }
}

module.exports = router;
module.exports.resolveRegoController = resolveRegoController;
