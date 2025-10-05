// src/services/import/csvCarMapper.js
const { normalizeRego, cleanStr, toIntOrUndefined } = require('./normalize');

/**
 * Try to grab the first non-empty value among aliases.
 */
function pick(row, aliases = []) {
  for (const key of aliases) {
    // match case-insensitively
    const found = Object.keys(row).find(k => k.toLowerCase() === key.toLowerCase());
    if (found) {
      const v = row[found];
      if (v !== undefined && v !== null && String(v).trim() !== '') return row[found];
    }
  }
  return '';
}

/**
 * Heuristics: work with different CSVs (Dealerlogic/Autogate/etc)
 */
function mapRowToCar(row, options = {}) {
  const { defaultStage = 'Online' } = options;

  const rego = normalizeRego(pick(row, [
    'rego','registration','plate','plate number','plate_no','plate number','plate #',
    'stock reg','reg no','reg number','license','licence'
  ]));

  const vin = cleanStr(pick(row, ['vin', 'vehicle identification number']));

  const make = cleanStr(pick(row, ['make','manufacturer']));
  const model = cleanStr(pick(row, ['model']));
  // Badge/Series may appear in many forms
  const badge = cleanStr(pick(row, ['badge','variant','trim']));
  const series = cleanStr(pick(row, ['series','model series']));
  const year = toIntOrUndefined(pick(row, ['year','build year','compliance year','yr']));

  // Color/Colour can enhance description
  const colour = cleanStr(pick(row, ['colour','color','exterior colour','exterior color','body colour']));
  const body = cleanStr(pick(row, ['body','body type']));
  const transmission = cleanStr(pick(row, ['transmission','gearbox']));
  const driven = cleanStr(pick(row, ['drivetrain','drive type','drivetype']));

  // Description: assemble something tidy if not present
  let description = cleanStr(pick(row, ['description','desc']));
  const bits = [colour, body, transmission, driven].filter(Boolean);
  if (!description && bits.length) description = bits.join(' — ');

  // Optional notes
  const notes = cleanStr(pick(row, ['notes','note','comment','comments']));

  // Stage: we default to 'Online' for imports of online lists, but allow override
  const stageRaw = cleanStr(pick(row, ['stage']));
  const stage = stageRaw || defaultStage;

  // Location is optional in import
  const location = cleanStr(pick(row, ['location','yard','site']));

  return {
    rego,
    vin,
    make,
    model,
    badge: badge.slice(0, 64), // keep sane
    series,
    year,
    description,
    notes,
    stage,
    location,
  };
}

module.exports = { mapRowToCar };
