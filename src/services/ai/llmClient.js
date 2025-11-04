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
  OpenAI = require('openai');
} catch (_) {
  OpenAI = null;
}

const xai = (XAI_API_KEY && OpenAI)
  ? new OpenAI({ apiKey: XAI_API_KEY, baseURL: 'https://api.x.ai/v1' })
  : null;

// ---------- helpers ----------
function extractJson(s) {
  if (!s) return {};
  const m = String(s).match(/{[\s\S]*}/);
  try { return m ? JSON.parse(m[0]) : JSON.parse(s); } catch { return {}; }
}

// ---------- Gemini REST generate ----------
async function geminiGenerate(parts, genCfg = {}) {
  if (!GOOGLE_API_KEY) return '';
  const url = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GOOGLE_API_KEY)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: genCfg,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    console.warn(`Gemini REST ${resp.status}: ${t.slice(0, 400)}`);
    return '';
  }
  const j = await resp.json();
  return j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ---------- xAI JSON chat ----------
async function chatJSON({ system, user, temperature = 0 }) {
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

// ---------- Image → car / non-car photo analysis ----------
const VehicleSchema = z.object({
  make: z.string().optional().default(''),
  model: z.string().optional().default(''),
  rego: z.string().optional().default(''),
  colorDescription: z.string().optional().default(''),
  analysis: z.string().optional().default(''),
});

async function analyzeImageVehicle({ base64, mimeType }) {
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (!allowed.has(mimeType)) mimeType = 'image/jpeg';

  // --- Validate image data length ---
  if (!base64 || base64.length < 1000) {
    console.warn('⚠️ Gemini skipped: image base64 too short or missing');
    return { make: '', model: '', rego: '', colorDescription: '', analysis: '' };
  }

  const prompt = `You are analyzing a photo sent in a car yard business chat.
Return ONLY minified JSON:
{"make":"","model":"","rego":"","colorDescription":"","analysis":""}

Rules:
- If the photo clearly shows a vehicle:
  - Fill "make", "model", "rego", and "colorDescription" (e.g., "white ute with canopy", "black hatchback").
  - "rego" must be uppercase with no spaces (e.g., "XYZ789"). If unclear, "".
  - "analysis" should briefly describe the photo (e.g., "front bumper dent", "muddy", "at Haytham's").
- If the photo does NOT clearly show a vehicle (e.g., oil, parts, dash lights, tools, wheels):
  - Leave make/model/rego/colorDescription empty.
  - "analysis" should describe what it shows, short but specific:
    Examples:
    - "oil leak on floor under engine bay"
    - "fluid leak beneath front end"
    - "check engine light illuminated"
    - "dashboard light visible but unclear"
    - "set of alloy wheels"
    - "front bumper removed"
    - "engine part possibly turbocharger"
    - "pile of spare parts on floor"
- Always return valid minified JSON with exactly these 5 keys.
- Never include explanatory text outside JSON.`;

  let raw = '';
  try {
    raw = await geminiGenerate(
      [
        { inlineData: { mimeType, data: base64 } },
        { text: prompt },
      ],
      { temperature: 0.2 }
    );
  } catch (e) {
    console.warn('⚠️ Gemini request failed:', e.message);
    return { make: '', model: '', rego: '', colorDescription: '', analysis: '' };
  }

  if (!raw) {
    console.warn('⚠️ Gemini returned empty response');
    return { make: '', model: '', rego: '', colorDescription: '', analysis: '' };
  }

  const obj = extractJson(raw) || {};
  const parsed = VehicleSchema.safeParse(obj);

  if (!parsed.success) {
    console.warn('⚠️ Gemini returned invalid JSON:', raw);
    return { make: '', model: '', rego: '', colorDescription: '', analysis: '' };
  }

  const out = parsed.data;
  out.rego = (out.rego || '').replace(/\s+/g, '').toUpperCase();
  return out;
}

module.exports = {
  geminiGenerate,
  chatJSON,
  analyzeImageVehicle,
};
