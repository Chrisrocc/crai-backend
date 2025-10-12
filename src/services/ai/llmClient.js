// src/services/ai/llmClient.js
require('dotenv').config();
const { z } = require('zod');

// --- env ---
const XAI_API_KEY = process.env.XAI_API_KEY || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// --- optional OpenAI SDK (used for xAI via baseURL) ---
let OpenAI = null;
try {
  // Only load if present; don't crash if the package isn't installed
  OpenAI = require('openai');
} catch (_) {
  OpenAI = null;
}

const xai = (XAI_API_KEY && OpenAI)
  ? new OpenAI({ apiKey: XAI_API_KEY, baseURL: 'https://api.x.ai/v1' })
  : null;

function extractJson(s) {
  if (!s) return {};
  const m = String(s).match(/{[\s\S]*}/);
  try { return m ? JSON.parse(m[0]) : JSON.parse(s); } catch { return {}; }
}

// ---------- helper: REST generate (v1) ----------
async function geminiGenerate(parts, genCfg = {}) {
  // 👉 Do NOT throw if the key is missing — just return empty
  if (!GOOGLE_API_KEY) return '';
  const url = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GOOGLE_API_KEY)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: genCfg,
    })
  });
  if (!resp.ok) {
    const t = await resp.text();
    // Don't crash the server; return empty string for callers to handle
    console.warn(`Gemini REST ${resp.status}: ${t.slice(0, 400)}`);
    return '';
  }
  const j = await resp.json();
  return j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ---------- xAI JSON chat ----------
async function chatJSON({ system, user, temperature = 0 }) {
  // 👉 Never throw due to missing deps/keys
  if (!xai) return {};
  try {
    const resp = await xai.chat.completions.create({
      model: 'grok-2-latest',
      temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system ?? '' },
        { role: 'user', content: user ?? '' },
      ],
    });
    const content = resp.choices?.[0]?.message?.content || '{}';
    return extractJson(content);
  } catch (e) {
    console.warn('xAI chatJSON error:', e.message);
    return {};
  }
}

// ---------- Optional: image → plain statements ----------
async function imageToStatements({ base64, mimeType }) {
  const prompt = `Read any legible vehicle-related statements from this image (yard board, note, etc.).
Return plain text, one statement per line. Example:
XYZ789 Toyota Corolla is at Unique
Ford Falcon LMN456 is sold`;
  const text = await geminiGenerate(
    [{ inlineData: { data: base64, mimeType } }, { text: prompt }],
    {}
  );
  return String(text || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

// ---------- Image → structured vehicle info ----------
const VehicleSchema = z.object({
  make: z.string().optional().default(''),
  model: z.string().optional().default(''),
  rego: z.string().optional().default(''),
  color: z.string().optional().default(''),
});

async function analyzeImageVehicle({ base64, mimeType }) {
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (!allowed.has(mimeType)) mimeType = 'image/jpeg';

  const prompt = `Extract vehicle details from this image. Return ONLY minified JSON:
{"make":"","model":"","rego":"","color":""}
- "rego" must be uppercase with no spaces (e.g., "XYZ789"). If unclear, "".
- Proper-case make/model if possible; else "".
- Color is optional best-guess; else "".
`;

  const raw = await geminiGenerate(
    [{ inlineData: { data: base64, mimeType } }, { text: prompt }],
    {}
  );

  // If no Gemini key/output, return a harmless fallback
  if (!raw) return { make: '', model: '', rego: '', color: '' };

  const obj = extractJson(raw) || {};
  const parsed = VehicleSchema.safeParse(obj);
  if (!parsed.success) return { make: '', model: '', rego: '', color: '' };

  const out = parsed.data;
  out.rego = (out.rego || '').replace(/\s+/g, '').toUpperCase();
  return out;
}

module.exports = { chatJSON, imageToStatements, analyzeImageVehicle };
module.exports = { geminiGenerate, chatJSON, imageToStatements, analyzeImageVehicle };

