// src/routes/carImport.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const Car = require('../models/Car');

// ---------- utils ----------
const normalizeRego = (s) =>
  typeof s === 'string' ? s.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';

const clean = (s) => (s == null ? '' : String(s).trim());

const toYear = (v) => {
  const t = clean(v);
  if (!t) return undefined;
  const n = Number(t.replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 1900 ? n : undefined;
};

const uniqueCsv = (v) => {
  if (Array.isArray(v)) return [...new Set(v.map(clean).filter(Boolean))];
  return [...new Set(clean(v).split(',').map(clean).filter(Boolean))];
};

// map common column names → canonical keys
const findCol = (headerRow, candidates) => {
  const idx = headerRow.findIndex((h) =>
    candidates.some((cand) => h.toLowerCase().includes(cand))
  );
  return idx >= 0 ? idx : -1;
};

// Multer: in-memory
const upload = multer({ storage: multer.memoryStorage() });

// ---------- POST /api/cars/import-csv ----------
router.post('/import-csv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ message: 'No CSV file uploaded' });
    }

    // parse CSV
    const text = req.file.buffer.toString('utf8');
    const records = parse(text, {
      bom: true,
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true,
    });

    if (!records.length) {
      return res.status(400).json({ message: 'CSV seems empty' });
    }

    const header = records[0].map((h) => String(h || '').trim());
    const rows = records.slice(1);

    // try to locate cols (support many vendor variants)
    const col = {
      rego: findCol(header, ['rego', 'plate', 'registration', 'vin/rego', 'licence']),
      vin: findCol(header, ['vin']),
      make: findCol(header, ['make', 'manufacturer']),
      model: findCol(header, ['model']),
      badge: findCol(header, ['badge', 'variant', 'trim']),
      series: findCol(header, ['series']),
      year: findCol(header, ['year', 'yr', 'build', 'compliance']),
      colour: findCol(header, ['colour', 'color', 'exterior']),
      description: findCol(header, ['desc', 'description']),
      notes: findCol(header, ['notes', 'note', 'comment']),
      checklist: findCol(header, ['checklist', 'todo', 'to do']),
      // intentionally no "stage" mapping here — we’re forcing In Works for new cars
    };

    const results = {
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [],
      detail: [],
    };

    // build a fast lookup for existing cars by rego
    const existing = await Car.find({}, { _id: 1, rego: 1, stage: 1 }).lean();
    const byRego = new Map(existing.map((c) => [String(c.rego).toUpperCase(), c]));

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];

      const regoRaw = col.rego >= 0 ? r[col.rego] : '';
      const rego = normalizeRego(regoRaw);

      if (!rego) {
        results.skipped++;
        results.detail.push({ row: i + 2, action: 'skipped', reason: 'Missing rego' });
        continue;
      }

      // map basic fields
      const make = col.make >= 0 ? clean(r[col.make]) : '';
      const model = col.model >= 0 ? clean(r[col.model]) : '';
      const badge = col.badge >= 0 ? clean(r[col.badge]) : '';
      const series = col.series >= 0 ? clean(r[col.series]) : '';
      const year = col.year >= 0 ? toYear(r[col.year]) : undefined;

      // Description: prefer explicit description; else fall back to colour
      const colour = col.colour >= 0 ? clean(r[col.colour]) : '';
      const description =
        (col.description >= 0 ? clean(r[col.description]) : '') || colour;

      const notes = col.notes >= 0 ? clean(r[col.notes]) : '';
      const checklist = col.checklist >= 0 ? uniqueCsv(r[col.checklist]) : [];

      const found = byRego.get(rego);

      try {
        if (!found) {
          // NEW: create with stage hard-coded to In Works
          const doc = new Car({
            rego,
            make,
            model,
            badge,
            series,
            year,
            description,
            checklist,
            location: '',         // no location on import
            nextLocations: [],
            readinessStatus: '',
            stage: 'In Works',    // ⬅️ the important bit
            notes,
            history: [],
          });

          await doc.save();
          byRego.set(rego, { _id: doc._id, rego: doc.rego, stage: doc.stage });
          results.created++;
          results.detail.push({ row: i + 2, action: 'created', rego: doc.rego });
        } else {
          // UPDATE: patch missing/basic fields ONLY; DO NOT change stage
          const doc = await Car.findById(found._id);
          if (!doc) {
            results.skipped++;
            results.detail.push({ row: i + 2, action: 'skipped', rego, reason: 'Lookup failed' });
            continue;
          }

          // only set if provided and not identical
          const setIf = (key, val) => {
            if (val === undefined || val === null || val === '') return;
            if (doc[key] !== val) doc[key] = val;
          };

          setIf('make', make);
          setIf('model', model);
          setIf('badge', badge);
          setIf('series', series);
          if (year !== undefined && year !== doc.year) doc.year = year;
          setIf('description', description);
          if (Array.isArray(checklist) && checklist.length) {
            const merged = Array.from(new Set([...(doc.checklist || []), ...checklist].map(clean).filter(Boolean)));
            doc.checklist = merged;
          }
          // stage: intentionally NOT touched here
          setIf('notes', doc.notes ? `${doc.notes} ${notes}`.trim() : notes);

          await doc.save();
          results.updated++;
          results.detail.push({ row: i + 2, action: 'updated', rego: doc.rego });
        }
      } catch (e) {
        results.errors.push({ row: i + 2, rego, error: e.message });
      }
    }

    res.json({
      message: 'CSV processed',
      data: results,
    });
  } catch (err) {
    console.error('import-csv error:', err);
    res.status(400).json({ message: 'CSV import failed', error: err.message });
  }
});

module.exports = router;
