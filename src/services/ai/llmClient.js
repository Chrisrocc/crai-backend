// src/services/ai/llmClient.js
require("dotenv").config();
const { z } = require("zod");

// ----- fetch support (Node 18+ has global fetch; older Node needs node-fetch) -----
let fetchFn = global.fetch;
if (!fetchFn) {
  try {
    fetchFn = require("node-fetch");
  } catch (_) {
    fetchFn = null;
  }
}

// --- env ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // set in Railway Variables if you want
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// --- OpenAI SDK ---
let OpenAI = null;
try {
  OpenAI = require("openai");
} catch (_) {
  OpenAI = null;
}

const openai =
  OPENAI_API_KEY && OpenAI ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ✅ Loud startup diagnostics (these lines are what you check in Railway logs)
console.log("============================================================");
console.log("[LLM] Boot diagnostics");
console.log("[LLM] Node version:", process.version);
console.log("[LLM] OPENAI_MODEL:", OPENAI_MODEL);
console.log("[LLM] OPENAI_API_KEY present:", !!OPENAI_API_KEY);
console.log("[LLM] OPENAI_API_KEY length:", OPENAI_API_KEY.length); // SAFE: does not expose key
console.log("[LLM] OpenAI SDK loaded:", !!OpenAI);
console.log("[LLM] OpenAI client created:", !!openai);
console.log("[LLM] GOOGLE_API_KEY present:", !!GOOGLE_API_KEY);
console.log("[LLM] fetch available:", !!fetchFn);
console.log("============================================================");

// ---------- helpers ----------
function extractJson(s) {
  if (!s) return {};
  const str = String(s);
  const m = str.match(/{[\s\S]*}/);
  try {
    return m ? JSON.parse(m[0]) : JSON.parse(str);
  } catch {
    return {};
  }
}

// ---------- Gemini REST generate ----------
async function geminiGenerate(parts, genCfg = {}) {
  if (!GOOGLE_API_KEY) return "";
  if (!fetchFn) {
    console.warn("[LLM] Gemini blocked: fetch not available (Node<18 and node-fetch not installed).");
    return "";
  }

  const url = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(
    GOOGLE_API_KEY
  )}`;

  const resp = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: genCfg,
    }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    console.warn(`[LLM] Gemini REST ${resp.status}: ${t.slice(0, 400)}`);
    return "";
  }

  const j = await resp.json();
  return j?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ---------- OpenAI JSON chat ----------
async function chatJSON({ system, user, temperature = 0 }) {
  // If this triggers, your pipeline will "skip" because it gets {}
  if (!OpenAI) {
    console.warn("[LLM] chatJSON blocked: OpenAI SDK not installed/loaded.");
    return {};
  }
  if (!OPENAI_API_KEY) {
    console.warn("[LLM] chatJSON blocked: OPENAI_API_KEY missing (Railway Variables not applied to this service).");
    return {};
  }
  if (!openai) {
    console.warn("[LLM] chatJSON blocked: OpenAI client failed to init (unexpected).");
    return {};
  }

  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system ?? "" },
        { role: "user", content: user ?? "" },
      ],
    });

    const content = resp?.choices?.[0]?.message?.content || "{}";
    const out = extractJson(content);

    if (!out || typeof out !== "object" || Array.isArray(out)) {
      console.warn("[LLM] chatJSON non-object output. Raw:", String(content).slice(0, 400));
      return {};
    }

    return out;
  } catch (e) {
    console.warn("[LLM] OpenAI chatJSON error:", {
      message: e?.message,
      status: e?.status,
      code: e?.code,
      type: e?.type,
      apiError: e?.error,
    });
    return {};
  }
}

// ---------- Image → car / non-car photo analysis ----------
const VehicleSchema = z.object({
  make: z.string().optional().default(""),
  model: z.string().optional().default(""),
  rego: z.string().optional().default(""),
  colorDescription: z.string().optional().default(""),
  analysis: z.string().optional().default(""),
});

async function analyzeImageVehicle({ base64, mimeType }) {
  const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!allowed.has(mimeType)) mimeType = "image/jpeg";

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
  - "analysis" must clearly describe the subject, short and specific.
- Never output placeholder words like "Rego" or "None". If unsure, use "".
- Always return valid JSON with exactly these 5 keys.`;

  if (!base64 || base64.length < 50000) {
    console.warn("⚠️ Image too short, skipping Gemini photo analysis");
    return { make: "", model: "", rego: "", colorDescription: "", analysis: "no image detected" };
  }

  const raw = await geminiGenerate(
    [{ inlineData: { data: base64, mimeType } }, { text: prompt }],
    {}
  );

  if (!raw) {
    return { make: "", model: "", rego: "", colorDescription: "", analysis: "" };
  }

  const obj = extractJson(raw) || {};
  const parsed = VehicleSchema.safeParse(obj);
  if (!parsed.success) {
    return { make: "", model: "", rego: "", colorDescription: "", analysis: "" };
  }

  const out = parsed.data;
  out.rego = (out.rego || "").replace(/\s+/g, "").toUpperCase();

  if (out.rego === "REGO") out.rego = "";
  if (/^rego$/i.test(out.make)) out.make = "";
  if (/^rego$/i.test(out.model)) out.model = "";

  return out;
}

module.exports = {
  geminiGenerate,
  chatJSON,
  analyzeImageVehicle,
};
