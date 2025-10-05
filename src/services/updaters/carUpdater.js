// src/services/updaters/carUpdater.js
const Car = require('../../models/Car');

// ---------- shared helpers ----------
const normalizeRego = (s) =>
  typeof s === 'string' ? s.toUpperCase().replace(/[^A-Z0-9]/g, '') : s;

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
  return Math.max(1, Math.floor(diff / (1000 * 60 * 60 * 24)));
};

const findCarByAction = async (a) => {
  // First by rego
  if (a.rego) {
    const car = await Car.findOne({ rego: normalizeRego(a.rego) });
    if (car) return car;
  }
  // Then by make+model (case-insensitive)
  if (a.make && a.model) {
    const car = await Car.findOne({
      make: new RegExp(`^${a.make}$`, 'i'),
      model: new RegExp(`^${a.model}$`, 'i'),
    });
    if (car) return car;
  }
  // Then by model only (rare fallback)
  if (a.model) {
    const car = await Car.findOne({ model: new RegExp(`^${a.model}$`, 'i') });
    if (car) return car;
  }
  throw new Error('No cars match specified make+model.');
};

// append unique next location
const pushNextLocation = (car, v) => {
  const value = String(v || '').trim();
  if (!value) return;
  if (!Array.isArray(car.nextLocations)) car.nextLocations = [];
  if (!car.nextLocations.includes(value)) car.nextLocations.push(value);
};

// ---------- history-aware location update ----------
const updateLocationWithHistory = (car, newLoc) => {
  const next = String(newLoc || '').trim();
  const prev = car.location || '';

  if (next && next !== prev) {
    // close previous
    if (Array.isArray(car.history) && car.history.length) {
      const last = car.history[car.history.length - 1];
      if (last && !last.endDate) {
        last.endDate = new Date();
        last.days = daysClosed(last.startDate, last.endDate);
      }
    } else {
      car.history = [];
    }
    // open new
    car.history.push({
      location: next,
      startDate: new Date(),
      endDate: null,
      days: 0,
    });
    car.location = next;
  } else if (!prev && next) {
    // initial set
    if (!Array.isArray(car.history)) car.history = [];
    car.history.push({
      location: next,
      startDate: new Date(),
      endDate: null,
      days: 0,
    });
    car.location = next;
  } else if (!next && prev) {
    // clearing location: close open
    if (Array.isArray(car.history) && car.history.length) {
      const last = car.history[car.history.length - 1];
      if (last && !last.endDate) {
        last.endDate = new Date();
        last.days = daysClosed(last.startDate, last.endDate);
      }
    }
    car.location = '';
  }
};

// ---------- exported updaters used by telegram.js ----------
async function applyLocationUpdate(a /*, tctx */) {
  const car = await findCarByAction(a);
  const previousLocation = car.location || '';

  updateLocationWithHistory(car, a.location || '');
  await car.save();

  return { changed: previousLocation !== car.location, car, previousLocation };
}

async function applySold(a /*, tctx */) {
  const car = await findCarByAction(a);
  const was = car.stage || '';
  car.stage = 'Sold';
  await car.save();
  return { changed: was !== 'Sold', car };
}

async function addChecklistItem(a /*, tctx */) {
  const car = await findCarByAction(a);
  const item = (a.checklistItem || '').trim();
  if (!item) throw new Error('Checklist item is empty');

  if (!Array.isArray(car.checklist)) car.checklist = [];
  if (!car.checklist.includes(item)) car.checklist.push(item);
  await car.save();

  return { car, item };
}

async function setReadinessStatus(a /*, tctx */) {
  const car = await findCarByAction(a);
  const prev = car.readinessStatus || '';
  const next = (a.readiness || '').trim() || 'Ready';
  car.readinessStatus = next;
  await car.save();
  return { car, readiness: next, previous: prev };
}

async function setNextLocation(a /*, tctx */) {
  const car = await findCarByAction(a);
  const nl = (a.nextLocation || '').trim();
  if (nl) pushNextLocation(car, nl);
  await car.save();
  return { car, nextLocation: nl };
}

module.exports = {
  applyLocationUpdate,
  applySold,
  addChecklistItem,
  setReadinessStatus,
  setNextLocation,
};
