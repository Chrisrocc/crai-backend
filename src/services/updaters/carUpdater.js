const Car = require('../../models/Car');
const { matchRego } = require('../matching/regoMatcher');
const timeline = require('../logging/timelineLogger');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// LOCATION UPDATE
// ---------------------------------------------------------------------------
async function applyLocationUpdate(a, tctx) {
  const rego = normalizeRego(a.rego);
  const newLoc = normalize(a.location);
  if (!rego || !newLoc) throw new Error('Missing rego or location');

  const car = await Car.findOne({ rego: new RegExp(`^${rego}$`, 'i') });
  if (!car) throw new Error(`Car ${rego} not found`);

  const prev = car.location || '';
  if (prev === newLoc) {
    return { changed: false, car };
  }

  // close old history entry
  if (Array.isArray(car.history) && car.history.length) {
    const last = car.history[car.history.length - 1];
    if (last && !last.endDate) {
      last.endDate = new Date();
      last.days = daysClosed(last.startDate, last.endDate);
    }
  } else {
    car.history = [];
  }

  car.history.push({
    location: newLoc,
    startDate: new Date(),
    endDate: null,
    days: 0,
  });
  car.location = newLoc;
  await car.save();

  if (tctx && typeof timeline.locationUpdate === 'function') {
    timeline.locationUpdate(tctx, `${rego}: ${prev || '-'} → ${newLoc}`);
  }
  return { changed: true, car, previousLocation: prev };
}

// ---------------------------------------------------------------------------
// SOLD
// ---------------------------------------------------------------------------
async function applySold(a, tctx) {
  const rego = normalizeRego(a.rego);
  if (!rego) throw new Error('Missing rego');

  const car = await Car.findOne({ rego: new RegExp(`^${rego}$`, 'i') });
  if (!car) throw new Error(`Car ${rego} not found`);

  if (car.stage === 'Sold') {
    return { changed: false, car };
  }

  car.stage = 'Sold';
  await car.save();

  if (tctx && typeof timeline.sold === 'function') {
    timeline.sold(tctx, `${rego}: marked Sold`);
  }
  return { changed: true, car };
}

// ---------------------------------------------------------------------------
// CHECKLIST ITEM / REPAIR
// ---------------------------------------------------------------------------
async function addChecklistItem(a, tctx) {
  const rego = normalizeRego(a.rego);
  if (!rego || !a.checklistItem) throw new Error('Missing rego or checklist item');

  const car = await Car.findOne({ rego: new RegExp(`^${rego}$`, 'i') });
  if (!car) throw new Error(`Car ${rego} not found`);

  const item = String(a.checklistItem).trim();
  if (!item) throw new Error('Empty checklist item');

  const checklist = Array.isArray(car.checklist) ? car.checklist : [];
  if (!checklist.includes(item)) checklist.push(item);

  car.checklist = checklist;
  await car.save();

  if (tctx && typeof timeline.repair === 'function') {
    timeline.repair(tctx, `${rego}: + ${item}`);
  }
  return { car, item };
}

// ---------------------------------------------------------------------------
// READINESS
// ---------------------------------------------------------------------------
async function setReadinessStatus(a, tctx) {
  const rego = normalizeRego(a.rego);
  const readiness = normalize(a.readiness);
  if (!rego) throw new Error('Missing rego');

  const car = await Car.findOne({ rego: new RegExp(`^${rego}$`, 'i') });
  if (!car) throw new Error(`Car ${rego} not found`);

  car.readinessStatus = readiness;
  await car.save();

  if (tctx && typeof timeline.ready === 'function') {
    timeline.ready(tctx, `${rego}: readiness → ${readiness}`);
  }
  return { car, readiness };
}

// ---------------------------------------------------------------------------
// NEXT LOCATION
// ---------------------------------------------------------------------------
async function setNextLocation(a, tctx) {
  const rego = normalizeRego(a.rego);
  const nextLoc = normalize(a.nextLocation);
  if (!rego || !nextLoc) throw new Error('Missing rego or next location');

  const car = await Car.findOne({ rego: new RegExp(`^${rego}$`, 'i') });
  if (!car) throw new Error(`Car ${rego} not found`);

  const nexts = Array.isArray(car.nextLocations) ? car.nextLocations : [];
  if (!nexts.includes(nextLoc)) nexts.push(nextLoc);
  car.nextLocations = nexts;
  await car.save();

  if (tctx && typeof timeline.nextLocation === 'function') {
    timeline.nextLocation(tctx, `${rego}: next → ${nextLoc}`);
  }
  return { car, nextLoc };
}

