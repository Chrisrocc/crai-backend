// src/services/ai/categoryDecider.js
const audit = require('../logging/auditLogger');
const { chatJSON } = require('./llmClient');
const ReconditionerCategory = require('../../models/ReconditionerCategory');

function buildPrompt(cats) {
  const lines = cats.map(c => {
    const kws = (c.keywords || []).map(k => `"${String(k).trim().toLowerCase()}"`).join(', ');
    const rules = (c.rules || []).map(r => `- ${String(r).trim()}`).join('\n');
    const defSvc = c.defaultService ? ` (default service: "${c.defaultService}")` : '';
    return `• "${c.name}"${defSvc}\n  keywords: [${kws || ''}]\n  rules:\n${rules || '- (none)'}`;
  }).join('\n\n');

  const allowedList = cats.length ? cats.map(c => `"${c.name}"`).join(', ') : '"Other"';

  return `
You classify a short checklist line into EXACTLY ONE reconditioning category and pick a short service string.

Return STRICT minified JSON ONLY:
{"categoryName":"","service":""}

Allowed categories (case-insensitive): ${allowedList}

User-configured knowledge:
${lines || '- (no categories configured)'}
  
Rules:
- Match category by user keywords (case-insensitive). Prefer the category with the most distinct hits; tie-breaker: first in the allowed list.
- Apply user rules verbatim (they override keywords if they specify conditions).
- service: a short phrase; if not obvious, use the category's default service if provided, else derive from the text (e.g., "tail lights", "cruise control", "battery").
- If nothing matches, categoryName="Other" and service derived from text.
  `.trim();
}

/**
 * Decide a Recon category + service for a checklist one-liner.
 * @param {string} text
 * @param {*} ctx timeline/audit context
 */
async function decideCategoryForChecklist(text, ctx) {
  const cats = await ReconditionerCategory.find().lean();
  const system = buildPrompt(cats);

  audit.write(ctx, 'ai.decider.in', {
    summary: 'Category decider IN',
    system,
    user: text,
  });

  const out = await chatJSON({ system, user: text });
  audit.write(ctx, 'ai.decider.out', {
    summary: 'Category decider OUT',
    out,
  });

  const categoryName = String(out?.categoryName || 'Other').trim();
  const service = String(out?.service || '').trim();

  return { categoryName, service };
}

module.exports = { decideCategoryForChecklist };
