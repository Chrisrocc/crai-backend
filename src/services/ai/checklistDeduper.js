// Opinionated normalizer + fuzzy de-duper for checklist items.
// Final canonical form is ALWAYS: "Inspect <Damage> - <Location>"
// If no location:                   "Inspect <Damage> - vehicle"

const { chatJSON } = require('./llmClient');

// ===== Local canonicalization (unchanged core, slightly extended) =====
const SIDE_MAP = new Map([
  ['lhs', 'left'], ['left hand side', 'left'], ['left-hand side', 'left'],
  ['rhs', 'right'], ['right hand side', 'right'], ['right-hand side', 'right'],
  ['driver side', 'driver'], ['drivers side', 'driver'], ["driver's side", 'driver'],
  ['passenger side', 'passenger'],
  ['lf', 'front left'], ['rf', 'front right'], ['lr', 'rear left'], ['rr', 'rear right'],
]);

const AREA_SYNONYMS = [
  [/front\s+bumper[- ]?bar/gi, 'front bumper'],
  [/bumper[- ]?bar/gi, 'bumper'],
  [/front\s+guard/gi, 'front fender'],
  [/rear\s+guard/gi, 'rear fender'],
  [/quarter\s+panel/gi, 'rear fender'],
  [/tail[- ]?gate/gi, 'tailgate'],
  [/bootlid|boot\s*lid/gi, 'boot lid'],
  [/hood/gi, 'bonnet'],
  [/rim\b/gi, 'wheel rim'],
  [/mirror\s+cover/gi, 'mirror'],
  [/windscreen/gi, 'windshield'],
];

const ISSUE_SYNONYMS = [
  [/scuffs?/gi, 'Scratch'],
  [/scrapes?/gi, 'Scratch'],
  [/dings?|dints?/gi, 'Dent'],
  [/chips?/gi, 'Scratch'], // funnel to canonical set
  [/peel(ing)?|clear\s*coat(\s*failure)?/gi, 'Paint Peel'],
  [/hail\s*damage?/gi, 'Hail Damage'],
  [/cracks?|cracked/gi, 'Crack'],
  [/rust(ing)?/gi, 'Rust'],
  [/burn(ed|t)?|melt(ed|ing)?|heat\s*damage/gi, 'Burn'],
];

// Keep stop-words minimal so side/position terms remain for dedupe
const STOP_WORDS = new Set([
  'inspect','possible','for','the','a','an','of','and','to','on','in','at','area','near','around'
]);

function normalizeSpaces(s){ return String(s||'').replace(/\s+/g,' ').trim(); }
function titlecase(s){ return String(s||'').toLowerCase().replace(/\b\w/g,c=>c.toUpperCase()); }

function applySynonyms(text, pairs){
  let out = String(text||'');
  for (const [re, repl] of pairs) out = out.replace(re, repl);
  return out;
}

function normalizeSides(text){
  let t = String(text||'').toLowerCase();
  for (const [k, v] of SIDE_MAP) t = t.replace(new RegExp(`\\b${k}\\b`,'g'), v);
  t = t.replace(/\bleft\s+front\b/g,'front left')
       .replace(/\bright\s+front\b/g,'front right')
       .replace(/\bleft\s+rear\b/g,'rear left')
       .replace(/\bright\s+rear\b/g,'rear right');
  return t;
}

function normalizeArea(area){
  if (!area) return '';
  let a = ' ' + area + ' ';
  a = applySynonyms(a, AREA_SYNONYMS);
  a = normalizeSides(a);
  a = a.replace(/[()]/g,' ')
       .replace(/[^a-z0-9\s/-]/gi,' ')
       .replace(/\b(cover|panel|plastic)\b/gi,'')
       .replace(/\s+/g,' ')
       .trim();
  return a || 'vehicle';
}

function normalizeIssue(issue){
  if (!issue) return '';
  let i = ' ' + issue + ' ';
  i = applySynonyms(i, ISSUE_SYNONYMS);
  i = i.replace(/[^a-z0-9\s/-]/gi,' ').replace(/\s+/g,' ').trim();
  return titlecase(i);
}

/**
 * Convert any phrasing into: "Inspect <Damage> - <Location>"
 * Accepts:
 *   - "Inspect <loc> for <issue>"
 *   - "<issue> (<loc>)"
 *   - "Inspect <issue> - <loc>"
 *   - "<issue> at|on <loc>"
 *   - "<area> for <issue>"
 */
function toInspectCanonical(s){
  let t = normalizeSpaces(String(s||''));
  let issue = '', area = '';

  // "Inspect <...> for <...>"
  let m = t.match(/^inspect\s+(.*?)\s*(?:for\s+(.+))$/i);
  if (m){
    area  = normalizeArea(m[2] ? m[1] : '');
    issue = normalizeIssue(m[2] || m[1] || '');
  }

  // "<issue> (<area>)"
  if(!issue){
    m = t.match(/^(.*?)(?:\s*\((.+)\))$/);
    if (m){
      issue = normalizeIssue(m[1]);
      area  = normalizeArea(m[2]);
    }
  }

  // "<area> for <issue>" | "<issue> on|at|near <area>"
  if(!issue){
    m = t.match(/^(.*?)\s+for\s+(.+)$/i);
    if (m){
      area  = normalizeArea(m[1]);
      issue = normalizeIssue(m[2]);
    } else {
      m = t.match(/^(.+?)\s+(?:on|at|near)\s+(.+)$/i);
      if (m){
        issue = normalizeIssue(m[1]);
        area  = normalizeArea(m[2]);
      }
    }
  }

  // "<issue> - <area>"
  if(!issue){
    m = t.match(/^(.+?)\s*-\s*(.+)$/);
    if (m){
      issue = normalizeIssue(m[1]);
      area  = normalizeArea(m[2]);
    }
  }

  // Fallback “guess”
  if(!issue){
    const guess = normalizeIssue(t);
    if (guess){
      issue = guess;
      area = 'vehicle';
    }
  }

  if (!issue) issue = 'Issue';
  if (!area)  area  = 'vehicle';

  return `Inspect ${issue} - ${titlecase(area)}`;
}

