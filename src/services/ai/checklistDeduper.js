// Opinionated normalizer + fuzzy de-duper for checklist items.
// Final canonical form is ALWAYS: "Inspect <Damage> - <Location>"
// If no location:                   "Inspect <Damage> - vehicle"

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
  [/chips?/gi, 'Scratch'],                 // keep inside canonical set
  [/peel(ing)?|clear\s*coat(\s*failure)?/gi, 'Paint Peel'],
  [/hail\s*damage?/gi, 'Hail Damage'],
  [/cracks?|cracked/gi, 'Crack'],
  [/rust(ing)?/gi, 'Rust'],
  [/burn(ed|t)?|melt(ed|ing)?|heat\s*damage/gi, 'Burn'],
];

// Keep stop-words minimal so location terms (front/rear/left/right/driver/passenger)
// REMAIN in the token set and affect dedupe.
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
 * Normalize + fuzzy de-dupe.
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

module.exports = { normalizeChecklist, toInspectCanonical };
