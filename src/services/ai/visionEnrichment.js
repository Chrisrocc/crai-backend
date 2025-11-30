// src/services/ai/visionEnrichment.js
require('dotenv').config();
const path = require('path');
const Car = require('../../models/Car');
const audit = require('../logging/auditLogger');
const { geminiGenerate } = require('./llmClient'); // kept for future use if needed

let getSignedViewUrl;
try {
  ({ getSignedViewUrl } = require('../aws/s3'));
} catch {
  ({ getSignedViewUrl } = require('../../services/aws/s3'));
}

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_BYTES = 8 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/* utils                                                                      */
/* -------------------------------------------------------------------------- */

function stripFencesToJson(text) {
  if (!text) return null;
  const s = String(text)
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  const m = s.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(m ? m[0] : s);
  } catch {
    return null;
  }
}

const lc = (s) => String(s || '').toLowerCase().trim();

/* -------------------------------------------------------------------------- */
/* Canonical damage mapping                                                   */
/* -------------------------------------------------------------------------- */

const CANON_DAMAGES = {
  dent: ['dent', 'dint', 'ding'],
  scratch: ['scratch', 'scrape', 'scuff', 'chip', 'stone chip'],
  crack: ['crack', 'cracked', 'split', 'fracture'],
  rust: ['rust', 'corrosion'],
  'paint peel': ['paint peel', 'clear coat', 'clearcoat', 'clear-coat', 'peel'],
  'hail damage': ['hail', 'hail damage'],
  burn: ['burn', 'melt', 'heat damage'],
  'oil leak': ['oil leak'],
  'fluid leak': [
    'fluid leak',
    'coolant leak',
    'transmission leak',
    'power steering leak',
    'ps fluid',
    'leak',
  ],
  'warning light': [
    'warning light',
    'check engine',
    'engine light',
    'abs light',
    'srs light',
  ],
};

const DAMAGE_LOOKUP = new Map();
for (const [canon, arr] of Object.entries(CANON_DAMAGES)) {
  for (const k of arr) DAMAGE_LOOKUP.set(k, canon);
}

function canonDamage(s) {
  const t = lc(s);
  if (!t) return null;
  if (DAMAGE_LOOKUP.has(t)) return DAMAGE_LOOKUP.get(t);
  for (const [k, v] of DAMAGE_LOOKUP.entries()) {
    if (t.includes(k)) return v;
  }
  if (CANON_DAMAGES[t]) return t;
  return t; // fall back to raw text
}

/* -------------------------------------------------------------------------- */
/* LLM calls                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Step 1: Image → structured rough items
 *
 * Returns:
 * {
 *   items: [
 *     { zone: "exterior"|"interior", section: "front bumper", damage: "scratch", confidence: 0.96 },
 *     ...
 *   ],
 *   _raw: "<llm raw text>"
 * }
 */
async function callGeminiRough({ bytes, mimeType, caption }) {
  if (!GOOGLE_API_KEY) {
    return { items: [], _raw: '{"error":"no_api_key"}' };
  }

  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL_NAME}:generateContent?key=${encodeURIComponent(
    GOOGLE_API_KEY
  )}`;

  const prompt = `
Return ONLY MINIFIED JSON in this exact shape:
{"items":[{"zone":"exterior","section":"front bumper","damage":"scratch","confidence":0.95}]}

Rules:
- "items" is an array. Max 40 items.
- Each item:
  - "zone": "exterior" or "interior" (lowercase).
  - "section": short label like "front bumper", "rear bumper", "bonnet", "seats", "door trim", "dashboard".
  - "damage": very short description like "scratch", "dent", "crack", "tear", "stain".
  - "confidence": number between 0 and 1 (model's confidence).
- ONLY include items where you are reasonably sure (do NOT guess).
- Use "exterior" for body panels, glass, lights, wheels, exterior trims.
- Use "interior" for seats, dash, steering wheel, carpets, headliner, door trims, infotainment.
- Do not describe things that are clearly fine.
- Avoid near-duplicates (same section + same damage type).
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
        generationConfig: { temperature: 0.1 },
      }),
    });

    const json = await resp.json();
    const text =
      json?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text || '';
    const obj = stripFencesToJson(text);
    const rawItems = Array.isArray(obj?.items) ? obj.items : [];

    const items = rawItems
      .map((r) => ({
        zone: lc(r.zone || ''),
        section: String(r.section || '').trim(),
        damage: String(r.damage || '').trim(),
        confidence: typeof r.confidence === 'number' ? r.confidence : 0,
      }))
      .filter((r) => r.zone && r.section && r.damage);

    return { items, _raw: text || JSON.stringify(json).slice(0, 2000) };
  } catch (err) {
    audit.write(caption ? { caption } : {}, 'vision.error', {
      summary: String(err?.message || err),
    });
    return { items: [], _raw: '{"error":"exception"}' };
  }
}

/**
 * Step 2: High-confidence compression → 2 lines max
 *
 * Input: items = [{ zone, section, damage, confidence }]
 * Output:
 *   {
 *     description: "",  // reserved for future
 *     checklist: [
 *       "Exterior: front bumper - scratch, rear bumper - dent",
 *       "Interior: seats - tear, door trim - scuff"
 *     ]
 *   }
 */
