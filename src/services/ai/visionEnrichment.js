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

/* -------------------------------------------------------------------------- */
/* Canon: damages & panels (exterior + interior, compact set)                 */
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
  'fluid leak': ['fluid leak', 'coolant leak', 'transmission leak', 'power steering leak', 'ps fluid', 'leak'],
  'warning light': ['warning light', 'check engine', 'engine light', 'abs light', 'srs light'],
};
const DAMAGE_LOOKUP = new Map();
for (const [canon, arr] of Object.entries(CANON_DAMAGES)) for (const k of arr) DAMAGE_LOOKUP.set(k, canon);
function canonDamage(s) {
  const t = lc(s);
  if (!t) return null;
  if (DAMAGE_LOOKUP.has(t)) return DAMAGE_LOOKUP.get(t);
  for (const [k, v] of DAMAGE_LOOKUP.entries()) if (t.includes(k)) return v;
  if (CANON_DAMAGES[t]) return t;
  return null;
}

/** Fixed ≤21 panel keys (we’ll output at most 11). */
const PANEL_KEYS = [
  // Exterior (11)
  'front bumper','bonnet','drivers front quarter','passengers front quarter',
  'drivers front door','drivers rear door','passengers front door','passengers rear door',
  'roof','boot/lid','rear bumper',
  // Interior (10, compact)
  'seats','dashboard','steering wheel','center console','gear/handbrake',
  'door trim','headliner','carpets','boot interior','infotainment',
];

/** Map lots of free-form phrases → one of PANEL_KEYS. */
const PANEL_ALIAS = [
  // --- exterior ---
  [/^front\s*(bar|bumper|bumper\s*bar|lower grille)?$/i, 'front bumper'],
  [/^rear\s*(bar|bumper|bumper\s*bar)$/i, 'rear bumper'],
  [/^(bonnet|hood)$/i, 'bonnet'],
  [/^(roof|roof\s*panel)$/i, 'roof'],
  [/^(boot|trunk|boot\s*lid|tailgate|boot\/lid|bootlid)$/i, 'boot/lid'],

  [/^(driver.?s?|lhs|left)\s*(front)?\s*(quarter|guard|fender)$/i, 'drivers front quarter'],
  [/^(passenger|rhs|right)\s*(front)?\s*(quarter|guard|fender)$/i, 'passengers front quarter'],

  [/^(driver.?s?|lhs|left)\s*front\s*door$/i, 'drivers front door'],
  [/^(driver.?s?|lhs|left)\s*rear\s*door$/i, 'drivers rear door'],
  [/^(passenger|rhs|right)\s*front\s*door$/i, 'passengers front door'],
  [/^(passenger|rhs|right)\s*rear\s*door$/i, 'passengers rear door'],

  // --- interior ---
  [/^seat(s)?|rear bench|front seats?$/i, 'seats'],
  [/^(dash|dashboard|instrument\s*panel)$/i, 'dashboard'],
  [/^(steering\s*wheel|wheel)$/i, 'steering wheel'],
  [/^(center|centre)\s*console$/i, 'center console'],
  [/^(gear\s*(lever|stick|knob)|shifter|hand\s*brake|handbrake)$/i, 'gear/handbrake'],
  [/^(door\s*(trim|card|inner|interior|lining))$/i, 'door trim'],
  [/^(headliner|roof\s*lining|roof\s*interior)$/i, 'headliner'],
  [/^(carpet(s)?|floor\s*mats?|flooring)$/i, 'carpets'],
  [/^(boot|trunk)\s*(interior|carpet|cargo\s*area)$/i, 'boot interior'],
  [/^(infotainment|screen|head\s*unit|radio)$/i, 'infotainment'],
];

