// src/services/import/normalize.js
const REG_ALNUM = /[^A-Z0-9]/g;

function normalizeRego(v) {
  if (!v && v !== 0) return '';
  return String(v).toUpperCase().replace(REG_ALNUM, '');
}

function cleanStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function toIntOrUndefined(v) {
  const s = cleanStr(v);
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

module.exports = {
  normalizeRego,
  cleanStr,
  toIntOrUndefined,
};
