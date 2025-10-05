// src/services/reconUpsert.js
const audit = require('./logging/auditLogger');
const timeline = require('./logging/timelineLogger');

const ReconditionerAppointment = require('../models/ReconditionerAppointment');
const ReconditionerCategory = require('../models/ReconditionerCategory');

/**
 * Ensure a category exists and return its _id
 */
async function resolveCategoryIdByName(name) {
  const nm = String(name || 'Other').trim();
  let cat = await ReconditionerCategory.findOne({ name: new RegExp(`^${nm}$`, 'i') });
  if (!cat) {
    cat = new ReconditionerCategory({ name: nm, keywords: [] });
    await cat.save();
  }
  return cat._id;
}

/**
 * Upsert logic (UPDATED):
 * - exactly ONE appointment per (category, car)
 * - if appointment exists, append text to that car's notes (dedupe)
 * - if not, ALWAYS create a brand new appointment (do NOT reuse another appointment for the category)
 */
async function upsertReconFromChecklist({ carId, categoryName, noteText, service }, ctx) {
  const catId = await resolveCategoryIdByName(categoryName);

  audit.write(ctx, 'recon.upsert.begin', {
    summary: `Upsert recon for car:${carId} category:${categoryName}`,
    service,
    noteText,
    catId: String(catId),
  });

  // find existing appointment in that category that already contains this car
  const existing = await ReconditionerAppointment.findOne({
    category: catId,
    'cars.car': carId,
  });

  if (existing) {
    // merge notes for that car entry
    const entry = existing.cars.find(c => String(c.car) === String(carId));
    const before = entry?.notes || '';
    const incoming = String(noteText || '').trim();

    // simple dedupe: don't add if note already contains incoming substring (case-insensitive)
    const contains = before.toLowerCase().includes(incoming.toLowerCase());
    const nextNotes = contains ? before : (before ? `${before}, ${incoming}` : incoming || service || '');

    entry.notes = nextNotes;

    audit.write(ctx, 'recon.upsert.update', {
      summary: 'Appending to existing appointment notes',
      appointmentId: String(existing._id),
      before,
      incoming,
      nextNotes,
    });
    await existing.save();

    timeline.change(ctx, `Recon notes updated for car ${carId} in "${categoryName}"`);
    return { created: false, updated: true, appointment: existing.toObject() };
  }

  // NO appointment with this car in this category → ALWAYS create NEW appointment
  const incoming = String(noteText || '').trim();
  const doc = new ReconditionerAppointment({
    name: categoryName || 'Reconditioning',
    dateTime: '',
    category: catId,
    cars: [{ car: carId, notes: incoming || service || '' }],
  });
  await doc.save();

  audit.write(ctx, 'recon.upsert.create', {
    summary: 'Created new appointment (per-car)',
    appointmentId: String(doc._id),
    categoryName,
    carId: String(carId),
  });

  timeline.change(ctx, `Recon appointment created for "${categoryName}" (car ${carId})`);
  return { created: true, updated: false, appointment: doc.toObject() };
}

module.exports = { upsertReconFromChecklist };
