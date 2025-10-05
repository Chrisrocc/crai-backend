// src/services/creators/taskCreator.js
const Task = require('../../models/Task');
const { identifyCar } = require('../carIdentifier');
const timeline = require('../logging/timelineLogger');

/**
 * Generic Task (always created).
 * payload: { task, rego, make, model, badge, year, description }
 */
async function createGenericTask(payload, tctx = {}) {
  const {
    task = '',
    rego = '',
    make = '',
    model = '',
    badge = '',
    year = '',
    description = ''
  } = payload;

  let car = null;
  try {
    car = await identifyCar(
      { rego, make, model },
      { description: [task, description].filter(Boolean).join(' '), badge, year },
      tctx
    );
    timeline.identSuccess(tctx, { rego: car.rego, make: car.make, model: car.model });
  } catch (err) {
    timeline.identFail(tctx, {
      reason: err?.message || String(err),
      rego, make, model,
      hints: { badge, year, description }
    });
  }

  const doc = new Task({ task: task || 'Task' });
  if (car && car._id) doc.car = car._id;

  await doc.save();
  await doc.populate('car', 'rego make model');

  timeline.change(tctx, `Task created: ${doc.task}`);
  return { type: 'TASK', task: doc, car: car || null };
}

/**
 * Drop-off as Task (always created).
 * Formats: "Drop off <carText> to <destination> — <note>"
 * payload: { rego, make, model, badge, year, description, destination, note }
 */
async function createDropOffTask(payload, tctx = {}) {
  const {
    rego = '',
    make = '',
    model = '',
    badge = '',
    year = '',
    description = '',
    destination = '',
    note = ''
  } = payload;

  // Build user-facing text even if unidentified
  const carText = [rego, make, model, badge, year].filter(Boolean).join(' ').trim() || 'vehicle';
  const descParts = [`Drop off ${carText}`, destination ? `to ${destination}` : ''].filter(Boolean);
  const baseText = descParts.join(' ');
  const finalText = note ? `${baseText} — ${note}` : baseText;

  let car = null;
  try {
    car = await identifyCar(
      { rego, make, model },
      { description: [description, destination, note].filter(Boolean).join(' '), badge, year },
      tctx
    );
    timeline.identSuccess(tctx, { rego: car.rego, make: car.make, model: car.model });
  } catch (err) {
    timeline.identFail(tctx, {
      reason: err?.message || String(err),
      rego, make, model,
      hints: { badge, year, description, destination, note }
    });
  }

  const doc = new Task({ task: finalText });
  if (car && car._id) doc.car = car._id;

  await doc.save();
  await doc.populate('car', 'rego make model');

  timeline.change(tctx, `Task created: ${doc.task}`);
  return { type: 'DROP_OFF', task: doc, car: car || null };
}

module.exports = {
  createGenericTask,
  createDropOffTask
};