function aiRefineChecklist(items = [], caption = '') {
  const MIN_CONFIDENCE = 0.9; // only keep things we're very sure about
  const MAX_PER_ZONE = 8; // hard cap per zone to avoid crazy-long lines

  const high = (Array.isArray(items) ? items : []).filter((i) => {
    const c = Number(i.confidence || 0);
    return c >= MIN_CONFIDENCE && i.zone && i.section && i.damage;
  });

  if (!high.length) {
    return { description: '', checklist: [] };
  }

  const byZone = {
    Exterior: new Map(), // key -> { section, damage }
    Interior: new Map(),
  };

  for (const it of high) {
    const zone = it.zone.includes('inter') ? 'Interior' : 'Exterior';
    const section = String(it.section || '').trim();
    const damage = canonDamage(it.damage) || String(it.damage || '').trim();
    if (!section || !damage) continue;

    const key = `${section.toLowerCase()}|${damage.toLowerCase()}`;
    const bucket = byZone[zone];
    if (!bucket.has(key)) {
      bucket.set(key, { section, damage });
    }
  }

  const lines = [];

  // Exterior
  if (byZone.Exterior.size) {
    const parts = Array.from(byZone.Exterior.values())
      .slice(0, MAX_PER_ZONE)
      .map((p) => `${p.section} - ${p.damage}`);
    if (parts.length) {
      lines.push(`Exterior: ${parts.join(', ')}`);
    }
  }

  // Interior
  if (byZone.Interior.size) {
    const parts = Array.from(byZone.Interior.values())
      .slice(0, MAX_PER_ZONE)
      .map((p) => `${p.section} - ${p.damage}`);
    if (parts.length) {
      lines.push(`Interior: ${parts.join(', ')}`);
    }
  }

  return {
    description: '',
    checklist: lines, // 0, 1, or 2 lines total
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

async function analyzeWithGemini(
  { bytes, mimeType = 'image/jpeg', caption = '' },
  tctx
) {
  if (!bytes?.length) {
    return {
      inspect: [],
      notes: 'empty',
      features: [],
      colours: [],
      damages: [],
    };
  }

  if (bytes.length > MAX_BYTES) {
    return {
      inspect: [],
      notes: 'too_big',
      features: [],
      colours: [],
      damages: [],
    };
  }

  // 1) vision → structured rough items
  const roughRes = await callGeminiRough({ bytes, mimeType, caption });
  const items = Array.isArray(roughRes.items) ? roughRes.items : [];

  // 2) compress into 2 lines max
  const refined = aiRefineChecklist(items, caption || '');
  const inspect = Array.isArray(refined.checklist) ? refined.checklist : [];

  audit.write(tctx, 'vision.response', {
    summary: `items:${items.length} highConfLines:${inspect.length}`,
    out: {
      sampleItems: items.slice(0, 8),
      checklist: inspect,
    },
  });

  // Only "inspect" affects checklist; keep others empty for now
  return {
    features: [],
    colours: [],
    damages: [],
    inspect, // this becomes 0–2 lines
    notes: refined.description || '',
  };
}

/* --------------------------- S3 convenience path -------------------------- */

async function analyzeCarS3Key({ key, caption = '' }, tctx) {
  try {
    const url = await getSignedViewUrl(key, 300);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`S3 signed URL fetch ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const ext = path.extname(key).toLowerCase();
    const mime =
      ext === '.png'
        ? 'image/png'
        : ext === '.webp'
        ? 'image/webp'
        : 'image/jpeg';
    return analyzeWithGemini({ bytes, mimeType: mime, caption }, tctx);
  } catch (e) {
    audit.write({ key }, 'vision.error', {
      summary: `fetch/analyze failed: ${e.message}`,
    });
    return { features: [], colours: [], damages: [], inspect: [], notes: '' };
  }
}

/* -------------------------- persistence into Mongo ------------------------ */

async function enrichCarWithFindings(
  { carId, features = [], colours = [], damages = [], inspect = [], notes = '' },
  tctx
) {
  const car = await Car.findById(carId);
  if (!car) throw new Error('Car not found');

  // ONLY AI path adds "Inspect ..." lines.
  const checklist = new Set(Array.isArray(car.checklist) ? car.checklist : []);
  (inspect || []).forEach((i) => {
    const v = String(i || '').trim();
    if (v) checklist.add(v);
  });

  // description merge kept minimal for now; extend later if needed
  const desc = new Set(
    String(car.description || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  car.checklist = [...checklist];
  car.description = [...desc].join(', ');
  await car.save();

  audit.write(tctx, 'vision.enrich', {
    summary: `car:${car.rego} +inspectLines:${inspect.length}`,
    out: { checklistSample: car.checklist.slice(0, 20) },
  });

  return { car, features, colours, damages, inspect };
}

/* ------------------------------- convenience ------------------------------ */

async function analyzeAndEnrichByS3Key({ carId, key, caption = '' }, tctx) {
  const r = await analyzeCarS3Key({ key, caption }, tctx);
  return enrichCarWithFindings(
    {
      carId,
      features: r.features,
      colours: r.colours,
      damages: r.damages,
      inspect: r.inspect,
      notes: r.notes,
    },
    tctx
  );
}

module.exports = {
  analyzeWithGemini,
  analyzeCarS3Key,
  enrichCarWithFindings,
  analyzeAndEnrichByS3Key,
};
