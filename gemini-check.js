require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const key = process.env.GOOGLE_API_KEY || '';
if (!key) {
  console.error('NO GOOGLE_API_KEY in .env');
  process.exit(1);
}

// Force v1 API and use your env model (fallback to flash)
const gen = new GoogleGenerativeAI({ apiKey: key, apiVersion: 'v1' });
const model = gen.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' });

(async () => {
  try {
    const r = await model.generateContent('say pong');
    console.log(r.response.text());
  } catch (e) {
    console.error('TEST ERROR:', e.message);
  }
})();
