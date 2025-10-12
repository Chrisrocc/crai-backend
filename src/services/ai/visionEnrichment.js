// src/services/ai/visionEnrichment.js
require('dotenv').config();
const path = require('path');
const Car = require('../../models/Car');
const audit = require('../logging/auditLogger');
const { geminiGenerate } = require('./llmClient'); // REST helper (safe if no key)

// ------------------------------------------------------------------
// S3 signed URL (supports both paths used in your codebase)
let getSignedViewUrl;
try {
  ({ getSignedViewUrl } = require('../aws/s3'));
} catch {
  ({ getSignedViewUrl } = require('../../services/aws/s3'));
}

// ------------------------------------------------------------------
// Config
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_BYTES = 8 * 1024 * 1024;

// ------------------------------------------------------------------
// Utilities
function stripFencesToJson(text) {
  if (!text) return null;
  const s = String(text).trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : s); } catch { return null; }
}

function titlecase(s) {
  return String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// Final guard to ensure exact "Inspect <Issue> - <Location>"
function forceCanonicalLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return '';
  // already "Inspect X - Y"?
  if (/^inspect\s+/i.test(raw) && /-\s*/.test(raw)) {
    const [, issue, loc] = raw.match(/^inspect\s+(.+?)\s*-\s*(.+)$/i) || [];
    const i = issue ? titlecase(issue) : 'Issue';
    const l = loc ? titlecase(loc) : 'Vehicle';
    return `Inspect ${i} - ${l}`;
  }
  // try "<issue> (<loc>)"
  let m = raw.match(/^(.*?)(?:\s*\((.+)\))$/);
  if (m) {
    const i = titlecase(m[1] || 'Issue');
    const l = titlecase(m[2] || 'Vehicle');
    return `Inspect ${i} - ${l}`;
  }
  // fallback: split by common joiners
  m = raw.match(/^(.+?)\s+(?:on|at|near|for)\s+(.+)$/i) || raw.match(/^(.+?)\s*-\s*(.+)$/);
  if (m) {
    const i = titlecase(m[1] || 'Issue');
    const l = titlecase(m[2] || 'Vehicle');
    return `Inspect ${i} - ${l}`;
  }
  // last resort: only issue
  return `Inspect ${titlecase(raw)} - Vehicle`;
}

// ------------------------------------------------------------------
// Step 1: Image → rough sentences (very tolerant)
async function callGeminiRough({ bytes, mimeType, caption }) {
  if (!GOOGLE_API_KEY) return { sentences: [], _raw: '{}' };

  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL_NAME}:generateContent?key=${encodeURIComponent(GOOGLE_API_KEY)}`;
  const prompt = `
Return ONLY MINIFIED JSON (no markdown, no prose):
{"sentences":["..."]}

Goal:
- From the photo, output short rough findings (one per line). Keep them brief.
- Focus on visible damage, leaks, warning lights, fluid/oil residue, misalignments, cracked/chipped parts, missing trims, obvious accessories.
- Examples items: "scratch front left fender", "dent rear bumper lower left", "engine bay oil leak", "check engine light on".
- Max 80 items; skip non-vehicle fluff.
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
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1 } })
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

// ------------------------------------------------------------------
// Step 2: Rough list → refined canonical checklist + short description
async function aiRefineChecklist(sentences = [], hint = '') {
  const list = (Array.isArray(sentences) ? sentences : []).slice(0, 120);
  if (!list.length) return { description: '', checklist: [] };

  const prompt = `
Return ONLY minified JSON (no markdown):
{"description":"","checklist":["Inspect <Issue> - <Location>"]}

Rules:
- Every checklist item MUST be "Inspect <Damage> - <Location>" (Title Case).
- <Damage> ∈ { Dent | Scratch | Crack | Rust | Paint Peel | Hail Damage | Burn | Oil Leak | Fluid Leak | Warning Light }.
  Synonyms mapping:
    scuff/scrape/chip → Scratch
    ding/dint → Dent
    cracked → Crack
    corrosion → Rust
    clear coat/peel/peeling → Paint Peel
    hail → Hail Damage
    melt/heat damage → Burn
    check engine/engine light/ABS light/etc → Warning Light
    coolant/oil/transmission/Power steering fluid residue → Fluid Leak (or Oil Leak if clearly oil)
- <Location> short & human (e.g., "Front Left Fender", "Rear Bumper Lower Left", "Engine Bay", "Underbody", "Driver Seat", "Instrument Cluster").
- DEDUPE near duplicates; keep the clearest phrasing. Limit 50 items.
- "description" is a short comma list of exterior colour(s) and obvious accessories (Bullbar, Roof Racks, Snorkel). Keep generic.

Findings:
${list.map(x => `- ${String(x)}`).join('\n')}
${hint ? `\nHints: ${hint}\n` : ''}
`.trim();

  const text = await geminiGenerate([{ text: prompt }], { temperature: 0.1 });
  const obj = stripFencesToJson(text) || {};
  const description = String(obj.description || '').trim();
  const checklist = Array.isArray(obj.checklist) ? obj.checklist.map(forceCanonicalLine).filter(Boolean) : [];
  return { description, checklist };
}

// ------------------------------------------------------------------
// Public: analyze raw bytes → refined checklist + description
async function analyzeWithGemini({ bytes, mimeType = 'image/jpeg', caption = '' }, tctx) {
  if (!bytes?.length) return { inspect: [], notes: 'empty', features: [], colours: [], damages: [] };
  if (bytes.length > MAX_BYTES) return { inspect: [], notes: 'too_big', features: [], colours: [], damages: [] };

  // 1) image → rough
  const roughRes = await callGeminiRough({ bytes, mimeType, caption });
  const rough = roughRes.sentences;

  // 2) rough → refined
  const refined = await aiRefineChecklist(rough, caption || '');
  const inspect = Array.isArray(refined.checklist) ? refined.checklist : [];
  const description = String(refined.description || '').trim();

  audit.write(tctx, 'vision.response', {
    summary: `rough:${rough.length} refined:${inspect.length}`,
    out: { rough: rough.slice(0, 15), refinedSample: inspect.slice(0, 15), description: description.slice(0, 200) }
  });

  // We keep legacy keys (features/colours/damages) empty to avoid old logic side-effects.
  return {
    features: [],
    colours: [],
    damages: [],
    inspect,
    notes: description
  };
}

// ------------------------------------------------------------------
// S3 helper
async function analyzeCarS3Key({ key, caption = '' }, tctx) {
  const url = await getSignedViewUrl(key, 300);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`S3 signed URL fetch ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const ext = path.extname(key).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return analyzeWithGemini({ bytes, mimeType: mime, caption }, tctx);
}

// ------------------------------------------------------------------
// Persist to DB: merge description + append refined checklist
async function enrichCarWithFindings({ carId, features = [], colours = [], damages = [], inspect = [], notes = '' }, tctx) {
  const car = await Car.findById(carId);
  if (!car) throw new Error('Car not found');

  // Checklist: add refined lines (already canonical)
  const checklist = new Set(Array.isArray(car.checklist) ? car.checklist : []);
  (inspect || []).forEach(i => { const v = String(i || '').trim(); if (v) checklist.add(v); });

  // Description: merge old + refined "notes"
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

// ------------------------------------------------------------------
// Convenience combo
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
