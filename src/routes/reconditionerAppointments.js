// src/routes/reconditionerAppointments.js
const express = require('express');
const router = express.Router();

const ReconditionerAppointment = require('../models/ReconditionerAppointment');
const Car = require('../models/Car'); // for checklist sync

/* -----------------------------------------------------------------------------
   Helpers
----------------------------------------------------------------------------- */

/**
 * Build a safe update object.
 * Accepts:
 * - name?: string
 * - dateTime?: string
 * - cars?: Array<{ car?: string, carText?: string, notes?: string }>
 * - category?: string (ObjectId)
 */
function buildUpdate(body) {
  const out = {};

  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    out.name = typeof body.name === 'string' ? body.name.trim() : body.name;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'dateTime')) {
    out.dateTime = typeof body.dateTime === 'string' ? body.dateTime.trim() : body.dateTime;
  }

  if (Array.isArray(body.cars)) {
    out.cars = body.cars
      .filter((x) => x && (x.car || x.carText)) // must have either car ObjectId or a carText fallback
      .map((x) => ({
        car: x.car || null,
        carText: typeof x.carText === 'string' ? x.carText.trim() : (x.carText || ''),
        notes: typeof x.notes === 'string' ? x.notes : (x.notes ?? ''),
      }));
  }

  if (Object.prototype.hasOwnProperty.call(body, 'category')) {
    out.category = body.category; // trust UI to send a valid id
  }

  return out;
}

// --- checklist sync helpers

const escapeReg = (s = '') => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const makeEntry = (categoryName, notes) => {
  const n = String(notes || '').trim();
  return n ? `${categoryName}: ${n}` : `${categoryName}`;
};

/**
 * Add "<Category>: <notes>" to each identified car's checklist (no duplicates).
 * Ignores text-only entries (no car id).
 */
async function addChecklistFromAppointment(populatedDoc) {
  const categoryName = populatedDoc?.category?.name || '';
  if (!categoryName) return;

  const ops = [];
  for (const row of (populatedDoc.cars || [])) {
    if (!row?.car) continue; // only identified cars
    const entry = makeEntry(categoryName, row?.notes);
    ops.push({
      updateOne: {
        filter: { _id: row.car },
        update: { $addToSet: { checklist: entry } },
      }
    });
  }

  if (ops.length) await Car.bulkWrite(ops, { ordered: false });
}

/**
 * Remove any checklist items that begin with the category name
 * for the cars that belonged to this appointment.
 */
async function removeChecklistForDeletedAppt(populatedDoc) {
  const categoryName = populatedDoc?.category?.name || '';
  if (!categoryName) return;

  const carIds = (populatedDoc.cars || []).map((r) => r?.car).filter(Boolean);
  if (!carIds.length) return;

  await Car.updateMany(
    { _id: { $in: carIds } },
    { $pull: { checklist: { $regex: `^${escapeReg(categoryName)}\\b`, $options: 'i' } } }
  );
}

/* -----------------------------------------------------------------------------
   Routes
----------------------------------------------------------------------------- */

// GET all recon appointments (populated)
router.get('/', async (_req, res) => {
  try {
    const appointments = await ReconditionerAppointment.find()
      .populate('category', 'name')
      .populate('cars.car', 'rego make model')
      .lean();

    res.json({ message: 'Appointments retrieved successfully', data: appointments });
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving appointments', error: error.message });
  }
});

// POST create recon appointment
router.post('/', async (req, res) => {
  try {
    const doc = new ReconditionerAppointment(req.body);
    await doc.save();

    await doc.populate([
      { path: 'category', select: 'name' },
      { path: 'cars.car', select: 'rego make model' },
    ]);

    // sync checklist: add "<Category>: <notes>" for each identified car
    await addChecklistFromAppointment(doc);

    res.status(201).json({ message: 'Appointment created successfully', data: doc });
  } catch (error) {
    res.status(400).json({ message: 'Error creating appointment', error: error.message });
  }
});

// PUT update recon appointment
router.put('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const allowed = buildUpdate(req.body);

    const doc = await ReconditionerAppointment.findById(id);
    if (!doc) return res.status(404).json({ message: 'Appointment not found' });

    if (Object.prototype.hasOwnProperty.call(allowed, 'name')) doc.name = allowed.name;
    if (Object.prototype.hasOwnProperty.call(allowed, 'dateTime')) doc.dateTime = allowed.dateTime;
    if (Object.prototype.hasOwnProperty.call(allowed, 'cars')) doc.cars = allowed.cars;
    if (Object.prototype.hasOwnProperty.call(allowed, 'category')) doc.category = allowed.category;

    await doc.save();

    await doc.populate([
      { path: 'category', select: 'name' },
      { path: 'cars.car', select: 'rego make model' },
    ]);

    // Strategy: simply add any relevant entries (duplicates are prevented)
    // If you want "replace", call removeChecklistForDeletedAppt(doc) first.
    await addChecklistFromAppointment(doc);

    res.json({ message: 'Appointment updated successfully', data: doc });
  } catch (error) {
    console.error('Update error:', error);
    res.status(400).json({ message: 'Error updating appointment', error: error.message });
  }
});

// DELETE recon appointment
router.delete('/:id', async (req, res) => {
  try {
    // get populated copy first (to know which cars/category to clean up)
    const toDelete = await ReconditionerAppointment.findById(req.params.id)
      .populate('category', 'name')
      .populate('cars.car', '_id')
      .lean();

    if (!toDelete) return res.status(404).json({ message: 'Appointment not found' });

    await ReconditionerAppointment.findByIdAndDelete(req.params.id);

    // remove any "<Category ...>" lines for those cars
    await removeChecklistForDeletedAppt(toDelete);

    res.json({ message: 'Appointment deleted successfully', data: toDelete });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting appointment', error: error.message });
  }
});

module.exports = router;
