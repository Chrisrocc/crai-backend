// One simple AI post-process step to clean + dedupe checklist lines.
// Input: array of strings (any phrasing).
// Output: array of strings, each **exactly** "Inspect <Damage> - <Location>"
// Fallback: local normalizeChecklist() if model fails.

const { chatJSON } = require('./llmClient');
const { normalizeChecklist, toInspectCanonical } = require('./checklistDeduper');

const SYSTEM = `
You will receive a list of short vehicle checklist lines extracted from photos.
Your job is to CLEAN, DEDUPLICATE, and UNIFY the lines.

Return STRICT MINIFIED JSON ONLY (no markdown, no comments), with this schema:
{"sentences":["Inspect <Damage> - <Location>", ...]}

Rules:
- Every item MUST be exactly: "Inspect <Damage> - <Location>".
- Use these canonical damages (case-sensitive): Dent | Scratch | Crack | Rust | Paint Peel | Hail Damage | Burn
- Map synonyms:
  scuff/scrape → Scratch
  ding/dint → Dent
  chipped/chip → Scratch
  cracked → Crack
  corrosion → Rust
  clear coat/peeling/peel → Paint Peel
  hail → Hail Damage
  melt/heat damage → Burn
- <Location> must be short, Title Case (e.g., "Front Left Fender", "Rear Bumper Lower Left", "Driver Seat", "Alloy Wheel Rim").
- Remove duplicates and near-duplicates that describe the same damage and spot (even if wording differs).
  Prefer a concise, readable phrasing.
- Discard non-damage lines (features/colours/accessories).
- Limit the final list to ≤ 60 items.
`.trim();

/**
 * Clean & dedupe via LLM, with robust fallback to local normalizer.
 * @param {string[]} rawLines
 * @returns {Promise<string[]>}
 */
async function aiDedupeAndFormat(rawLines = []) {
  const lines = (Array.isArray(rawLines) ? rawLines : [])
    .map(s => String(s || '').trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  try {
    const user = lines.join('\n');
    const out = await chatJSON({ system: SYSTEM, user, temperature: 0 });
    const sentences = Array.isArray(out?.sentences) ? out.sentences : [];
    if (sentences.length) {
      // Second-pass local guard (canonicalize + fuzzy de-dupe)
      return normalizeChecklist(sentences);
    }
  } catch (e) {
    console.warn('aiDedupeAndFormat LLM error:', e.message);
  }

  // Fallback: local canonicalize + fuzzy de-dupe
  return normalizeChecklist(lines.map(toInspectCanonical));
}

module.exports = { aiDedupeAndFormat };
