// src/services/ai/visionEnrichment.js
require('dotenv').config();
const path = require('path');
const Car = require('../../models/Car');
const audit = require('../logging/auditLogger');
const { geminiGenerate } = require('./llmClient');

let getSignedViewUrl;
try {
  ({ getSignedViewUrl } = require('../aws/s3'));
} catch {
  ({ getSignedViewUrl } = require('../../services/aws/s3'));
}

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_BYTES = 8 * 1024 * 1024;

/* ------------------------------ small utils ------------------------------ */

function stripFencesToJson(text) {
  if (!text) return null;
  const s = String(text).trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : s); } catch { return null; }
}

const lc = (s) => String(s || '').toLowerCase().trim();

/* ------------------------ normalization / aggregation --------------------- */

/**
 * Canonical damage label set (very small, intentionally).
 * We map many synonyms into this tiny set.
 */
const CANON_DAMAGES = {
  dint: ['dint', 'dent', 'ding'],
  scratch: ['scratch', 'scrape', 'scuff', 'chip', 'stone chip', 'chipped'],
  crack: ['crack', 'cracked', 'fracture', 'split'],
  rust: ['rust', 'corrosion'],
  peel: ['paint peel', 'peel', 'clear coat', 'clearcoat', 'clear-coat', 'clear coat peel'],
  hail: ['hail', 'hail damage'],
  burn: ['burn', 'melt', 'heat damage'],
  'oil leak': ['oil leak', 'engine oil leak'],
  'fluid leak': ['fluid leak', 'coolant leak', 'transmission leak', 'power steering leak', 'ps fluid', 'leak'],
  'warning light': ['warning light', 'check engine', 'engine light', 'abs light', 'srs light'],
};

const DAMAGE_LOOKUP = new Map();
for (const [canon, arr] of Object.entries(CANON_DAMAGES)) {
  for (const k of arr) DAMAGE_LOOKUP.set(k, canon);
}

/** Try to map any phrase to a canonical damage label. */
function canonDamage(s) {
  const t = lc(s);
  if (!t) return null;
  if (DAMAGE_LOOKUP.has(t)) return DAMAGE_LOOKUP.get(t);
  // fallback: contains match
  for (const [k, v] of DAMAGE_LOOKUP.entries()) {
    if (t.includes(k)) return v;
  }
  // last resort: exact match to one of canon keys
  if (CANON_DAMAGES[t]) return t;
  return null;
}

/**
 * Try to parse "Inspect Scratch - Front Left Fender"
 * Returns { panel: 'front left fender', damage: 'scratch' } or null
 */
function parseInspectLine(line) {
  const m = String(line || '').match(/^inspect\s+(.+?)\s*-\s*(.+)$/i);
  if (!m) return null;
  const issue = m[1];
  const where = m[2];

  const damage = canonDamage(issue);
  if (!damage) return null;

  // panels are kept simple/lowercase; scrub some noise words
  let panel = lc(where)
    .replace(/\barea\b/g, '')
    .replace(/\btrim\b/g, ' trim') // keep "trim" if present
    .replace(/\bpanel\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!panel) return null;

  return { panel, damage };
}

/**
 * Force 1 line per panel:
 * Aggregates all damages for a panel and renders:
 *   "Inspect <panel> for <d1> & <d2> & <d3>"
 */
function aggregateOneLinePerPanel(lines = []) {
  const bucket = new Map(); // panel -> Set(damages)
  for (const ln of lines) {
    const p = parseInspectLine(ln);
    if (!p) continue;
    if (!bucket.has(p.panel)) bucket.set(p.panel, new Set());
    bucket.get(p.panel).add(p.damage);
  }

  const out = [];
  for (const [panel, damagesSet] of bucket.entries()) {
    const damages = Array.from(damagesSet);
    if (!damages.length) continue;
    const joined = damages.length === 1
      ? damages[0]
      : damages.slice(0, -1).join(' & ') + ' & ' + damages.slice(-1);
    out.push(`Inspect ${panel} for ${joined}`);
  }
  return out;
}

/* --------------------------- model interactions --------------------------- */

// Step 1: Image -> rough free-form sentences
async function callGeminiRough({ bytes, mimeType, caption }) {
  if (!GOOGLE_API_KEY) return { sentences: [], _raw: '{}' };

  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL_NAME}:generateContent?key=${encodeURIComponent(GOOGLE_API_KEY)}`;
  const prompt = `
Return ONLY MINIFIED JSON:
{"sentences":["..."]}

Goal:
- From the vehicle photo, output short rough findings (one per bullet).
- Focus ONLY on visible damage/defects and obvious accessories.
- Examples: "scratch front left fender", "dent front bumper lower left", "paint peel left fender", "snorkel".
- Skip duplicates and near-duplicates. Max 60 items.
`.trim();

  const parts = [
    { text: prompt },
    { text: caption ? `Caption hint: ${caption}` : 'No caption' },
    { inlineData: { mimeType, data: Buffer.from(bytes).toString('base64') } },
  ];

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.1 }
      })
    });
    const json = await resp.json();
    const text = json?.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
    const obj = stripFencesToJson(text);
    const sentences = Array.isArray(obj?.sentences) ? obj.sentences.map(s => String(s).trim()).filter(Boolean) : [];
    return { sentences, _raw: text || JSON.stringify(json).slice(0, 2000) };
  } catch (err) {
    audit.write(caption ? { caption } : {}, 'vision.error', { summary: String(err?.message || err) });
    return { sentences: [], _raw: '{}' };
  }
}

// Step 2: Rough -> normalized "Inspect <Damage> - <Panel>" lines
async function aiRefineChecklist(sentences = [], hint = '') {
  const list = (Array.isArray(sentences) ? sentences : []).slice(0, 120);
  if (!list.length) return { description: '', checklist: [] };

  const prompt = `
