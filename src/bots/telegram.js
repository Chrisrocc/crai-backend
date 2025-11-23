require('dotenv').config();
const { Telegraf } = require('telegraf');

const { Batcher } = require('../services/batcher');
const { processBatch } = require('../services/ai/pipeline');

const {
  applyLocationUpdate,
  applySold,
  addChecklistItem,
  setReadinessStatus,
  setNextLocation,
  ensureCarForAction,
} = require('../services/updaters/carUpdater');

const { createDropOffTask, createGenericTask } = require('../services/creators/taskCreator');
const { createCustomerAppointment } = require('../services/creators/customerAppointmentCreator');
const { createReconditionerAppointment } = require('../services/creators/reconAppointmentCreator');

const { analyzeImageVehicle } = require('../services/ai/llmClient');
const timeline = require('../services/logging/timelineLogger');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');

const bot = new Telegraf(BOT_TOKEN);

/* ----------------------------------------------------------------
   Silence / notify controls
---------------------------------------------------------------- */
const SILENT_ALL_GROUPS = String(process.env.TELEGRAM_SILENT_ALL_GROUPS || 'true').toLowerCase() === 'true';
const SILENT_GROUP_IDS = new Set(
  (process.env.TELEGRAM_SILENT_GROUP_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';

function isGroupChatId(id) {
  const n = Number(id);
  return Number.isFinite(n) && n < 0;
}

function shouldSilenceChat(chat) {
  const id = chat?.id;
  if (SILENT_GROUP_IDS.has(String(id))) return true;
  if (SILENT_ALL_GROUPS && isGroupChatId(id)) return true;
  return false;
}

async function safeReply(ctx, text, extra) {
  try {
    if (shouldSilenceChat(ctx.chat)) {
      if (ADMIN_CHAT_ID) {
        await bot.telegram.sendMessage(ADMIN_CHAT_ID, `[#${ctx.chat?.id}] ${text}`, extra);
      }
      return;
    }
    await ctx.reply(text, extra);
  } catch (e) {
    console.warn('[telegram] safeReply failed:', e.message);
  }
}

async function notifyChatOrAdmin(chatId, text, extra) {
  try {
    const silent = SILENT_GROUP_IDS.has(String(chatId)) || (SILENT_ALL_GROUPS && isGroupChatId(chatId));
    if (silent) {
      if (ADMIN_CHAT_ID) {
        await bot.telegram.sendMessage(ADMIN_CHAT_ID, `[#${chatId}] ${text}`, extra);
      }
      return;
    }
    await bot.telegram.sendMessage(chatId, text, extra);
  } catch (e) {
    console.warn('[telegram] notifyChatOrAdmin failed:', e.message);
  }
}

/* ----------------------------------------------------------------
   Rego debug stores
   - lastRegoLogByChat: log lines from ensureCarForAction
   - lastRegoMapByChat: { rawRego -> canonicalRego } per chat
---------------------------------------------------------------- */
const lastRegoLogByChat = new Map(); // chatId -> [lines]
const lastRegoMapByChat = new Map(); // chatId -> { RAW -> CANONICAL }

/* ----------------------------------------------------------------
   Batch window (1 minute)
---------------------------------------------------------------- */
const batcher = new Batcher({
  windowMs: 60_000,
  onFlush: async (chatId, messages) => {
    const tctx = timeline.newContext({ chatId });
    const { actions } = await processBatch(messages, tctx);

    const out = [];

    // 🔁 Step 0: normalize regos based on photo OCR → DB mapping
    const regoMap = lastRegoMapByChat.get(chatId) || null;
    const regoNormLines = [];

    if (regoMap) {
      for (const a of actions) {
        if (a.rego) {
          const key = String(a.rego).toUpperCase().replace(/\s+/g, '');
          const mapped = regoMap[key];
          if (mapped && mapped !== a.rego) {
            regoNormLines.push(`🔁 Rego normalized for ${a.type}: ${a.rego} → ${mapped}`);
            a.rego = mapped;
          }
        }
      }
      lastRegoMapByChat.delete(chatId);
    }

    // 4️⃣ Apply actions to DB
    for (const a of actions) {
      try {
        let msg = '';
        switch (a.type) {
          case 'LOCATION_UPDATE': {
            const r = await applyLocationUpdate(a, tctx);
            msg = r.changed
              ? `✅ ${r.car.rego} location: "${r.previousLocation || '-'}" → "${r.car.location}"`
              : `ℹ️ ${r.car.rego} already at "${r.car.location}"`;
            break;
          }
          case 'SOLD': {
            const r = await applySold(a, tctx);
            msg = r.changed ? `✅ ${r.car.rego} marked Sold` : `ℹ️ ${r.car.rego} already Sold`;
            break;
          }
          case 'REPAIR': {
            const r = await addChecklistItem(a, tctx);
            msg = `🛠️ ${r.car.rego} checklist + ${r.item}`;
            break;
          }
          case 'READY': {
            const r = await setReadinessStatus(a, tctx);
            msg = `✅ ${r.car.rego} readiness → ${r.readiness}`;
            break;
          }
          case 'DROP_OFF': {
            const r = await createDropOffTask(a, tctx);
            msg = `📦 Task: ${r.task.task}`;
            break;
          }
          case 'CUSTOMER_APPOINTMENT': {
            const r = await createCustomerAppointment(a, tctx);
            const label = r.car
              ? r.car.rego || [r.car.make, r.car.model].filter(Boolean).join(' ')
              : r.appointment?.carText || 'unidentified vehicle';
            const when = r.appointment?.dateTime ? ` @ ${r.appointment.dateTime}` : '';
            msg = `👤 Customer appt created for ${label}${when}`;
            break;
          }
          case 'RECON_APPOINTMENT': {
            const r = await createReconditionerAppointment(a, tctx);
            const label = r.car
              ? r.car.rego || `${r.car.make} ${r.car.model}`.trim()
              : r.carText || 'unidentified vehicle';
            const when = r.appointment?.dateTime ? ` @ ${r.appointment.dateTime}` : '';
            const cat = r.appointment?.category?.name ? ` • ${r.appointment.category.name}` : '';
            msg = `🔧 Recon appt created for ${label}${when} (${r.appointment.name}${cat})`;
            break;
          }
          case 'NEXT_LOCATION': {
            const r = await setNextLocation(a, tctx);
            msg = `➡️ ${r.car.rego} next location updated`;
            break;
          }
          case 'TASK': {
            const r = await createGenericTask(a, tctx);
            msg = `📝 Task: ${r.task.task}`;
            break;
          }
          default:
            msg = `⚠️ Skipped: ${a.type}`;
        }
        out.push(msg);
      } catch (err) {
        if (typeof timeline.identFail === 'function') {
          timeline.identFail(tctx, { reason: err.message, rego: a.rego, make: a.make, model: a.model });
        }
        out.push(`❌ ${a.type} ${a.rego || ''}: ${err.message}`);
      }
    }

    // 🔍 Attach last rego resolution block (from photo step)
    const regoLines = lastRegoLogByChat.get(chatId);
    const header = `🧾 Processed ${messages.length} message(s) → ${actions.length} action(s)`;

    const lines = [header];

    if (regoLines && regoLines.length) {
      lines.push('🔍 Rego resolution (last photo):');
      for (const l of regoLines) lines.push(`   ${l}`);
      lastRegoLogByChat.delete(chatId);
    }

    if (regoNormLines.length) {
      for (const l of regoNormLines) lines.push(l);
    }

    lines.push(...(out.length ? out : ['No actionable updates.']));

    const body = lines.join('\n');
    await notifyChatOrAdmin(chatId, body);
    timeline.print(tctx);
  },
});

/* ----------------------------------------------------------------
   Helpers
---------------------------------------------------------------- */
const senderName = (ctx) => {
  const u = ctx.from || {};
  return u.username || [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Unknown';
};

const addToBatch = (ctx, text, key, tsOverride) => {
  const ts = tsOverride ?? (ctx.message?.date ? ctx.message.date * 1000 : Date.now());
  batcher.addMessage({ chatId: ctx.chat.id, speaker: senderName(ctx), text, key, ts });
};

function guessImageMime(buffer, filename = '') {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length > 8 && buffer.slice(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  return 'image/jpeg';
}

/* ----------------------------------------------------------------
   Logging & Commands
---------------------------------------------------------------- */
bot.on('message', async (ctx, next) => {
  try {
    console.log(
      'INCOMING → chat.id:',
      ctx.chat?.id,
      'type:',
      ctx.updateType,
      'text:',
      ctx.message?.text || ctx.message?.caption || ''
    );
  } catch {}
  return next();
});

bot.command('ping', (ctx) => safeReply(ctx, 'pong'));
bot.command('id', (ctx) => safeReply(ctx, `chat.id: ${ctx.chat?.id}`));

/* ----------------------------------------------------------------
   TEXT handler
---------------------------------------------------------------- */
bot.on('text', async (ctx) => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  addToBatch(ctx, text, ctx.message.message_id);
  await safeReply(ctx, '📦 Added to 1-minute batch…');
});

/* ----------------------------------------------------------------
   PHOTO handler — includes car auto-creation logic + rego logging
---------------------------------------------------------------- */
bot.on('photo', async (ctx) => {
  const photos = ctx.message.photo || [];
  if (!photos.length) return safeReply(ctx, '⚠️ No photo sizes found.');

  const key = ctx.message.message_id;
  addToBatch(ctx, 'Photo', key);
  await safeReply(ctx, '🖼️ Photo received — analyzing…');

  let ensureInfo = null;

  try {
    const biggest = photos[photos.length - 1];
    const info = await ctx.telegram.getFile(biggest.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.file_path}`;
    const filename = info.file_path.split('/').pop() || '';

    const resp = await fetch(fileUrl);
    if (!resp.ok) throw new Error(`telegram file fetch ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const mimeType = guessImageMime(buffer, filename);
    const base64 = buffer.toString('base64');

    const veh = await analyzeImageVehicle({ base64, mimeType });

    // ✅ ensure car exists if detected (with detailed rego log)
    if (veh.rego && (veh.make || veh.model)) {
      ensureInfo = await ensureCarForAction(
        {
          rego: veh.rego,
          make: veh.make,
          model: veh.model,
          badge: veh.badge,
          color: veh.color,
          year: veh.year,
          description: veh.description,
        },
        null,
        { withLog: true }
      );

      const car = ensureInfo.car;
      console.log(`✅ Ensured car exists: ${car.rego} (${car.make || ''} ${car.model || ''})`);

      // Store log lines for next batch summary
      if (ensureInfo.logLines && ensureInfo.logLines.length) {
        lastRegoLogByChat.set(ctx.chat.id, ensureInfo.logLines.slice());
      }

      // Store rego mapping: raw (veh.rego) -> canonical (car.rego)
      const raw = String(veh.rego || '').toUpperCase().replace(/\s+/g, '');
      const canonical = String(car.rego || '').toUpperCase().replace(/\s+/g, '');
      if (raw && canonical && raw !== canonical) {
        const existing = lastRegoMapByChat.get(ctx.chat.id) || {};
        existing[raw] = canonical;
        lastRegoMapByChat.set(ctx.chat.id, existing);
      }
    }

    // 🔧 construct analysis line correctly for both car & non-car photos
    let analysis = '';
    if (veh.analysis && !veh.make && !veh.model && !veh.rego) {
      analysis = `Photo analysis: ${veh.analysis}`;
    } else {
      const desc = [veh.make, veh.model, veh.colorDescription].filter(Boolean).join(' ');
      analysis = `Photo analysis: ${desc}${veh.rego ? `, rego ${veh.rego}` : ''}${
        veh.analysis ? ` — ${veh.analysis}` : ''
      }`;
    }

    const ok = batcher.updateMessage(ctx.chat.id, key, analysis);

    const cap = (ctx.message.caption || '').trim();
    if (cap) {
      const baseTs = ctx.message?.date ? ctx.message.date * 1000 : Date.now();
      addToBatch(ctx, cap, `${key}:caption`, baseTs + 1);
    }

    const regoLog =
      ensureInfo?.logLines?.length
        ? `\n\n🔍 Rego resolution:\n${ensureInfo.logLines.join('\n')}`
        : '';

    await safeReply(
      ctx,
      ok
        ? `✅ Added to batch: ${analysis}${cap ? `\n📝 Caption: ${cap}` : ''}${regoLog}`
        : `ℹ️ Analysis ready, but batch already flushed.${regoLog}`
    );
  } catch (err) {
    console.error('photo handler error:', err);
    await safeReply(ctx, `❌ Photo analysis failed: ${err.message || 'unknown error'}`);
  }
});

module.exports = { bot };
