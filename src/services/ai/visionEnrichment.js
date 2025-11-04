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

const lc = (s) => String(s || '').toLowerCase().trim();

function stripFencesToJson(text) {
  if (!text) return null;
  const s = String(text).trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : s); } catch { return null; }
}

function titlecase(s) {
  return String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

/* -------------------------------------------------------------------------- */
/* Canonical vocab                                                             */
/* -------------------------------------------------------------------------- */

/** Damage → canonical (keep tiny, opinionated) */
const DAMAGE_CANON = new Map([
  // dents/dints/dings
  [/^(dent|dint|ding)s?$/i, 'dint'],
  // scratches/scrapes/scuffs/chips
  [/^(scratch|scrape|scuff|chip|stone chip|chipped)s?$/i, 'scrape'],
  // cracks
  [/^(crack|cracked|fracture|split)s?$/i, 'crack'],
  // paint peel / clear coat
  [/^(paint ?peel|clear ?coat( failure)?|peel(ing)?)$/i, 'peel'],
  // rust
  [/^rust(ing)?|corrosion$/i, 'rust'],
  // leaks / fluids
  [/^oil leak$/i, 'oil leak'],
  [/^(fluid leak|coolant leak|transmission leak|power steering leak|ps fluid|leak)$/i, 'fluid leak'],
  // warning lights
  [/^(warning light|check engine|engine light|abs light|srs light)$/i, 'warning light'],
]);

/** Prioritise output ordering a little (serious → cosmetic) */
const DAMAGE_ORDER = ['crack', 'dint', 'peel', 'rust', 'oil leak', 'fluid leak', 'warning light', 'scrape'];

/** Panel synonyms → canonical panel (Australian phrasing) */
const PANEL_RULES = [
  // front bar / bumper family
  [/^(front (bar|bumper)(?: .*|)|front grille|front lower grille|grille|number plate|license plate)(.*)?$/i, 'front bar'],
  [/^front right bumper.*$/i, 'front bar'],
  [/^front left bumper.*$/i, 'front bar'],
  [/^front bumper.*$/i, 'front bar'],
  // rear bar
  [/^(rear (bar|bumper).*)$/i, 'rear bar'],
  // fenders (guards)
  [/^(front left fender|left front guard|left fender|lf fender|lf guard)$/i, 'left fender'],
  [/^(front right fender|right front guard|right fender|rf fender|rf guard)$/i, 'right fender'],
  [/^(rear left fender|left rear guard|lr fender|lr guard)$/i, 'left rear fender'],
  [/^(rear right fender|right rear guard|rr fender|rr guard)$/i, 'right rear fender'],
  // doors
  [/^(front left door|left front door)$/i, 'left front door'],
  [/^(front right door|right front door)$/i, 'right front door'],
  [/^(rear left door|left rear door)$/i, 'left rear door'],
  [/^(rear right door|right rear door)$/i, 'right rear door'],
  // bonnet / boot / tailgate
  [/^(bonnet|hood)$/i, 'bonnet'],
  [/^(boot lid|boot|trunk)$/i, 'boot lid'],
  [/^(tailgate)$/i, 'tailgate'],
  // quarters
  [/^(left quarter panel|left quarter)$/i, 'left rear fender'],
  [/^(right quarter panel|right quarter)$/i, 'right rear fender'],
  // mirrors
  [/^(left mirror|driver mirror)$/i, 'left mirror'],
  [/^(right mirror|passenger mirror)$/i, 'right mirror'],
  // generic catch
  [/^windshield|windscreen$/i, 'windscreen'],
  [/^roof$/i, 'roof'],
];

/** Sub-area noise terms we will strip (corner, lower, side etc.) */
const SUBAREA_NOISE = /\b(corner|lower|upper|side|outer|inner|edge|section|area|panel|cover|plastic|trim|bar)\b/gi;

/* -------------------------------------------------------------------------- */
/* Parsing & Normalisation                                                    */
/* -------------------------------------------------------------------------- */

function canonDamage(raw) {
  const t = lc(raw);
  if (!t) return null;

  // exact matches over regex map
  for (const [re, canon] of DAMAGE_CANON.entries()) {
    if (re.test(t)) return canon;
  }

  // contains fallbacks
  if (t.includes('dent') || t.includes('dint') || t.includes('ding')) return 'dint';
  if (t.includes('chip') || t.includes('scrape') || t.includes('scuff') || t.includes('scratch')) return 'scrape';
  if (t.includes('crack')) return 'crack';
  if (t.includes('clear coat') || t.includes('peel')) return 'peel';
  if (t.includes('rust') || t.includes('corrosion')) return 'rust';
  if (t.includes('oil') && t.includes('leak')) return 'oil leak';
  if (t.includes('leak')) return 'fluid leak';
  if (t.includes('warning') || t.includes('engine light') || t.includes('abs')) return 'warning light';

  return null;
}

function canonPanel(raw) {
  let t = lc(raw).replace(SUBAREA_NOISE, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // normalise common side codes and phrasing
  t = t.replace(/\blhs\b/g, 'left')
       .replace(/\brhs\b/g, 'right')
       .replace(/\bleft front\b/g, 'front left')
       .replace(/\bright front\b/g, 'front right')
       .replace(/\bleft rear\b/g, 'rear left')
       .replace(/\bright rear\b/g, 'rear right');

  // try direct mapping rules
  for (const [re, canon] of PANEL_RULES) {
    if (re.test(t)) return canon;
  }

  // broader heuristics
  if (/(front).*(bar|bumper|grille|plate)/.test(t)) return 'front bar';
  if (/(rear).*(bar|bumper)/.test(t)) return 'rear bar';
  if (/(front|left).*(fender|guard)/.test(t)) return t.includes('right') ? 'right fender' : 'left fender';
  if (/(right).*(fender|guard)/.test(t)) return 'right fender';

  // keep short, human
  return t;
}

/** Parse anything like:
 *  - "Inspect Scratch - Front Left Fender"
 *  - "scratch front left fender"
 *  - "dent on front bumper lower grille"
 * → { panel: 'front bar', damage: 'scrape' }
 */
function parseLineToPair(s) {
  const t = lc(s);

  // If already "Inspect X - Y", split that
  let m = t.match(/^inspect\s+(.+?)\s*-\s*(.+)$/i);
  if (m) {
    const dmg = canonDamage(m[1]);
    const pnl = canonPanel(m[2]);
    if (dmg && pnl) return { panel: pnl, damage: dmg };
  }

  // "<damage> on|at|for <panel>"
  m = t.match(/^(.+?)\s+(?:on|at|for|near)\s+(.+)$/i);
  if (m) {
    const dmg = canonDamage(m[1]);
    const pnl = canonPanel(m[2]);
    if (dmg && pnl) return { panel: pnl, damage: dmg };
  }

  // "<damage> <panel>" simple
  m = t.match(/^([a-z\s-]+?)\s+([a-z].*)$/i);
  if (m) {
    const dmg = canonDamage(m[1]);
    const pnl = canonPanel(m[2]);
    if (dmg && pnl) return { panel: pnl, damage: dmg };
  }

  // Fallback: try to guess damage, shove panel to 'vehicle'
  const dmg = canonDamage(t);
  if (dmg) return { panel: 'vehicle', damage: dmg };
  return null;
}

/* Aggregate to ONE LINE PER PANEL: "Inspect <panel>: dint, scrape, crack" */
function aggregateOneLinePerPanel(lines) {
  const bucket = new Map(); // panel -> Set(damage)
  for (const s of lines || []) {
    const p = parseLineToPair(s);
    if (!p) continue;

    // collapse hyper-specific panel bits (e.g., license plate) into front bar
    let panel = p.panel;
    if (panel === 'license plate' || /plate/.test(panel)) panel = 'front bar';

    if (!bucket.has(panel)) bucket.set(panel, new Set());
    bucket.get(panel).add(p.damage);
  }

  // Sort damages by our preference order
  const orderIdx = (d) => {
    const i = DAMAGE_ORDER.indexOf(d);
    return i === -1 ? 999 : i;
  };

  const out = [];
  for (const [panel, set] of bucket.entries()) {
    const damages = [...set].sort((a, b) => orderIdx(a) - orderIdx(b));
    if (!damages.length) continue;
    out.push(`Inspect ${panel}: ${damages.join(', ')}`);
  }
  // stable-ish: front bar first, then others alpha
  out.sort((a, b) => {
    if (a.includes('Inspect front bar:') && !b.includes('Inspect front bar:')) return -1;
    if (!a.includes('Inspect front bar:') && b.includes('Inspect front bar:')) return 1;
    return a.localeCompare(b);
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/* Model calls                                                                */
/* -------------------------------------------------------------------------- */

async function callGeminiRough({ bytes, mimeType, caption }) {
  if (!GOOGLE_API_KEY) return { sentences: [], _raw: '{}' };

  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL_NAME}:generateContent?key=${encodeURIComponent(GOOGLE_API_KEY)}`;

  const prompt = `
Return ONLY MINIFIED JSON:
{"sentences":["..."]}

Goal:
- From the vehicle photo, output very short findings like "dint front bar", "scrape left fender", "crack front bar".
- Prefer panel-level terms (front bar/bumper, left/right fender, doors, bonnet, tailgate, boot lid).
- Avoid sub-areas like "corner/side/lower grille/number plate" if possible.
- Strictly dedupe. Max 40 items.
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
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.05 } })
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

/* Rough → aggregated per-panel lines (we’ll still parse & normalise locally) */
async function aiRefineChecklist(sentences = [], hint = '') {
  // We’ll do the heavy lifting locally; the model just helps list rough findings
  const list = (Array.isArray(sentences) ? sentences : []).slice(0, 120);

  // Light dust-off with the LLM to push toward "<damage> <panel>" tokens
  // (This helps when the raw caption is flowery.)
  const prompt = `
Return ONLY minified JSON:
{"findings":["damage panel", "..."]}

Rules:
- Convert each bullet to short tokens like "dint front bar", "scrape left fender", "crack bonnet".
- Avoid sub-areas (corner/side/lower grille/number plate). Prefer panel names.
- One issue per item. Dedupe exact duplicates. Max 40 items.

Bullets:
${list.map(s => `- ${String(s)}`).join('\n')}
${hint ? `Hints: ${hint}` : ''}
`.trim();

  try {
    const text = await geminiGenerate([{ text: prompt }], { temperature: 0.05 });
    const obj = stripFencesToJson(text) || {};
    const findings = Array.isArray(obj.findings) ? obj.findings.map(x => String(x).trim()).filter(Boolean) : [];
    return { findings };
  } catch {
    return { findings: list };
  }
}

/* -------------------------------------------------------------------------- */
/* Public: analyze bytes → ONE LINE PER PANEL                                 */
/* -------------------------------------------------------------------------- */

async function analyzeWithGemini({ bytes, mimeType = 'image/jpeg', caption = '' }, tctx) {
  if (!bytes?.length) return { inspect: [], notes: 'empty', features: [], colours: [], damages: [] };
  if (bytes.length > MAX_BYTES) return { inspect: [], notes: 'too_big', features: [], colours: [], damages: [] };

  // 1) vision → rough
  const roughRes = await callGeminiRough({ bytes, mimeType, caption });
  const rough = roughRes.sentences;

  // 2) nudge to "<damage> <panel>" tokens
  const { findings } = await aiRefineChecklist(rough, caption || '');

  // 3) HARD local aggregation: ONE LINE PER PANEL
  const inspect = aggregateOneLinePerPanel(findings);

  audit.write(tctx, 'vision.response', {
    summary: `rough:${rough.length} findings:${findings.length} final:${inspect.length}`,
    out: {
      rough: rough.slice(0, 10),
      findingsSample: findings.slice(0, 10),
      finalSample: inspect.slice(0, 10)
    }
  });

  // You can add a short descriptive note later if you want; keep empty for now.
  return { features: [], colours: [], damages: [], inspect, notes: '' };
}

/* -------------------------------------------------------------------------- */
/* S3 path                                                                    */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Persist into Mongo (AI-only writer)                                        */
/* -------------------------------------------------------------------------- */

async function enrichCarWithFindings({ carId, features = [], colours = [], damages = [], inspect = [], notes = '' }, tctx) {
  const car = await Car.findById(carId);
  if (!car) throw new Error('Car not found');

  // Only AI writes here → keep user-entered formatting untouched elsewhere.
  const checklist = new Set(Array.isArray(car.checklist) ? car.checklist : []);
  (inspect || []).forEach(i => {
    const v = String(i || '').trim();
    if (v) checklist.add(v);
  });

  // (We keep notes optional/empty to avoid noisy clutter)
  car.checklist = [...checklist];
  await car.save();

  audit.write(tctx, 'vision.enrich', {
    summary: `car:${car.rego} +inspect:${inspect.length}`,
    out: { checklistSample: car.checklist.slice(0, 20) }
  });

  return { car, features, colours, damages, inspect };
}

/* Convenience: run + persist */
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
