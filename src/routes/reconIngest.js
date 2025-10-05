// src/routes/reconIngest.js
const express = require('express');
const router = express.Router();

const Car = require('../models/Car');
const { decideCategoryForChecklist } = require('../services/ai/categoryDecider');
const { upsertReconFromChecklist } = require('../services/reconUpsert');

router.post('/ingest-checklist', async (req, res) => {
  const startedAt = new Date();
  try {
    const { carId, text } = req.body || {};
    if (!carId || !text || !String(text).trim()) {
      console.log(`- checklist ingest rejected: missing carId or text`);
      return res.status(400).json({ message: 'carId and text are required' });
    }

    const car = await Car.findById(carId).lean();
    if (!car) {
      console.log(`- checklist ingest error: Car not found for id=${carId}`);
      return res.status(404).json({ message: 'Car not found' });
    }

    const label =
      [car.rego, [car.make, car.model].filter(Boolean).join(' ')].filter(Boolean).join(' — ') ||
      carId;

    // 1) Checklist line
    const trimmed = text.trim();
    console.log(`- checklist item added : ${label} — "${trimmed}"`);

    // 2) AI category decision (with safe fallback)
    let decided = { categoryName: 'Other', service: '' };
    try {
      decided = await decideCategoryForChecklist(trimmed, null);
    } catch (e) {
      console.error(`- AI analysis failed, defaulting to "Other":`, e.message);
    }
    console.log(`- AI analysis of checklist item to determine category: ${decided.categoryName || 'Other'} (service: ${decided.service || '-'})`);

    // 3) Upsert recon (create or append note)
    let result;
    try {
      result = await upsertReconFromChecklist(
        {
          carId,
          categoryName: decided.categoryName,
          noteText: trimmed,
          service: decided.service,
        },
        null
      );
    } catch (e) {
      console.error(`- recon upsert error:`, e.message);
      return res.status(500).json({ message: 'Recon upsert failed', error: e.message });
    }

    if (result?.created) {
      console.log(`- Recon Appointment created: category "${decided.categoryName}" with note "${trimmed}"`);
    } else if (result?.updated) {
      console.log(`- Added item to recon appointment notes: category "${decided.categoryName}" now includes "${trimmed}"`);
    } else {
      console.log(`- No change made (already present) in "${decided.categoryName}"`);
    }

    console.log(`- ingest done in ${Date.now() - startedAt.getTime()}ms`);
    return res.json({
      message: 'Checklist ingested and reconciliation updated',
      decided,
      result: { created: !!result?.created, updated: !!result?.updated, appointmentId: result?.appointment?._id },
    });
  } catch (err) {
    console.error('- checklist ingest error :', err.stack || err.message);
    return res.status(500).json({ message: 'Internal error', error: err.message });
  }
});

module.exports = router;
