// src/services/logging/timelineLogger.js
const { randomUUID } = require('crypto');

const _store = new Map();

function newContext({ chatId }) {
  const id = typeof randomUUID === 'function'
    ? randomUUID()
    : Math.random().toString(36).slice(2) + Date.now();
  const ctx = {
    id,
    chatId,
    sections: [],     // pretty, ordered blocks
    extracts: [],     // raw extractor dumps (kept compact)
    actions: [],      // final actions (compact)
    audit: null,      // AI audit result
  };
  _store.set(id, ctx);
  return ctx;
}

function get(idOrCtx) {
  const id = typeof idOrCtx === 'string' ? idOrCtx : idOrCtx?.id;
  return _store.get(id) || null;
}

// ---------- section helpers ----------
function section(ctx, title, lines = []) {
  const s = get(ctx); if (!s) return;
  s.sections.push({
    title,
    lines: (Array.isArray(lines) ? lines : [String(lines || '')]).filter(Boolean),
  });
}
function prompt(ctx, name, { inputText = '', outputText = '' } = {}) {
  const s = get(ctx); if (!s) return;
  s.sections.push({
    title: `PROMPT: ${name}`,
    lines: [
      '— INPUT —',
      inputText,
      '— OUTPUT —',
      outputText,
    ].filter(Boolean),
  });
}
function actions(ctx, acts = []) {
  const s = get(ctx); if (!s) return;
  s.actions = Array.isArray(acts) ? acts : [];
}
function recordAudit(ctx, auditObj) {
  const s = get(ctx); if (!s) return;
  s.audit = auditObj || null;
}

// ---------- pretty print ----------
function print(ctx) {
  const s = get(ctx); if (!s) return;

  const sep = (t) => `\n${t}\n${'─'.repeat(t.length)}\n`;
  const box = (t) => `\n${'='.repeat(t.length + 2)}\n ${t}\n${'='.repeat(t.length + 2)}\n`;

  // 1) Ordered content sections (Messages, Filter, Refine, Categorize, Prompts…)
  for (const blk of s.sections) {
    console.log(sep(blk.title));
    for (const line of blk.lines) console.log(line);
  }

  // 2) Final Actions (compact & human)
  if (s.actions.length) {
    console.log(box('FINAL OUTPUT & ACTIONS'));
    for (const a of s.actions) {
      const car = [a.rego, [a.make, a.model].filter(Boolean).join(' ')].filter(Boolean).join(' • ');
      let detail = '';
      if (a.type === 'REPAIR' && a.checklistItem) detail = `, task: ${a.checklistItem}`;
      else if (a.type === 'READY' && a.readiness) detail = `, readiness: ${a.readiness}`;
      else if (a.type === 'DROP_OFF' && a.destination) detail = `, destination: ${a.destination}`;
      else if (a.type === 'CUSTOMER_APPOINTMENT') detail = `, name: ${a.name}${a.dateTime ? `, dateTime: ${a.dateTime}` : ''}`;
      else if (a.type === 'RECON_APPOINTMENT') detail = `, category: ${a.category}${a.service ? `, service: ${a.service}` : ''}`;
      else if (a.type === 'NEXT_LOCATION' && a.nextLocation) detail = `, nextLocation: ${a.nextLocation}`;
      else if (a.type === 'TASK' && a.task) detail = `, task: ${a.task}`;
      console.log(`- ${a.type}: {${car || 'no-rego'}${detail}}`);
    }
  }

  // 3) AI AUDIT (per-action justification)
  if (s.audit && s.audit.items?.length) {
    const sum = s.audit.summary || { total: 0, correct: 0, partial: 0, incorrect: 0, unsure: 0 };
    console.log(box(`AI AUDIT — total:${sum.total} ✓${sum.correct} ~${sum.partial} ✗${sum.incorrect} ?${sum.unsure}`));
    for (const it of s.audit.items) {
      const a = s.actions[it.actionIndex];
      if (!a) continue;
      const car = [a.rego, [a.make, a.model].filter(Boolean).join(' ')].filter(Boolean).join(' • ');
      const short =
        a.type === 'REPAIR' && a.checklistItem ? `— ${a.checklistItem}` :
        a.type === 'RECON_APPOINTMENT' && (a.category || a.service) ? `— ${[a.category, a.service].filter(Boolean).join(' / ')}` :
        a.type === 'DROP_OFF' && a.destination ? `— ${a.destination}` :
        a.type === 'READY' && a.readiness ? `— ${a.readiness}` :
        a.type === 'CUSTOMER_APPOINTMENT' && a.name ? `— ${a.name}${a.dateTime ? ` @ ${a.dateTime}` : ''}` :
        a.type === 'NEXT_LOCATION' && a.nextLocation ? `— ${a.nextLocation}` :
        a.type === 'TASK' && a.task ? `— ${a.task}` : '';

      console.log(
        `- ${a.type} ${car || ''} ${short} — ${it.verdict}` +
        (it.evidenceText ? ` — evidence: "${it.evidenceText}"` : '') +
        (it.evidenceSourceIndex ? ` — from: ${it.evidenceSourceIndex}` : '')
      );
      if (it.reason) console.log(`  reason: ${it.reason}`);
    }
  }

  console.log('\n' + '═'.repeat(42) + '\n');
  _store.delete(s.id);
}

module.exports = {
  newContext,
  section,
  prompt,
  actions,
  recordAudit,
  print,
};
