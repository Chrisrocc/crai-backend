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

/* -------------------------------------------------------------------------- */
/* utils                                                                      */
/* -------------------------------------------------------------------------- */

function stripFencesToJson(text) {
  if (!text) return null;
  const s = String(text).trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : s); } catch { return null; }
}
const lc = (s) => String(s || '').toLowerCase().trim();
const title = (s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());

/* -------------------------------------------------------------------------- */
/* Canon sets                                                                 */
/* -------------------------------------------------------------------------- */

// <= 11 canonical panels (short & unambiguous)
const PANELS = [
  'front bumper',
  'bonnet',
  'driver front quarter',
  'passenger front quarter',
  'driver front door',
  'driver rear door',
  'passenger front door',
  'passenger rear door',
  'roof',
  'boot lid',
  'rear bumper',
];

// AU context: driver = right, passenger = left (still accept the words explicitly)
const PANEL_SYNONYMS = [
  // bumper
  [/front\s*(bumper|bar|bumper\s*bar)/gi, 'front bumper'],
  [/rear\s*(bumper|bar|bumper\s*bar)/gi, 'rear bumper'],
  // bonnet/boot
  [/hood/gi, 'bonnet'],
  [/boot\s*lid|bootlid|trunk\s*lid|tail\s*gate|tailgate/gi, 'boot lid'],
  // quarters (guards/fenders/wings)
  [/\b(driver'?s?\s+side|rhs|right\s*hand\s*side)\b.*(front\s+(guard|fender|wing)|front\s+quarter)/gi, 'driver front quarter'],
  [/\b(passenger'?s?\s+side|lhs|left\s*hand\s*side)\b.*(front\s+(guard|fender|wing)|front\s+quarter)/gi, 'passenger front quarter'],
  [/\bfront\s+(right|driver|rhs)\b.*(guard|fender|wing|quarter)/gi, 'driver front quarter'],
  [/\bfront\s+(left|passenger|lhs)\b.*(guard|fender|wing|quarter)/gi, 'passenger front quarter'],
  // doors
  [/\b(driver|rhs|right)\b.*front\s+door/gi, 'driver front door'],
  [/\b(driver|rhs|right)\b.*rear\s+door/gi, 'driver rear door'],
  [/\b(passenger|lhs|left)\b.*front\s+door/gi, 'passenger front door'],
  [/\b(passenger|lhs|left)\b.*rear\s+door/gi, 'passenger rear door'],
  // simple sides when model just says "left/right door" (assume front if not stated)
  [/\b(right|driver|rhs)\s+door\b/gi, 'driver front door'],
  [/\b(left|passenger|lhs)\s+door\b/gi, 'passenger front door'],
  // roof
  [/roof/gi, 'roof'],
];

const DAMAGE_CANON = [
  'dent', 'scratch', 'crack', 'rust', 'paint peel', 'hail damage',
  'burn', 'oil leak', 'fluid leak', 'warning light'
];
const DAMAGE_SYNONYMS = [
  [/dings?|dints?/gi, 'dent'],
  [/scrapes?|scuffs?|chips?/gi, 'scratch'],
  [/cracks?|cracked/gi, 'crack'],
  [/corrosion|rust(ed|ing)?/gi, 'rust'],
  [/clear\s*coat(\s*fail(ure)?)?|peel(ing)?/gi, 'paint peel'],
  [/hail(\s*damage)?/gi, 'hail damage'],
  [/burn(t|ed)?|melt(ed|ing)?|heat\s*damage/gi, 'burn'],
  [/\b(engine\s*)?oil\s*leak(s)?\b/gi, 'oil leak'],
  [/\b(coolant|trans( |)fluid|power\s*steering|ps)\s*leak(s)?\b|\bfluid\s*leak(s)?\b/gi, 'fluid leak'],
  [/(check\s*engine|mil|abs|srs|warning\s*light)/gi, 'warning light'],
];

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

function mapDamage(s) {
  if (!s) return null;
  let t = ' ' + lc(s) + ' ';
  for (const [re, repl] of DAMAGE_SYNONYMS) t = t.replace(re, ` ${repl} `);
  t = t.replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  // pick first that appears in our canon list
  for (const d of DAMAGE_CANON) if (t.includes(d)) return d;
  // last fallback: single word guess
  const w = t.split(' ').find(x => DAMAGE_CANON.includes(x));
  return w || null;
}

function mapPanel(s) {
  if (!s) return null;
  let t = ' ' + lc(s) + ' ';
  // normalize side words first to improve regex hits
  t = t
    .replace(/\bleft\s+front\b/g, 'front left')
    .replace(/\bright\s+front\b/g, 'front right')
    .replace(/\bleft\s+rear\b/g, 'rear left')
    .replace(/\bright\s+rear\b/g, 'rear right');

  for (const [re, repl] of PANEL_SYNONYMS) {
    if (re.test(t)) return repl;
  }

  // simple contains as a last resort
  if (/\bfront\b.*\bbumper\b/.test(t)) return 'front bumper';
  if (/\brear\b.*\bbumper\b/.test(t)) return 'rear bumper';
  if (/\bhood|bonnet\b/.test(t)) return 'bonnet';
  if (/\broof\b/.test(t)) return 'roof';
  if (/\bboot|trunk|tailgate\b/.test(t)) return 'boot lid';

  // doors, coarse fallback
  if (/\bright|driver|rhs\b/.test(t) && /\bdoor\b/.test(t)) return 'driver front door';
  if (/\bleft|passenger|lhs\b/.test(t) && /\bdoor\b/.test(t)) return 'passenger front door';

  return null; // unknown -> ignore; prevents random noisy panels
}

/* -------------------------------------------------------------------------- */
/* Gemini calls                                                               */
/* -------------------------------------------------------------------------- */

// Step 1: image → rough short findings
async function callGeminiRough({ bytes, mimeType, caption }) {
  if (!GOOGLE_API_KEY) return { sentences: [], _raw: '{}' };

  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL_NAME}:generateContent?key=${encodeURIComponent(GOOGLE_API_KEY)}`;
  const prompt = `
Return ONLY MINIFIED JSON:
{"sentences":["..."]}

Task:
- From the vehicle photo, output very short rough findings (max 40).
- Format like: "scratch front bumper", "dent bonnet", "crack front bumper lower grill".
- Focus ONLY on obvious visible DAMAGE (skip accessories).
- No duplicates; be conservative if unsure.
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

/* -------------------------------------------------------------------------- */
/* Aggregation: 1 line per canonical panel                                    */
/* -------------------------------------------------------------------------- */

function aggregateToFixedPanels(sentences = []) {
  const perPanel = new Map(); // panel -> Set(damages)
  for (const raw of (sentences || [])) {
    const s = lc(raw);
    // try patterns: "<damage> ... <panel>" or "inspect <damage> - <panel>"
    // Extract a damage token first
    let dmg = mapDamage(s);
    if (!dmg) continue;

    // naive panel hint: everything after damage word
    const idx = s.indexOf(dmg);
    const after = idx >= 0 ? s.slice(idx + dmg.length) : s;
    const pnl = mapPanel(after) || mapPanel(s);
    if (!pnl) continue;

    if (!perPanel.has(pnl)) perPanel.set(pnl, new Set());
    perPanel.get(pnl).add(dmg);
  }

  // Build final one-liners in a stable panel order
  const lines = [];
  for (const pnl of PANELS) {
    const set = perPanel.get(pnl);
    if (!set || set.size === 0) continue;
    const list = Array.from(set);
    // sort damages by our canon order for consistency
    list.sort((a, b) => DAMAGE_CANON.indexOf(a) - DAMAGE_CANON.indexOf(b));
    lines.push(`Inspect ${title(pnl)}: ${list.join(', ')}`);
  }
  return lines;
}

/* -------------------------------------------------------------------------- */
/* Public analyze → aggregate → enrich                                         */
/* -------------------------------------------------------------------------- */

async function analyzeWithGemini({ bytes, mimeType = 'image/jpeg', caption = '' }, tctx) {
  if (!bytes?.length) return { inspect: [], notes: 'empty', features: [], colours: [], damages: [] };
  if (bytes.length > MAX_BYTES) return { inspect: [], notes: 'too_big', features: [], colours: [], damages: [] };

  // 1) vision → rough
  const roughRes = await callGeminiRough({ bytes, mimeType, caption });
  const rough = roughRes.sentences;

  // 2) aggregate strictly to fixed panel list
  const inspect = aggregateToFixedPanels(rough);

  // ultra-short notes not important here
  const description = '';

  audit.write(tctx, 'vision.response', {
    summary: `rough:${rough.length} final:${inspect.length}`,
    out: {
      sampleIn: rough.slice(0, 12),
      sampleOut: inspect.slice(0, 12)
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

  // Only AI path adds "Inspect ..." lines.
  const checklist = new Set(Array.isArray(car.checklist) ? car.checklist : []);
  (inspect || []).forEach(i => { const v = String(i || '').trim(); if (v) checklist.add(v); });

  // keep description unchanged; AI notes omitted to avoid noise
  car.checklist = [...checklist];
  await car.save();

  audit.write(tctx, 'vision.enrich', {
    summary: `car:${car.rego} +inspect:${inspect.length}`,
    out: { checklistSample: car.checklist.slice(0, 20) }
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
