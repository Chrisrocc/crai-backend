// src/services/ai/visionEnrichment.js
require('dotenv').config();
const path = require('path');
const Car = require('../../models/Car');
const audit = require('../logging/auditLogger');
const { normalizeChecklist } = require('./checklistDeduper');
const { aiDedupeAndFormat } = require('./checklistPostprocess');

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

const MAX_BYTES = 8 * 1024 * 1024;

/* =========================
   Description extraction (local, simple)
   ========================= */
const COLOUR_WORDS = [
  'white','black','silver','grey','gray','blue','red','green',
  'yellow','orange','gold','brown','beige','maroon','purple',
];
const FEATURE_KEYS = [
  { key: 'bullbar', variants: ['bull bar', 'nudge bar'], label: 'Bullbar' },
  { key: 'roof rack', variants: ['roof racks'], label: 'Roof Racks' },
  { key: 'snorkel', variants: [], label: 'Snorkel' },
];

function titlecase(s){ return String(s||'').toLowerCase().replace(/\b\w/g,c=>c.toUpperCase()); }

function extractColoursAndFeatures(roughLines = [], caption = '') {
  const colours = new Set();
  const features = new Set();
  const haystack = [...(roughLines || []), caption].map(s => String(s||'').toLowerCase());

  for (const line of haystack) {
    for (const cw of COLOUR_WORDS) {
      if (line.includes(cw)) colours.add(titlecase(cw));
    }
    for (const f of FEATURE_KEYS) {
      if (line.includes(f.key) || f.variants.some(v => line.includes(v))) {
        features.add(f.label);
      }
    }
  }
  return { colours: [...colours], features: [...features] };
}

/* =========================
   Helpers
   ========================= */
// tolerant JSON parser: strips ```json fences and extracts first {...}
function safeParse(text) {
  if (!text) return null;
  const s = String(text).trim();
  const unfenced = s.replace(/^```(?:json)?\s*/i,'').replace(/```$/,'').trim();
  const m = unfenced.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : unfenced); } catch { return null; }
}

// extract text from model response (handles text or base64 inlineData)
function extractModelText(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  if (!Array.isArray(parts)) return '';
  for (const p of parts) {
    if (typeof p?.text === 'string' && p.text.trim()) return p.text;
  }
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
   Gemini (REST v1): images -> rough lines
   ========================= */
async function callGemini({ bytes, mimeType, caption }) {
  if (!GOOGLE_API_KEY) return { sentences: [], _raw: '{}' };

  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL_NAME}:generateContent?key=${encodeURIComponent(GOOGLE_API_KEY)}`;

  const prompt = `
Return ONLY MINIFIED JSON (no markdown, no extra fields) as:
{"sentences":["...", "..."]}

Goal: Convert the photo into a list of short, rough findings (one per line).
Don't explain; just the array. The items can be rough like:
"scratch front left fender", "dent rear bumper lower left", "bullbar", "white paint".
Keep max 80 items and keep each item short.
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
      audit.write({}, 'vision.error', {
        summary: 'no_text_from_model',
        out: { raw: JSON.stringify(json).slice(0, 3000) }
      });
      return { sentences: [], _raw: '{}' };
    }
    return { ...(safeParse(text) || {}), _raw: text };
  } catch (err) {
    audit.write(caption ? { caption } : {}, 'vision.error', { summary: String(err?.message || err) });
    return { sentences: [], _raw: '{}' };
  }
}

/* =========================
   Analyze raw bytes
   ========================= */
async function analyzeWithGemini({ bytes, mimeType = 'image/jpeg', caption = '' }, tctx) {
  if (!bytes?.length) return { features: [], colours: [], damages: [], inspect: [], notes: 'empty' };
  if (bytes.length > MAX_BYTES) return { features: [], colours: [], damages: [], inspect: [], notes: 'too_big' };

  // 1) Vision → rough lines
  const res = await callGemini({ bytes, mimeType, caption });
  const rough = Array.isArray(res.sentences) ? res.sentences : [];

  // 2) Build checklist via one AI post-process step
  const cleaned = await aiDedupeAndFormat(rough);
  const inspect = normalizeChecklist(cleaned); // idempotent guard

  // 3) Local description extraction (colours + selected features)
  const { colours, features } = extractColoursAndFeatures(rough, caption);

  audit.write(tctx, 'vision.response', {
    summary: `vision->rough:${rough.length} postprocess->inspect:${inspect.length} colours:${colours.length} features:${features.length}`,
    out: {
      rough: rough.slice(0, 20),
      inspect: inspect.slice(0, 20),
      colours, features,
      raw: (res._raw || '').slice(0, 2000)
    },
  });

  return { features, colours, damages: [], inspect, notes: '' };
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

  // Checklist (damage): merge + normalize + de-dupe
  const mergedChecklist = [
    ...(Array.isArray(car.checklist) ? car.checklist : []),
    ...inspect,
  ];
  car.checklist = normalizeChecklist(mergedChecklist);

  // Description (colours + selected features): dedupe and keep concise
  const allowedForDescription = new Set(['Bullbar', 'Roof Racks', 'Snorkel']);
  const descSet = new Set(
    String(car.description || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );
  colours.forEach(c => descSet.add(c));
  features.forEach(f => { if (allowedForDescription.has(f)) descSet.add(f); });

  car.description = [...descSet].join(', ');
  await car.save();

  audit.write(tctx, 'vision.enrich', {
    summary: `car:${car.rego} checklist:+${inspect.length} desc(+colours:${colours.length}, +features:${features.length})`,
    out: { description: car.description, checklist: car.checklist },
  });

  return { car, features, colours, damages, inspect };
}

/* =========================
   Convenience
   ========================= */
async function analyzeAndEnrichByS3Key({ carId, key, caption = '' }, tctx) {
  const r = await analyzeCarS3Key({ key, caption }, tctx);
  return enrichCarWithFindings({
    carId,
    features: r.features,
    colours: r.colours,
    damages: r.damages,
    inspect: r.inspect
  }, tctx);
}

module.exports = {
  analyzeWithGemini,
  analyzeCarS3Key,
  enrichCarWithFindings,
  analyzeAndEnrichByS3Key,
};
