// src/services/ai/qa/qaCheck.js
// Compact QA pass that returns human-readable one-liners (OK / FLAG).

function groupBy(arr, fn) {
  return (arr || []).reduce((m, x) => {
    const k = fn(x);
    (m[k] ||= []).push(x);
    return m;
  }, {});
}

function toKey(a) {
  return [
    (a.rego || '').toUpperCase(),
    (a.make || '').trim(),
    (a.model || '').trim(),
    (a.type || '').trim(),
  ].join('|');
}

module.exports.audit = async function audit({ categorized = [], actions = [] }) {
  const lines = [];

  // 1) Basic validation + succinct OK lines
  for (const a of actions || []) {
    const rego = (a.rego || '').toUpperCase() || '—';
    switch (a.type) {
      case 'REPAIR': {
        const task = a.checklistItem || 'repair';
        lines.push(`OK • REPAIR • ${rego} — ${task}`);
        break;
      }
      case 'RECON_APPOINTMENT': {
        const cat = a.category || 'Uncategorized';
        const svc = a.service ? ` • ${a.service}` : '';
        lines.push(`OK • RECON_APPOINTMENT • ${rego} — ${cat}${svc}`);
        break;
      }
      case 'LOCATION_UPDATE': {
        lines.push(`OK • LOCATION_UPDATE • ${rego} — ${a.location || 'unknown'}`);
        break;
      }
      case 'CUSTOMER_APPOINTMENT': {
        lines.push(`OK • CUSTOMER_APPOINTMENT • ${rego} — ${(a.name || '—')} @ ${(a.dateTime || '—')}`);
        break;
      }
      case 'READY':
        lines.push(`OK • READY • ${rego}`);
        break;
      case 'DROP_OFF':
        lines.push(`OK • DROP_OFF • ${rego} → ${a.destination || '—'}`);
        break;
      case 'NEXT_LOCATION':
        lines.push(`OK • NEXT_LOCATION • ${rego} → ${a.nextLocation || '—'}`);
        break;
      case 'TASK':
        lines.push(`OK • TASK • ${rego} — ${a.task || '—'}`);
        break;
      case 'SOLD':
        lines.push(`OK • SOLD • ${rego}`);
        break;
      default:
        lines.push(`OK • ${a.type || 'UNKNOWN'} • ${rego}`);
    }
  }

  // 2) Duplicate recon category for same rego
  const reconByRego = groupBy(
    (actions || []).filter(a => a.type === 'RECON_APPOINTMENT'),
    a => (a.rego || '').toUpperCase()
  );
  for (const [rego, list] of Object.entries(reconByRego)) {
    const uniqueCats = [...new Set(list.map(x => x.category || ''))].filter(Boolean);
    if (uniqueCats.length > 1) {
      lines.push(`FLAG • RECON_APPOINTMENT • ${rego || '—'} — POSSIBLE_DUPLICATE (${uniqueCats.join(' vs ')})`);
    }
  }

  // 3) Exact duplicate action objects (type+rego+make+model) — likely repeats
  const seen = new Map();
  for (const a of actions || []) {
    const k = toKey(a);
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  for (const [k, n] of seen.entries()) {
    if (n > 1) {
      const [rego, make, model, type] = k.split('|');
      lines.push(`FLAG • ${type} • ${rego || '—'} — DUPLICATE (${make} ${model})`);
    }
  }

  return { lines };
};
