// backend/src/scripts/seedCars.js
// Usage:
//   node src/scripts/seedCars.js                 -> seeds 50 cars
//   node src/scripts/seedCars.js --count=120     -> seeds 120 cars
//   node src/scripts/seedCars.js --clear         -> deletes ALL cars
//   node src/scripts/seedCars.js --clear --count=60 -> clears then seeds 60

require('dotenv').config();
const mongoose = require('mongoose');

const Car = require('../models/Car');

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI missing in .env');
  process.exit(1);
}

const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}`));
  if (!hit) return def;
  const [, v] = hit.split('=');
  return v === undefined ? true : v;
};

const COUNT = parseInt(arg('count', 50), 10);
const CLEAR = !!arg('clear', false);

const MAKES = [
  ['Toyota', 'Corolla'], ['Toyota', 'Camry'], ['Toyota', 'RAV4'],
  ['Mazda', '3'], ['Mazda', 'CX-5'], ['Mazda', '2'],
  ['Hyundai', 'i30'], ['Hyundai', 'Tucson'], ['Kia', 'Sportage'],
  ['Nissan', 'X-Trail'], ['Nissan', 'Qashqai'], ['Subaru', 'Forester'],
  ['Honda', 'Civic'], ['Honda', 'CR-V'], ['Volkswagen', 'Golf'],
  ['Ford', 'Focus'], ['Ford', 'Ranger'], ['Mitsubishi', 'ASX'],
  ['Mitsubishi', 'Outlander'], ['Suzuki', 'Swift'],
];

const BADGES = ['Base', 'Sport', 'GXL', 'SX', 'ST', 'RS', 'Premium', 'S', 'GT', 'Limited'];
const SERIES = ['Series I', 'Series II', 'MY18', 'MY20', 'MY22', 'Facelift', 'MK2'];
const LOCATIONS = ['', 'Unique', 'Haytham', 'Detailing', 'Workshop', 'Lot A', 'Lot B', 'Photo Bay'];
const STAGES = ['In Works', 'In Works/Online', 'Online', 'Sold'];
const READY = ['Queued', 'In Progress', 'Ready', 'Needs Parts', 'Waiting Clean'];

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randRego() {
  // AUS-style-ish: 3 letters + 3 digits (e.g., ABC-123)
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const nums = '0123456789';
  const L = () => letters[randInt(0, letters.length - 1)];
  const N = () => nums[randInt(0, nums.length - 1)];
  return `${L()}${L()}${L()}-${N()}${N()}${N()}`;
}
function randomPastDate(daysBack = 60) {
  const now = Date.now();
  const pastMs = now - randInt(0, daysBack) * 24 * 60 * 60 * 1000;
  return new Date(pastMs);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB');

  if (CLEAR) {
    const del = await Car.deleteMany({});
    console.log(`🧹 Cleared ${del.deletedCount} cars`);
  }

  const docs = [];
  const seenRego = new Set();

  while (docs.length < COUNT) {
    let [make, model] = rand(MAKES);
    const badge = Math.random() < 0.7 ? rand(BADGES) : '';
    const series = Math.random() < 0.6 ? rand(SERIES) : '';
    const year = randInt(2005, 2025);

    let rego;
    do {
      rego = randRego();
    } while (seenRego.has(rego));
    seenRego.add(rego);

    const description = Math.random() < 0.3 ? `${make} ${model} ${badge}`.trim() : '';
    const checklist = [];
    if (Math.random() < 0.5) checklist.push('Tyres');
    if (Math.random() < 0.5) checklist.push('Service');
    if (Math.random() < 0.5) checklist.push('Detail');

    // current location (maybe empty)
    const location = rand(LOCATIONS);

    // history: if there is a location, start an open history entry
    const history = [];
    if (location) {
      history.push({
        location,
        startDate: randomPastDate(30),
        endDate: null,
        days: 0, // computed on FE for open entries
      });
    }

    // next locations (0–2 planned)
    const nextLocations = [];
    if (Math.random() < 0.5) nextLocations.push(rand(LOCATIONS.filter(Boolean)));
    if (Math.random() < 0.25) nextLocations.push(rand(LOCATIONS.filter(Boolean)));

    const stage = rand(STAGES);
    const readinessStatus = rand(READY);

    docs.push({
      rego,
      make,
      model,
      badge,
      series,
      year,
      description,
      checklist,
      location,
      history,
      nextLocations,
      readinessStatus,
      stage,
      // 🚫 Do NOT add "Seeded on ..." in notes anymore
      notes: '',
      dateCreated: randomPastDate(90),
      photos: [], // empty
    });
  }

  const res = await Car.insertMany(docs, { ordered: false });
  console.log(`🚗 Seeded ${res.length} cars`);
  await mongoose.disconnect();
  console.log('✅ Done, disconnected');
}

main().catch(async (e) => {
  console.error('❌ Seed error:', e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
