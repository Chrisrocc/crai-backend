const ReconditionerAppointment = require('../../models/ReconditionerAppointment');
const ReconditionerCategory = require('../../models/ReconditionerCategory');
const { identifyCar } = require('../carIdentifier');
const timeline = require('../logging/timelineLogger');

// Build a readable fallback like: "XYZ789 — Toyota Corolla (white, 2015)"
function buildCarText({ rego = '', make = '', model = '', badge = '', description = '', year = '' }) {
  const parts = [];
  const mm = [make, model].filter(Boolean).join(' ');
  if (rego) parts.push(rego);
  if (mm) parts.push(mm + (badge ? ` ${badge}` : ''));
  const tail = [description, year].filter(Boolean).join(', ');
  const left = parts.join(' — ');
  return [left || mm || rego || 'Unidentified vehicle', tail].filter(Boolean).join(' (') + (tail ? ')' : '');
}

// Ensure "Other" category exists (strict fallback)
async function ensureOtherCategory() {
  let other = await ReconditionerCategory.findOne({ name: /^Other$/i });
  if (!other) {
    other = new ReconditionerCategory({ name: 'Other', keywords: [] });
    await other.save();
  }
  return other;
}

// Find existing category by exact name (case-insensitive). Unknown → "Other".
async function resolveCategoryId(categoryName) {
  const name = String(categoryName || '').trim();
  if (!name) return (await ensureOtherCategory())._id;

  const cat = await ReconditionerCategory.findOne({ name: new RegExp(`^${name}$`, 'i') });
  if (cat) return cat._id;

  const other = await ensureOtherCategory();
  return other._id;
}

/**
 * Payload is expected (from the extractor) to include:
 * { rego, make, model, badge, description, year, name, service, category, dateTime, notes }
 * - name: contractor/person (e.g., Rick, Sky Car Trimming)
 * - service: short what-to-do ("seat repair")
 * - category: should be one of the user categories; unknown will fall back to "Other"
 * - dateTime, notes: optional
 *
 * Always creates an appointment:
 * - If car identified → cars: [{ car: <ObjectId>, notes }]
 * - If not → cars: [{ carText: "<fallback>", notes }]
 */
async function createReconditionerAppointment(payload, tctx) {
  const {
    rego = '',
    make = '',
    model = '',
    badge = '',
    description = '',
    year = '',
    name = '',
    service = '',
    category = 'Other',
    dateTime = '',
    notes = '',
  } = payload;

  // Resolve category id (strict; no auto-create beyond "Other")
  const categoryId = await resolveCategoryId(category);

  // Try to identify; if fails we’ll still create using carText
  let linkedCar = null;
  try {
    linkedCar = await identifyCar(
      { rego, make, model },
      { description: [service, notes, description].filter(Boolean).join(' '), badge, year },
      tctx
    );
    timeline.identSuccess(tctx, { rego: linkedCar.rego, make: linkedCar.make, model: linkedCar.model });
  } catch (err) {
    timeline.identFail(tctx, { reason: err.message, rego, make, model });
  }

  const entryNotes = notes || service || '';
  const carEntry = linkedCar
    ? { car: linkedCar._id, notes: entryNotes }
    : { carText: buildCarText({ rego, make, model, badge, description, year }), notes: entryNotes };

  const appointment = new ReconditionerAppointment({
    name: name || 'Reconditioning',
    dateTime: dateTime || '',
    category: categoryId,
    cars: [carEntry],
  });

  await appointment.save();
  await appointment.populate([
    { path: 'category', select: 'name' },
    { path: 'cars.car', select: 'rego make model' },
  ]);

  // Nice timeline line
  const label = linkedCar ? linkedCar.rego : (carEntry.carText || 'unidentified');
  timeline.change(tctx, `Recon appt: ${label} (${appointment.name})`);

  return { type: 'RECON_APPOINTMENT', appointment, car: linkedCar, carText: carEntry.carText || '' };
}

module.exports = { createReconditionerAppointment };