/* Try to coerce any rough text into {panelKey, damage} using the above. */
function parseToPanelDamage(line) {
  const t = lc(line);
  if (!t) return null;

  // pull a coarse damage word first
  let dmg = null;
  for (const k of DAMAGE_LOOKUP.keys()) { if (t.includes(k)) { dmg = DAMAGE_LOOKUP.get(k); break; } }
  if (!dmg) { for (const k of Object.keys(CANON_DAMAGES)) if (t.includes(k)) { dmg = k; break; } }

  // find a panel via aliases
  let panelKey = null;
  for (const [re, canon] of PANEL_ALIAS) { if (re.test(line)) { panelKey = canon; break; } }

  // extra heuristics for common phrasings
  if (!panelKey) {
    if (t.includes('front bumper')) panelKey = 'front bumper';
    else if (t.includes('rear bumper')) panelKey = 'rear bumper';
    else if (t.includes('bonnet') || t.includes('hood')) panelKey = 'bonnet';
    else if (t.includes('boot') || t.includes('tailgate') || t.includes('trunk')) panelKey = 'boot/lid';
    else if (t.includes('roof')) panelKey = 'roof';
    else if (t.includes('driver') && t.includes('front') && (t.includes('door'))) panelKey = 'drivers front door';
    else if (t.includes('driver') && t.includes('rear') && (t.includes('door'))) panelKey = 'drivers rear door';
    else if ((t.includes('passenger') || t.includes('rhs') || t.includes('right')) && t.includes('front') && t.includes('door')) panelKey = 'passengers front door';
    else if ((t.includes('passenger') || t.includes('rhs') || t.includes('right')) && t.includes('rear') && t.includes('door')) panelKey = 'passengers rear door';
    else if ((t.includes('driver') || t.includes('lhs') || t.includes('left')) && (t.includes('guard') || t.includes('quarter') || t.includes('fender'))) panelKey = 'drivers front quarter';
    else if ((t.includes('passenger') || t.includes('rhs') || t.includes('right')) && (t.includes('guard') || t.includes('quarter') || t.includes('fender'))) panelKey = 'passengers front quarter';
    // interior coarse
    else if (t.includes('seat')) panelKey = 'seats';
    else if (t.includes('dash')) panelKey = 'dashboard';
    else if (t.includes('steering')) panelKey = 'steering wheel';
    else if (t.includes('console')) panelKey = 'center console';
    else if (t.includes('handbrake') || t.includes('gear')) panelKey = 'gear/handbrake';
    else if (t.includes('door') && (t.includes('trim') || t.includes('card'))) panelKey = 'door trim';
    else if (t.includes('headliner') || t.includes('roof lining')) panelKey = 'headliner';
    else if (t.includes('carpet') || t.includes('floor')) panelKey = 'carpets';
    else if (t.includes('cargo area') || t.includes('boot carpet')) panelKey = 'boot interior';
    else if (t.includes('infotainment') || t.includes('screen') || t.includes('head unit')) panelKey = 'infotainment';
  }

  if (!panelKey) return null;
  if (dmg) dmg = canonDamage(dmg) || null;
  return { panelKey, damage: dmg };
}

/** Aggregate → one line per panel, compact damage list, max 11 lines. */
function aggregateOneLinePerPanel(lines = []) {
  const bucket = new Map(); // key -> Set(damages)
  for (const s of lines) {
    const p = parseToPanelDamage(s);
    if (!p) continue;
    if (!bucket.has(p.panelKey)) bucket.set(p.panelKey, new Set());
    if (p.damage) bucket.get(p.panelKey).add(p.damage);
  }

  // deterministic order using PANEL_KEYS
  const out = [];
  for (const key of PANEL_KEYS) {
    if (!bucket.has(key)) continue;
    const ds = Array.from(bucket.get(key));
    if (!ds.length) continue;
    out.push(`Inspect ${key}: ${ds.join(', ')}`);
    if (out.length >= 11) break; // hard cap
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* LLM calls                                                                  */
/* -------------------------------------------------------------------------- */

// Step 1: Image → rough items
async function callGeminiRough({ bytes, mimeType, caption }) {
  if (!GOOGLE_API_KEY) return { sentences: [], _raw: '{}' };

  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL_NAME}:generateContent?key=${encodeURIComponent(GOOGLE_API_KEY)}`;
  const prompt = `
Return ONLY MINIFIED JSON:
{"sentences":["..."]}

Goal:
- From the vehicle photo, output short rough findings (one per bullet).
- Include EXTERIOR + INTERIOR if visible (door trim, seats, dash, wheel etc).
- Keep phrases short: "scratch front bumper", "dent bonnet", "scuff driver door trim", "tear seat".
- Skip duplicates and near-duplicates. Max 80 items.
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

// Step 2: Rough → normalized “Inspect <Panel>: d1, d2”
async function aiRefineChecklist(sentences = [], hint = '') {
  const list = (Array.isArray(sentences) ? sentences : []).slice(0, 120);
  if (!list.length) return { description: '', checklist: [] };

  // We don’t rely on LLM for final phrasing anymore; we only use it to get roughs.
  // Description can still come from LLM lightly if you want later; for now keep empty.
  return { description: '', checklist: list };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

async function analyzeWithGemini({ bytes, mimeType = 'image/jpeg', caption = '' }, tctx) {
  if (!bytes?.length) return { inspect: [], notes: 'empty', features: [], colours: [], damages: [] };
  if (bytes.length > MAX_BYTES) return { inspect: [], notes: 'too_big', features: [], colours: [], damages: [] };

  // 1) vision → rough
  const roughRes = await callGeminiRough({ bytes, mimeType, caption });
  const rough = roughRes.sentences;

  // 2) rough → (we aggregate ourselves, one line per panel)
  const refined = await aiRefineChecklist(rough, caption || '');
  const rawItems = Array.isArray(refined.checklist) ? refined.checklist : [];

  // 3) HARD aggregation: one line per panel (max 11)
  const inspect = aggregateOneLinePerPanel(rawItems);

  audit.write(tctx, 'vision.response', {
    summary: `rough:${rough.length} final:${inspect.length}`,
    out: { rough: rough.slice(0, 12), final: inspect.slice(0, 12) }
  });

  // Notes kept minimal for now
  return { features: [], colours: [], damages: [], inspect, notes: '' };
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

  // ONLY AI path adds "Inspect ..." lines.
  const checklist = new Set(Array.isArray(car.checklist) ? car.checklist : []);
  (inspect || []).forEach(i => { const v = String(i || '').trim(); if (v) checklist.add(v); });

  // merge description lightly if you later add notes text
  const desc = new Set(
    String(car.description || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );

  car.checklist = [...checklist];
  car.description = [...desc].join(', ');
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
