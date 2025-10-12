// src/services/ai/checklistPostprocess.js
const { geminiGenerate } = require('./llmClient'); // uses REST; harmless if no key

function extractJson(s) {
  if (!s) return {};
  const t = String(s).trim().replace(/^```json\s*|\s*```$/g, '');
  const m = t.match(/\{[\s\S]*\}$/);
  try { return JSON.parse(m ? m[0] : t); } catch { return {}; }
}

/**
 * Input: freeform short findings, one per item (e.g. ["scratch front left fender", "dent rear bumper"])
 * Output: { description: "comma words", checklist: ["Inspect <Issue> - <Location>", ...] }
 */
async function aiRefineChecklist(sentences = [], hint = '') {
  const list = (Array.isArray(sentences) ? sentences : []).slice(0, 120);
  if (!list.length) return { description: '', checklist: [] };

  const prompt = `
Return ONLY minified JSON (no markdown):
{"description":"","checklist":["Inspect <Issue> - <Location>"]}

Rules:
- Every checklist item MUST be "Inspect <Damage> - <Location>" (Title Case).
- <Damage> must be one of: Dent | Scratch | Crack | Rust | Paint Peel | Hail Damage | Burn
  (Map synonyms: scuff/scrape→Scratch, ding/dint→Dent, clear coat/peel→Paint Peel, cracked→Crack, corrosion→Rust, hail→Hail Damage, melt/heat damage→Burn)
- <Location> short, human, Title Case (e.g., "Front Left Fender", "Rear Bumper Lower Left", "Engine Bay", "Underbody", "Driver Seat").
- DEDUPE near-duplicates; pick the clearest phrasing. Max 50 items.
- "description" is a short comma list of exterior colour(s) and accessories (Bullbar, Roof Racks, Snorkel) if implied. Keep generic.

Findings:
${list.map(x=>`- ${String(x)}`).join('\n')}
${hint ? `\nHints: ${hint}\n` : ''}
  `.trim();

  const text = await geminiGenerate([{ text: prompt }], { temperature: 0.1 });
  const obj = extractJson(text);
  const out = {
    description: String(obj.description || '').trim(),
    checklist: Array.isArray(obj.checklist) ? obj.checklist.map(s=>String(s).trim()).filter(Boolean) : [],
  };
  return out;
}

module.exports = { aiRefineChecklist };
