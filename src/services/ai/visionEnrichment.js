// src/services/ai/visionEnrichment.js
require('dotenv').config();
const path = require('path');
const Car = require('../../models/Car');
const audit = require('../logging/auditLogger');

let getSignedViewUrl;
try {
  ({ getSignedViewUrl } = require('../aws/s3'));
} catch {
  ({ getSignedViewUrl } = require('../../services/aws/s3'));
}

/* =========================
   Config
   ========================= */
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const MIN_CONF_GOOD = 0.8;
const MIN_CONF_INSPECT = 0.4;
const MAX_BYTES = 8 * 1024 * 1024;

/* =========================
   Canonicalization maps
   ========================= */
const FEATURE_CANON = new Map([
  ['bullbar', 'Bullbar'],
  ['bull bar', 'Bullbar'],
  ['nudge bar', 'Bullbar'],
  ['roof rack', 'Roof Racks'],
  ['roof racks', 'Roof Racks'],
  ['snorkel', 'Snorkel'],
]);

const DAMAGE_CANON = new Map([
  ['dent', 'Dent'],
  ['dint', 'Dent'],
  ['ding', 'Dent'],
  ['scratch', 'Scratch'],
  ['scrape', 'Scratch'],
  ['scuff', 'Scratch'],
  ['hail', 'Hail Damage'],
  ['hail damage', 'Hail Damage'],
  ['crack', 'Crack'],
  ['cracked', 'Crack'],
  ['rust', 'Rust'],
  ['paint peel', 'Paint Peel'],
  ['peeling', 'Paint Peel'],
  ['clear coat', 'Paint Peel'],
  ['burn', 'Burn'],
  ['melt', 'Melt'],
  ['heat damage', 'Melt'],
]);

const COLOUR_WORDS = [
  'white','black','silver','grey','gray','blue','red','green',
  'yellow','orange','gold','brown','beige','maroon','purple',
];

/* =========================
   Helpers
   ========================= */
function canon(raw, map) {
  const key = String(raw || '').toLowerCase();
  if (!key) return '';
  for (const [k, v] of map) if (key.includes(k)) return v;
  return key.replace(/\b\w/g, c => c.toUpperCase());
}

// tolerant JSON parser: strips ```json fences and extracts first {...}
function safeParse(text) {
  if (!text) return null;
  const s = String(text).trim();
  const unfenced = s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  const m = unfenced.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(m ? m[0] : unfenced);
  } catch {
    return null;
  }
}

// extract text from model response (handles text or base64 inlineData)
function extractModelText(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  if (!Array.isArray(parts)) return '';
  // prefer text parts
  for (const p of parts) {
    if (typeof p?.text === 'string' && p.text.trim()) return p.text;
  }
  // fallback: inlineData (may contain base64-encoded JSON string)
  for (const p of parts) {
    const b64 = p?.inlineData?.data;
    if (typeof b64 === 'string' && b64) {
      try {
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        if (decoded.trim()) return decoded;
      } catch {}
    }
  }
  return '';
}

/* =========================
   Gemini (REST v1)
   ========================= */
async function callGemini({ bytes, mimeType, caption }) {
  if (!GOOGLE_API_KEY) return { features: [], damages: [], notes: 'no_key', _raw: '{}' };

  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL_NAME}:generateContent?key=${encodeURIComponent(GOOGLE_API_KEY)}`;

  const prompt = `
Return ONLY JSON (no markdown). Schema:
{
  "features":[{"name":"", "confidence":0-1}],
  "damages":[{"name":"", "confidence":0-1, "area": "short location"}],
  "notes":"one short sentence"
}
Detect: Bullbar, Roof Racks, Snorkel; colours (White/Black/Blue/Red/Silver);
Damages: Dent, Scratch/Scuff, Hail Damage, Crack, Rust, Paint Peel, Burn/Melt.
If unsure, include with confidence 0.4–0.7.
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
        generationConfig: { temperature: 0.2 }
      })
    });

    const json = await resp.json();
    const text = extractModelText(json);
    if (!text) {
      // log whole JSON so we can inspect if needed
      audit.write({}, 'vision.error', {
        summary: 'no_text_from_model',
        out: { raw: JSON.stringify(json).slice(0, 3000) }
      });
      return { features: [], damages: [], notes: 'no_output', _raw: '{}' };
    }
    return { ...(safeParse(text) || {}), _raw: text };
  } catch (err) {
    audit.write(caption ? { caption } : {}, 'vision.error', { summary: String(err?.message || err) });
    return { features: [], damages: [], notes: 'gemini_error', _raw: '{}' };
  }
}

