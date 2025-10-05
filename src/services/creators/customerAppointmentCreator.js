// src/services/creators/customerAppointmentCreator.js
const CustomerAppointment = require('../../models/CustomerAppointment');
const { identifyCar } = require('../carIdentifier');
const timeline = require('../logging/timelineLogger');

// Build a readable fallback string for the UI when we can't identify a Car document
function buildCarText({ rego = '', make = '', model = '', badge = '', year = '', description = '' }) {
  const parts = [];
  if (make) parts.push(make);
  if (model) parts.push(model);
  if (badge) parts.push(badge);
  if (year) parts.push(String(year));
  if (description) parts.push(description);

  const mm = parts.filter(Boolean).join(' ');
  if (rego && mm) return `${mm} (${rego})`;
  if (mm) return mm || '';
  if (rego) return rego;
  return '[Unidentified vehicle]';
}

async function createCustomerAppointment(payload, tctx) {
  const {
    // appointment info
    name = 'Customer',
    dateTime = '',
    notes = '',
    // vehicle hints
    rego = '',
    make = '',
    model = '',
    badge = '',
    year = '',
    description = '',
  } = payload;

  let car = null;
  try {
    // try strict identification first
    car = await identifyCar(
      { rego, make, model },
      { badge, year, description },
      tctx // audit context
    );
    timeline.identSuccess(tctx, { rego: car.rego, make: car.make, model: car.model });
  } catch (err) {
    // identification failed → fall back to carText string
    timeline.identFail(tctx, { reason: err.message, rego, make, model });
  }

  const doc = new CustomerAppointment({
    name: name || 'Customer',
    dateTime: dateTime || '',
    notes: notes || '',
    car: car ? car._id : null,
    carText: car ? '' : buildCarText({ rego, make, model, badge, year, description }),
  });

  await doc.save();

  const label = car ? car.rego : doc.carText || '[Unidentified vehicle]';
  timeline.change(tctx, `Customer appt: ${label}${doc.dateTime ? ` @ ${doc.dateTime}` : ''}`);

  return { type: 'CUSTOMER_APPOINTMENT', appointment: doc, car };
}

module.exports = { createCustomerAppointment };