Return ONLY minified JSON:
{"description":"","checklist":["Inspect <Damage> - <Panel>"]}

Rules:
- Each item MUST be exactly: Inspect <Damage> - <Panel>
- Title Case NOT required; keep it simple; we'll normalize ourselves.
- <Damage> should be from this tiny set:
  { Dent | Scratch | Crack | Rust | Paint Peel | Hail Damage | Burn | Oil Leak | Fluid Leak | Warning Light }
- Map synonyms: dint/ding/dent -> Dent; scuff/scrape/chip -> Scratch; corrosion -> Rust;
  clear coat/peel -> Paint Peel; leaked fluids -> Fluid Leak; cracked -> Crack.
- <Panel> should be a short human panel name (e.g., "front bumper", "left fender").
- Avoid duplicates and near-duplicates, but it's OK if same panel appears more than once (we will merge later).
- "description" = optional short comma list of obvious accessories or colour words.

Findings:
${list.map(x => `- ${String(x)}`).join('\n')}
${hint ? `Hints: ${hint}` : ''}
`.trim();

  const text = await geminiGenerate([{ text: prompt }], { temperature: 0.05 });
  const obj = stripFencesToJson(text) || {};
  const raw = Array.isArray(obj.checklist) ? obj.checklist : [];
  // Normalize into our Inspect <Damage> - <Panel> shape (best-effort)
  const normalized = raw
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .map((s) => {
      // If already "Inspect X - Y", leave as is
      if (/^inspect\s+.+?-\s*.+/i.test(s)) return s;
      // Try to coerce simple "damage panel" -> Inspect Damage - Panel
      const bits = lc(s).split(/\s+-\s+| on | at | near | for /i);
      if (bits.length >= 2) {
        const dmg = bits[0];
        const pnl = bits.slice(1).join(' ');
        return `Inspect ${dmg} - ${pnl}`;
      }
      return s.startsWith('Inspect') ? s : `Inspect ${s}`;
    });

  const description = String(obj.description || '').trim();
  return { description, checklist: normalized };
}

/* ------------------------------- Public API ------------------------------- */

async function analyzeWithGemini({ bytes, mimeType = 'image/jpeg', caption = '' }, tctx) {
  if (!bytes?.length) return { inspect: [], notes: 'empty', features: [], colours: [], damages: [] };
  if (bytes.length > MAX_BYTES) return { inspect: [], notes: 'too_big', features: [], colours: [], damages: [] };

  // 1) vision → rough
  const roughRes = await callGeminiRough({ bytes, mimeType, caption });
  const rough = roughRes.sentences;

  // 2) rough → normalized Inspect lines
  const refined = await aiRefineChecklist(rough, caption || '');
  const rawInspect = Array.isArray(refined.checklist) ? refined.checklist : [];

  // 3) HARD aggregation: one line per panel (always)
  const inspect = aggregateOneLinePerPanel(rawInspect);

  const description = String(refined.description || '').trim();

  audit.write(tctx, 'vision.response', {
    summary: `rough:${rough.length} normalized:${rawInspect.length} final:${inspect.length}`,
    out: {
      rough: rough.slice(0, 10),
      normalizedSample: rawInspect.slice(0, 10),
      finalSample: inspect.slice(0, 10),
      description: description.slice(0, 160)
    }
  });

  return { features: [], colours: [], damages: [], inspect, notes: description };
}

/* --------------------------- S3 convenience path -------------------------- */

async function analyzeCarS3Key({ key, caption = '' }, tctx) {
  try {
    const url = await getSignedViewUrl(key, 300);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`S3 signed URL fetch ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const ext = path.extname(key).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return analyzeWithGemini({ bytes, mimeType: mime, caption }, tctx);
  } catch (e) {
    audit.write({ key }, 'vision.error', { summary: `fetch/analyze failed: ${e.message}` });
    return { features: [], colours: [], damages: [], inspect: [], notes: '' };
  }
}

/* -------------------------- persistence into Mongo ------------------------ */

async function enrichCarWithFindings({ carId, features = [], colours = [], damages = [], inspect = [], notes = '' }, tctx) {
  const car = await Car.findById(carId);
  if (!car) throw new Error('Car not found');

  // We ONLY persist the already-aggregated, basic form:
  const checklist = new Set(Array.isArray(car.checklist) ? car.checklist : []);
  (inspect || []).forEach(i => {
    const v = String(i || '').trim();
    if (v) checklist.add(v);
  });

  // Merge description hints very lightly
  const desc = new Set(
    String(car.description || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );
  if (notes && typeof notes === 'string') {
    notes.split(',').map(s => s.trim()).filter(Boolean).forEach(x => desc.add(x));
  }

  car.checklist = [...checklist];
  car.description = [...desc].join(', ');
  await car.save();

  audit.write(tctx, 'vision.enrich', {
    summary: `car:${car.rego} +inspect:${inspect.length} desc:${car.description ? 1 : 0}`,
    out: { description: car.description, checklistSample: car.checklist.slice(0, 20) }
  });

  return { car, features, colours, damages, inspect };
}

/* ------------------------------- convenience ------------------------------ */

async function analyzeAndEnrichByS3Key({ carId, key, caption = '' }, tctx) {
  const r = await analyzeCarS3Key({ key, caption }, tctx);
  return enrichCarWithFindings({
    carId,
    features: r.features,
    colours: r.colours,
    damages: r.damages,
    inspect: r.inspect,
    notes: r.notes
  }, tctx);
}

module.exports = {
  analyzeWithGemini,
  analyzeCarS3Key,
  enrichCarWithFindings,
  analyzeAndEnrichByS3Key,
};