/* =========================
   Analyze raw bytes
   ========================= */
async function analyzeWithGemini({ bytes, mimeType = 'image/jpeg', caption = '' }, tctx) {
  if (!bytes?.length) return { features: [], damages: [], notes: 'empty' };
  if (bytes.length > MAX_BYTES) return { features: [], damages: [], notes: 'too_big' };

  const res = await callGemini({ bytes, mimeType, caption });

  const features = new Set();
  const damages = new Set();
  const inspect = new Set();
  const colours = new Set();

  for (const f of res.features || []) {
    const c = Number(f.confidence ?? 0.5);
    const name = String(f.name || '').trim();
    if (!name) continue;

    const lower = name.toLowerCase();
    if (COLOUR_WORDS.some(col => lower.includes(col))) {
      const pretty = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
      if (c >= MIN_CONF_INSPECT) colours.add(pretty);
      continue;
    }

    const featName = canon(name, FEATURE_CANON);
    if (c >= MIN_CONF_GOOD) features.add(featName);
    else if (c >= MIN_CONF_INSPECT) inspect.add(`Inspect possible ${featName}`);
  }

  for (const d of res.damages || []) {
    const c = Number(d.confidence ?? 0.5);
    const name = canon(d.name, DAMAGE_CANON);
    const area = (d.area || '').trim();
    const areaStr = area ? ` (${area})` : '';
    if (c >= MIN_CONF_GOOD) damages.add(`${name}${areaStr}`);
    else if (c >= MIN_CONF_INSPECT) inspect.add(`Inspect${area ? ' ' + area : ''} for ${name}`);
  }

  audit.write(tctx, 'vision.response', {
    summary: `gemini f:${features.size} d:${damages.size} colours:${colours.size} inspect:${inspect.size}`,
    out: {
      features: [...features],
      colours: [...colours],
      damages: [...damages],
      inspect: [...inspect],
      raw: (res._raw || '').slice(0, 3000),
    },
  });

  return {
    features: [...features],
    colours: [...colours],
    damages: [...damages],
    inspect: [...inspect],
    notes: res.notes || '',
  };
}

/* =========================
   Analyze from S3 key
   ========================= */
async function analyzeCarS3Key({ key, caption = '' }, tctx) {
  const url = await getSignedViewUrl(key, 300);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`S3 signed URL fetch ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const ext = path.extname(key).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return analyzeWithGemini({ bytes, mimeType: mime, caption }, tctx);
}

/* =========================
   Persist to DB
   ========================= */
async function enrichCarWithFindings({ carId, features = [], colours = [], damages = [], inspect = [] }, tctx) {
  const car = await Car.findById(carId);
  if (!car) throw new Error('Car not found');

  const checklist = new Set(Array.isArray(car.checklist) ? car.checklist : []);
  damages.forEach(d => checklist.add(d));
  inspect.forEach(i => checklist.add(i));

  const allowedForDescription = new Set(['Bullbar', 'Roof Racks', 'Snorkel']);
  const desc = new Set(
    String(car.description || '')
      .split(',')
      .map(s => s.trim())
      .filter(v =>
        allowedForDescription.has(v) ||
        COLOUR_WORDS.some(cw => v.toLowerCase().includes(cw))
      )
  );

  colours.forEach(c => desc.add(c));
  features.forEach(f => { if (allowedForDescription.has(f)) desc.add(f); });

  car.checklist = [...checklist];
  car.description = [...desc].join(', ');
  await car.save();

  audit.write(tctx, 'vision.enrich', {
    summary: `car:${car.rego} features:${features.length} colours:${colours.length} damages:${damages.length} inspect:${inspect.length}`,
    out: { description: car.description, checklist: car.checklist },
  });

  return { car, features, colours, damages, inspect };
}

/* =========================
   Convenience
   ========================= */
async function analyzeAndEnrichByS3Key({ carId, key, caption = '' }, tctx) {
  const r = await analyzeCarS3Key({ key, caption }, tctx);
  return enrichCarWithFindings({ carId, features: r.features, colours: r.colours, damages: r.damages, inspect: r.inspect }, tctx);
}

module.exports = {
  analyzeWithGemini,
  analyzeCarS3Key,
  enrichCarWithFindings,
  analyzeAndEnrichByS3Key,
};
