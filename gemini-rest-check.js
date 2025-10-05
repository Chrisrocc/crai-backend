require('dotenv').config();

const key = process.env.GOOGLE_API_KEY || '';
const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
if (!key) throw new Error('NO GOOGLE_API_KEY in .env');

const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

(async () => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'say pong' }] }]
      })
    });
    const text = await res.text();
    console.log('HTTP', res.status, res.statusText);
    console.log(text);
  } catch (e) {
    console.error('REST TEST ERROR:', e.message);
  }
})();