// ---------------------------------------------------------------------------
// ENSURE CAR EXISTS (auto-create + fuzzy match, with optional log bundle)
// ---------------------------------------------------------------------------
async function ensureCarForAction(base = {}, tctx = null, opts = {}) {
  const { withLog = false } = opts;
  const logLines = [];

  const rego = (base.rego || '').toUpperCase().replace(/\s+/g, '');
  const make = (base.make || '').trim();
  const model = (base.model || '').trim();
  const color =
    (base.color || '').trim() ||
    (base.description || '').split(',')[0]?.trim() ||
    '';
  const year = base.year || '';
  const badge = base.badge || '';
  const desc = base.description || '';

  logLines.push(
    `input → rego:"${rego || '-'}" make:"${make || '-'}" model:"${model || '-'}"`
  );

  if (!rego && !make && !model) {
    const msg = 'Insufficient info: need rego or make+model';
    logLines.push(msg);
    console.log('🚘 REGO RESOLUTION\n' + logLines.map(l => `- ${l}`).join('\n'));
    throw new Error(msg);
  }

  // 1️⃣ Exact rego match
  let car = null;
  if (rego) {
    car = await Car.findOne({ rego: new RegExp(`^${rego}$`, 'i') });
    if (car) {
      const line = `exact match in DB → ${car.rego} (${car.make || ''} ${car.model || ''})`;
      logLines.push(line);
      if (tctx && typeof timeline.ensureCar === 'function') {
        timeline.ensureCar(tctx, line);
      }
      console.log('🚘 REGO RESOLUTION\n' + logLines.map(l => `- ${l}`).join('\n'));
      if (withLog) return { car, logLines };
      return car;
    }
    logLines.push('no exact rego match in DB');
  } else {
    logLines.push('no rego provided, skipping exact-rego lookup');
  }

  // 2️⃣ Fuzzy rego match (using make/model/color/year)
  const fuzzy = await matchRego({
    ocrRego: rego,
    make,
    model,
    color,
    year,
    ocrConfidence: 0.9,
  });

  if (fuzzy) {
    logLines.push(
      `fuzzy matcher → action:${fuzzy.action}, reason:${fuzzy.reason || 'n/a'}`
    );

    if (fuzzy.best) {
      const best = fuzzy.best;
      const bestCar = best.car || {};
      const bestScore =
        typeof best.score === 'number'
          ? best.score.toFixed(3)
          : String(best.score ?? '-');
      logLines.push(
        `best candidate: ${best.plate} (${bestCar.make || ''} ${bestCar.model || ''}) score:${bestScore}`
      );
    } else {
      logLines.push('no fuzzy candidate (best=null)');
    }

    if (fuzzy.second) {
      const second = fuzzy.second;
      const secondScore =
        typeof second.score === 'number'
          ? second.score.toFixed(3)
          : String(second.score ?? '-');
      logLines.push(
        `second best: ${second.plate} score:${secondScore}`
      );
    }
  } else {
    logLines.push('fuzzy matcher returned null/undefined');
  }

  if (fuzzy && fuzzy.action === 'auto-fix' && fuzzy.best?.car?._id) {
    car = await Car.findById(fuzzy.best.car._id);
    if (car) {
      const line = `using fuzzy match → ${rego} → ${car.rego} (${car.make || ''} ${car.model || ''})`;
      logLines.push(line);
      if (tctx && typeof timeline.ensureCar === 'function') {
        timeline.ensureCar(tctx, line);
      }
      console.log('🚘 REGO RESOLUTION\n' + logLines.map(l => `- ${l}`).join('\n'));
      if (withLog) return { car, logLines };
      return car;
    }
    logLines.push('fuzzy suggested car, but lookup by _id failed');
  }

  // 3️⃣ Create new car if none found / fuzzy not strong enough
  const newCar = new Car({
    rego,
    make,
    model,
    badge,
    year,
    color,
    description: desc || color,
    location: '',
    stage: 'In Works',
    readinessStatus: '',
    nextLocations: [],
    checklist: [],
    history: [],
    notes: '',
  });

  await newCar.save();
  const line = `created new car → ${newCar.rego} (${newCar.make || ''} ${newCar.model || ''})`;
  logLines.push(line);

  if (tctx && typeof timeline.ensureCar === 'function') {
    timeline.ensureCar(tctx, line);
  }

  console.log('🚘 REGO RESOLUTION\n' + logLines.map(l => `- ${l}`).join('\n'));

  if (withLog) return { car: newCar, logLines };
  return newCar;
}

module.exports = {
  applyLocationUpdate,
  applySold,
  addChecklistItem,
  setReadinessStatus,
  setNextLocation,
  ensureCarForAction,
};
