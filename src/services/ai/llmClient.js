// src/services/ai/llmClient.js
require('dotenv').config();

const OpenAI = require('openai'); // xAI (Grok) via baseURL
const { z } = require('zod');

const XAI_API_KEY = process.env.XAI_API_KEY || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// xAI (Grok) client
const xai = XAI_API_KEY
  ? new OpenAI({ apiKey: XAI_API_KEY, baseURL: 'https://api.x.ai/v1' })
  : null;

function extractJson(s) {
  if (!s) return {};
  const m = String(s).match(/{[\s\S]*}/);
  try { return m ? JSON.parse(m[0]) : JSON.parse(s); } catch { return {}; }
}

// ---------- helper: REST generate (v1) ----------
async function geminiGenerate(parts, genCfg = {}) {
  if (!GOOGLE_API_KEY) throw new Error('Missing GOOGLE_API_KEY');
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
    throw new Error(`Gemini REST ${resp.status}: ${t}`);
  }
  const j = await resp.json();
  return j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ---------- xAI JSON chat ----------
async function chatJSON({ system, user, temperature = 0 }) {
  if (!xai) throw new Error('Missing XAI_API_KEY');
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
  return String(text)
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

  const obj = extractJson(raw) || {};
  const parsed = VehicleSchema.safeParse(obj);
  if (!parsed.success) throw new Error('Image analysis returned invalid JSON');

  const out = parsed.data;
  out.rego = (out.rego || '').replace(/\s+/g, '').toUpperCase();
  return out;
}

module.exports = { chatJSON, imageToStatements, analyzeImageVehicle };
