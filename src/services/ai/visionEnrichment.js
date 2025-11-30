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

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_BYTES = 8 * 1024 * 1024;
const CONF_THRESHOLD = 0.9; // only keep very confident items

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
/* Gemini call: structured damage items                                       */
/* -------------------------------------------------------------------------- */

/**
 * Ask Gemini to return structured damage items.
 * Shape:
 * {
 *   "items": [
 *     {
 *       "area": "exterior" | "interior",
 *       "section": "front bumper",
 *       "damage": "scratch",
 *       "confidence": 0.95
 *     }
 *   ]
 * }
 */
async function callGeminiDamageSummary({ bytes, mimeType, caption }) {
  if (!GOOGLE_API_KEY) {
    return { items: [], _raw: '{}' };
  }

  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL_NAME}:generateContent?key=${encodeURIComponent(
    GOOGLE_API_KEY
  )}`;

  const prompt = `
Return ONLY MINIFIED JSON in this exact shape:
{"items":[{"area":"exterior","section":"front bumper","damage":"scratch","confidence":0.98}]}

Rules:
- Look for CLEAR, OBVIOUS damage only. If unsure, DO NOT include it.
- Each item:
  - "area": "exterior" or "interior".
  - "section": a short human phrase ("front bumper", "rear window", "steering wheel").
  - "damage": a short word/phrase ("scratch","dent","crack","tear","paint peel","scuff","chip","wear").
  - "confidence": number between 0 and 1 (1.0 = absolutely certain).
- Prefer FEWER, very confident items over many guesses.
- If you cannot see any damage clearly, return {"items": []}.
- Max 15 items.
`.trim();

  const parts = [
    { text: prompt },
    { text: caption ? `Caption hint: ${caption}` : 'No caption' },
    {
      inlineData: {
        mimeType,
        data: Buffer.from(bytes).toString('base64'),
      },
    },
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
      json?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text ||
      '';
    const obj = stripFencesToJson(text) || {};
    const items = Array.isArray(obj.items) ? obj.items : [];

    return { items, _raw: text || JSON.stringify(json).slice(0, 2000) };
  } catch (err) {
    audit.write(caption ? { caption } : {}, 'vision.error', {
      summary: String(err?.message || err),
    });
    return { items: [], _raw: '{}' };
  }
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

  // 1) vision → structured damage items
  const { items, _raw } = await callGeminiDamageSummary({
    bytes,
    mimeType,
    caption,
  });

  // 2) keep only high-confidence items
  const high = (Array.isArray(items) ? items : []).filter((it) => {
    const c = typeof it.confidence === 'number' ? it.confidence : null;
    const label = lc(it.confidence);
    if (c !== null) return c >= CONF_THRESHOLD;
    if (label === 'high' || label === 'certain') return true;
    return false;
  });

  // 3) Build two grouped lines only: Exterior: ..., Interior: ...
  const extParts = [];
  const intParts = [];

  for (const it of high) {
    const area = lc(it.area);
    const section = String(it.section || '').trim();
    const damage = String(it.damage || '').trim();
    if (!section && !damage) continue;

    const frag = section && damage ? `${section} - ${damage}` : section || damage;

    if (area === 'interior') {
      intParts.push(frag);
    } else {
      // default to exterior if not clearly labelled
      extParts.push(frag);
    }
  }

  const inspect = [];
  if (extParts.length) {
    inspect.push(`Exterior: ${extParts.join(', ')}`);
  }
  if (intParts.length) {
    inspect.push(`Interior: ${intParts.join(', ')}`);
  }

  audit.write(tctx, 'vision.response', {
    summary: `raw:${items.length} high:${high.length} ext:${extParts.length} int:${intParts.length}`,
    out: {
      sampleRaw: items.slice(0, 10),
      exteriorLine: inspect[0] || '',
      interiorLine: inspect[1] || '',
      rawSnippet: _raw?.slice ? _raw.slice(0, 400) : '',
    },
  });

  // features/colours/damages left empty for now; only checklist matters.
  return {
    features: [],
    colours: [],
    damages: [],
    inspect,
    notes: '',
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

  // Only AI path adds "Exterior: ..." / "Interior: ..." lines.
  const checklist = new Set(Array.isArray(car.checklist) ? car.checklist : []);
  (inspect || []).forEach((i) => {
    const v = String(i || '').trim();
    if (v) checklist.add(v);
  });

  // Description untouched for now
  car.checklist = [...checklist];
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
