// routes/customer-appointments.js
const express = require('express');
const router = express.Router();
const CustomerAppointment = require('../models/CustomerAppointment');

/**
 * Build a safe update object from request body.
 * Supports new fields and maps legacy `dayTime` -> `dateTime`.
 */
function buildUpdate(body) {
  const out = {};

  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    out.name = typeof body.name === 'string' ? body.name.trim() : body.name;
  }

  // Prefer explicit dateTime; fall back to legacy dayTime if sent.
  if (Object.prototype.hasOwnProperty.call(body, 'dateTime')) {
    out.dateTime = typeof body.dateTime === 'string' ? body.dateTime.trim() : body.dateTime;
  } else if (Object.prototype.hasOwnProperty.call(body, 'dayTime')) {
    out.dateTime = typeof body.dayTime === 'string' ? body.dayTime.trim() : body.dayTime;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'originalDateTime')) {
    out.originalDateTime =
      typeof body.originalDateTime === 'string'
        ? body.originalDateTime.trim()
        : body.originalDateTime;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'isDelivery')) {
    const v = body.isDelivery;
    out.isDelivery = typeof v === 'string' ? v.toLowerCase() === 'true' : Boolean(v);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'isFollowUp')) {
    const v = body.isFollowUp;
    out.isFollowUp = typeof v === 'string' ? v.toLowerCase() === 'true' : Boolean(v);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
    out.notes = typeof body.notes === 'string' ? body.notes.trim() : body.notes;
  }

  // car link (ObjectId) and carText fallback
  if (Object.prototype.hasOwnProperty.call(body, 'car')) {
    out.car = body.car || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'carText')) {
    out.carText = typeof body.carText === 'string' ? body.carText.trim() : body.carText;
  }

  return out;
}

// GET /api/customer-appointments
router.get('/', async (_req, res) => {
  try {
    const appointments = await CustomerAppointment.find()
      .populate('car', 'rego make model')
      .lean();
    res.json({ message: 'Appointments retrieved successfully', data: appointments });
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving appointments', error: error.message });
  }
});

// POST /api/customer-appointments
router.post('/', async (req, res) => {
  try {
    const payload = buildUpdate(req.body);
    const doc = new CustomerAppointment(payload);
    await doc.save();
    const populated = await doc.populate('car', 'rego make model');
    res.status(201).json({ message: 'Appointment created successfully', data: populated });
  } catch (error) {
    res.status(400).json({ message: 'Error creating appointment', error: error.message });
  }
});

// PUT /api/customer-appointments/:id
router.put('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const update = buildUpdate(req.body);

    const doc = await CustomerAppointment.findById(id);
    if (!doc) return res.status(404).json({ message: 'Appointment not found' });

    const before = {
      name: doc.name ?? '',
      dateTime: doc.dateTime ?? '',
      originalDateTime: doc.originalDateTime ?? '',
      isDelivery: !!doc.isDelivery,
      isFollowUp: !!doc.isFollowUp,
      notes: doc.notes ?? '',
      car: doc.car ? String(doc.car) : '',
      carText: doc.carText ?? '',
    };

    if ('name' in update) doc.name = update.name;
    if ('dateTime' in update) doc.dateTime = update.dateTime;
    if ('originalDateTime' in update) doc.originalDateTime = update.originalDateTime;

    if ('isDelivery' in update) {
      doc.isDelivery = update.isDelivery;
      if (update.isDelivery) doc.isFollowUp = false;
    }

    if ('isFollowUp' in update) {
      doc.isFollowUp = update.isFollowUp;
      if (update.isFollowUp) doc.isDelivery = false;
    }

    if ('notes' in update) doc.notes = update.notes;
    if ('car' in update) doc.car = update.car;
    if ('carText' in update) doc.carText = update.carText;

    const after = {
      name: doc.name ?? '',
      dateTime: doc.dateTime ?? '',
      originalDateTime: doc.originalDateTime ?? '',
      isDelivery: !!doc.isDelivery,
      isFollowUp: !!doc.isFollowUp,
      notes: doc.notes ?? '',
      car: doc.car ? String(doc.car) : '',
      carText: doc.carText ?? '',
    };

    const changed = Object.keys(after).some(
      (k) => String(before[k]) !== String(after[k])
    );

    if (!changed) {
      const unchanged = await doc.populate('car', 'rego make model');
      return res.json({ message: 'No changes detected', data: unchanged });
    }

    await doc.save();
    const populated = await doc.populate('car', 'rego make model');
    res.json({ message: 'Appointment updated successfully', data: populated });
  } catch (error) {
    console.error('Update error:', error);
    res.status(400).json({ message: 'Error updating appointment', error: error.message });
  }
});

// DELETE /api/customer-appointments/:id
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await CustomerAppointment.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Appointment not found' });
    res.json({ message: 'Appointment deleted successfully', data: deleted });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting appointment', error: error.message });
  }
});

module.exports = router;