function tokenize(s){
  return s.toLowerCase()
          .replace(/[^a-z0-9\s/-]/g,' ')
          .split(/\s+/)
          .filter(w=>w && !STOP_WORDS.has(w));
}

function jaccard(a,b){
  const A=new Set(a), B=new Set(b);
  const inter=[...A].filter(x=>B.has(x)).length;
  const union=new Set([...A,...B]).size;
  return union ? inter/union : 0;
}

/**
 * Normalize + fuzzy de-dupe (local).
 * @param {string[]} items
 * @param {number} threshold similarity to consider duplicates
 */
function normalizeChecklist(items, threshold=0.8){
  const canon = (Array.isArray(items)?items:[])
    .map(s=>toInspectCanonical(s))
    .filter(Boolean);

  const out=[], toks=[];
  for (const c of canon){
    const t = tokenize(c);
    let dup=false;
    for (let i=0;i<out.length;i++){
      if (jaccard(t,toks[i])>=threshold){ dup=true; break; }
    }
    if(!dup){ out.push(c); toks.push(t); }
  }
  return out;
}

// ===== AI post-processing (new) =====

function buildRefinePrompt(roughList = []) {
  const lines = (roughList || []).map(s => `- ${String(s||'').trim()}`).join('\n');
  return `
You will clean up a rough list of damage findings.

Return STRICT MINIFIED JSON ONLY:
{"sentences":["Inspect <Damage> - <Location>", ...]}

Rules:
- Every line MUST be exactly: "Inspect <Damage> - <Location>".
- <Damage> must be one of (case-sensitive): Dent, Scratch, Crack, Rust, Paint Peel, Hail Damage, Burn
  • Map synonyms: scuff/scrape -> Scratch; ding/dint -> Dent; cracked -> Crack;
    corrosion -> Rust; clear coat/peeling/peel -> Paint Peel; hail -> Hail Damage;
    melt/heat damage -> Burn
- <Location> must be a SHORT, human phrase in Title Case (e.g., "Front Left Fender", "Rear Bumper Lower Left", "Driver Door", "Wheel Rim").
- Do NOT include features/accessories/colours (e.g., bullbar, snorkel, white) as items.
- Deduplicate aggressively. If two lines are the same issue/place with different wording, keep ONE best phrasing.
- Keep list concise, maximum 50 lines.
- If nothing is valid, return {"sentences":[]}.

Rough items:
${lines || '- (none)'}
`.trim();
}

/**
 * AI refine → "Inspect <Damage> - <Location>" + dedupe, with safe fallback to local.
 * @param {string[]} roughItems
 * @returns {Promise<string[]>}
 */
async function aiRefineChecklist(roughItems){
  const items = Array.isArray(roughItems) ? roughItems.filter(Boolean) : [];
  if (items.length === 0) return [];

  // Try AI
  try {
    const system = buildRefinePrompt(items);
    const out = await chatJSON({ system, user: '' });
    const arr = Array.isArray(out?.sentences) ? out.sentences : [];
    if (arr.length) {
      // safety pass through local canonicalizer + fuzzy dedupe (idempotent)
      return normalizeChecklist(arr);
    }
  } catch (_) {
    // swallow; we'll fallback
  }
  // Fallback: local canonicalizer/dedupe directly over rough
  return normalizeChecklist(items);
}

// ===== Optional: AI description builder (colours + features only) =====
function buildDescriptionPrompt(roughList = []) {
  const lines = (roughList || []).map(s => `- ${String(s||'').trim()}`).join('\n');
  return `
Build a SHORT comma-separated vehicle description using ONLY colours and these features: Bullbar, Roof Racks, Snorkel.
Return STRICT MINIFIED JSON ONLY:
{"description":""}

Rules:
- Include colours if present (White, Black, Silver, Grey, Gray, Blue, Red, Green, Yellow, Orange, Gold, Brown, Beige, Maroon, Purple).
- Include features only if clearly implied (Bullbar, Roof Racks, Snorkel).
- Title Case each token, no duplicates, keep it brief, e.g. "White, Bullbar".
- If nothing certain, return {"description":""}.

Signals:
${lines || '- (none)'}
`.trim();
}

/**
 * AI description (colours + key features) from rough items.
 * Safe: returns "" on uncertainty or on any failure.
 * @param {string[]} roughItems
 * @returns {Promise<string>}
 */
async function aiBuildDescription(roughItems){
  const items = Array.isArray(roughItems) ? roughItems.filter(Boolean) : [];
  if (!items.length) return '';
  try {
    const system = buildDescriptionPrompt(items);
    const out = await chatJSON({ system, user: '' });
    const desc = String(out?.description || '').trim();
    return desc;
  } catch {
    return '';
  }
}

module.exports = {
  // local
  normalizeChecklist,
  toInspectCanonical,
  // ai
  aiRefineChecklist,
  aiBuildDescription,
};
