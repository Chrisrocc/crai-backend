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
    })
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

  // 🔍 Improved prompt to correctly handle both car and non-car photos
  const prompt = `You are analyzing a photo sent in a car yard business chat.
Return ONLY minified JSON:
{"make":"","model":"","rego":"","colorDescription":"","analysis":""}

Step 1 — Decide: is this photo clearly showing a vehicle (whole or partial)?
- If YES, extract the visible vehicle details.
- If NO, describe what is shown in "analysis" only, and leave make/model/rego/colorDescription as "".

Rules:
- If vehicle detected:
  - "make" and "model" must be readable manufacturer/model (e.g., Toyota Corolla).
  - "rego" must be the license plate in uppercase, no spaces. If unreadable, "".
  - "colorDescription" is a short description like "white ute with canopy" or "black hatchback".
  - "analysis" is a short condition note (e.g., "front bumper dent", "at Haytham's", "muddy", "needs wash").
- If NOT a vehicle:
  - "make","model","rego","colorDescription" must stay "".
  - "analysis" must clearly describe the subject, short and specific:
    Examples:
      - "oil leak on floor under engine bay"
      - "engine oil puddle"
      - "check engine light illuminated"
      - "dashboard light visible but unclear"
      - "pile of spare parts"
      - "wheel rim with damage"
      - "removed bumper"
      - "engine bay close-up"
      - "tool box and parts on floor"
- Never output placeholder words like "Rego" or "None". If unsure, use "".
- Always return valid JSON with exactly these 5 keys.`;

  // ensure non-empty photo
  if (!base64 || base64.length < 50000) {
    console.warn('⚠️ Image too short, skipping Gemini photo analysis');
    return { make:'', model:'', rego:'', colorDescription:'', analysis:'no image detected' };
  }

  const raw = await geminiGenerate(
    [{ inlineData: { data: base64, mimeType } }, { text: prompt }],
    {}
  );

  if (!raw) {
    return { make: '', model: '', rego: '', colorDescription: '', analysis: '' };
  }

  const obj = extractJson(raw) || {};
  const parsed = VehicleSchema.safeParse(obj);
  if (!parsed.success) {
    return { make: '', model: '', rego: '', colorDescription: '', analysis: '' };
  }

  const out = parsed.data;
  out.rego = (out.rego || '').replace(/\s+/g, '').toUpperCase();

  // sanity fix: prevent nonsense "Rego" placeholder
  if (out.rego === 'REGO') out.rego = '';
  if (/^rego$/i.test(out.make)) out.make = '';
  if (/^rego$/i.test(out.model)) out.model = '';

  return out;
}

module.exports = {
  geminiGenerate,
  chatJSON,
  analyzeImageVehicle,
};
