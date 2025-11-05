const Car = require('../../models/Car');

// ---------- shared helpers ----------
const normalize = (s) => String(s || '').trim();
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
  return Math.max(1, Math.floor(diff / msPerDay));
};

// ✅ Loosened: create minimal car if rego + (make OR model)
// ❗️IMPORTANT: Do NOT copy LLM `description` here — it often contains tasks/locations.
// Leave description empty at creation; enrich later (UI or vision enrichment).
async function maybeCreateMinimalCarFromAction(a) {
  const rego = normalizeRego(a.rego || '');
  const make = normalize(a.make || '');
  const model = normalize(a.model || '');

  if (!rego) return null;
  if (!make && !model) return null;

  // If another car already has this rego (case-insensitive), return that instead
  const existingByRego = await Car.findOne({ rego: new RegExp(`^${rego}$`, 'i') });
  if (existingByRego) return existingByRego;

  const doc = new Car({
    rego,
    make,
    model,
    badge: normalize(a.badge || ''),
    series: '',
    year: String(a.year || '').trim() ? Number(a.year) : undefined,
    // ⬇️ key change: never seed description from action payload
    description: '',
    checklist: [],
    location: '',
    nextLocations: [],
    history: [],
    readinessStatus: '',
    stage: 'In Works',
    notes: '',
  });

  try {
    await doc.save();
    console.log(`✅ Created minimal car: ${rego} (${make} ${model})`);
    return doc;
  } catch (e) {
    if (e && e.code === 11000) {
      const fallback = await Car.findOne({ rego: new RegExp(`^${rego}$`, 'i') });
      if (fallback) return fallback;
    }
    throw e;
  }
}

async function findCarByAction(a) {
  if (a.rego) {
    const byRego = await Car.findOne({ rego: normalizeRego(a.rego) });
    if (byRego) return byRego;
  }
  if (a.make && a.model) {
    const byBoth = await Car.findOne({
      make: new RegExp(`^${a.make}$`, 'i'),
      model: new RegExp(`^${a.model}$`, 'i'),
    });
    if (byBoth) return byBoth;
  }
  if (a.model) {
    const byModel = await Car.findOne({ model: new RegExp(`^${a.model}$`, 'i') });
    if (byModel) return byModel;
  }
  return null;
}

async function ensureCarForAction(a) {
  const found = await findCarByAction(a);
  if (found) return found;

  const created = await maybeCreateMinimalCarFromAction(a);
  if (created) return created;

  throw new Error('No cars match specified make+model.');
}

const pushNextLocation = (car, v) => {
  const value = String(v || '').trim();
  if (!value) return;
  if (!Array.isArray(car.nextLocations)) car.nextLocations = [];
  if (!car.nextLocations.includes(value)) car.nextLocations.push(value);
};

const updateLocationWithHistory = (car, newLoc) => {
  const next = String(newLoc || '').trim();
  const prev = car.location || '';

  if (next && next !== prev) {
    if (Array.isArray(car.history) && car.history.length) {
      const last = car.history[car.history.length - 1];
      if (last && !last.endDate) {
        last.endDate = new Date();
        last.days = daysClosed(last.startDate, last.endDate);
      }
    } else car.history = [];

    car.history.push({ location: next, startDate: new Date(), endDate: null, days: 0 });
    car.location = next;
  } else if (!prev && next) {
    if (!Array.isArray(car.history)) car.history = [];
    car.history.push({ location: next, startDate: new Date(), endDate: null, days: 0 });
    car.location = next;
  } else if (!next && prev) {
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

// ---------- exported updaters ----------
async function applyLocationUpdate(a /*, tctx */) {
  const car = await ensureCarForAction(a);
  const previousLocation = car.location || '';
  updateLocationWithHistory(car, a.location || '');
  await car.save();
  return { changed: previousLocation !== car.location, car, previousLocation };
}

async function applySold(a /*, tctx */) {
  const car = await ensureCarForAction(a);
  const was = car.stage || '';
  car.stage = 'Sold';
  await car.save();
  return { changed: was !== 'Sold', car };
}

async function addChecklistItem(a /*, tctx */) {
  const car = await ensureCarForAction(a);
  const item = (a.checklistItem || '').trim();
  if (!item) throw new Error('Checklist item is empty');
  if (!Array.isArray(car.checklist)) car.checklist = [];
  if (!car.checklist.includes(item)) car.checklist.push(item);
  await car.save();
  return { car, item };
}

async function setReadinessStatus(a /*, tctx */) {
  const car = await ensureCarForAction(a);
  const prev = car.readinessStatus || '';
  const next = (a.readiness || '').trim() || 'Ready';
  car.readinessStatus = next;
  await car.save();
  return { car, readiness: next, previous: prev };
}

async function setNextLocation(a /*, tctx */) {
  const car = await ensureCarForAction(a);
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
  ensureCarForAction,
};
