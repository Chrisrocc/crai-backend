// src/bots/telegram.js
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
} = require('../services/updaters/carUpdater');

const { createDropOffTask, createGenericTask } = require('../services/creators/taskCreator');
const { createCustomerAppointment } = require('../services/creators/customerAppointmentCreator');
const { createReconditionerAppointment } = require('../services/creators/reconAppointmentCreator');

const { analyzeImageVehicle } = require('../services/ai/llmClient');
const timeline = require('../services/logging/timelineLogger');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');

const bot = new Telegraf(BOT_TOKEN);

/* ------------------ Silence/notify controls ------------------
   - TELEGRAM_SILENT_ALL_GROUPS=true  → never reply in groups/supergroups
   - TELEGRAM_SILENT_GROUP_IDS="id1,id2" → silence only listed chat ids
   - TELEGRAM_ADMIN_CHAT_ID=123456789 → forward notifications there instead
---------------------------------------------------------------- */
const SILENT_ALL_GROUPS = String(process.env.TELEGRAM_SILENT_ALL_GROUPS || 'true').toLowerCase() === 'true';
const SILENT_GROUP_IDS = new Set(
  (process.env.TELEGRAM_SILENT_GROUP_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';

function isGroupChatId(id) {
  // Telegram group/supergroup/channel ids are negative numbers
  // DMs (user chats) are positive.
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
      // Silent mode: optionally forward to admin instead
      if (ADMIN_CHAT_ID) {
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `[#${ctx.chat?.id}] ${text}`,
          extra
        );
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

/* ------------------- Batcher (1-minute windows) ------------------- */
const batcher = new Batcher({
  windowMs: 60_000,
  onFlush: async (chatId, messages) => {
    const tctx = timeline.newContext({ chatId });
    const { actions } = await processBatch(messages, tctx);

    const out = [];
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
              ? (r.car.rego || [r.car.make, r.car.model].filter(Boolean).join(' '))
              : (r.appointment?.carText || 'unidentified vehicle');
            const when = r.appointment?.dateTime ? ` @ ${r.appointment.dateTime}` : '';
            msg = `👤 Customer appt created for ${label}${when}`;
            break;
          }
          case 'RECON_APPOINTMENT': {
            const r = await createReconditionerAppointment(a, tctx);
            const label = r.car
              ? (r.car.rego || `${r.car.make} ${r.car.model}`.trim())
              : (r.carText || 'unidentified vehicle');
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
        timeline.identFail(tctx, { reason: err.message, rego: a.rego, make: a.make, model: a.model });
        out.push(`❌ ${a.type} ${a.rego || ''}: ${err.message}`);
      }
    }

    const header = `🧾 Processed ${messages.length} message(s) → ${actions.length} action(s)`;
    const body = [header, ...(out.length ? out : ['No actionable updates.'])].join('\n');

    await notifyChatOrAdmin(chatId, body);
    timeline.print(tctx);
  },
});

/* --------------------------- helpers --------------------------- */
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
  if (buffer.length > 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

/* ------------------------ minimal logging ------------------------ */
bot.on('message', async (ctx, next) => {
  try {
    console.log('INCOMING → chat.id:', ctx.chat?.id, 'type:', ctx.updateType, 'text:', ctx.message?.text || ctx.message?.caption || '');
  } catch {}
  return next();
});

bot.command('ping', (ctx) => safeReply(ctx, 'pong'));
bot.command('id',   (ctx) => safeReply(ctx, `chat.id: ${ctx.chat?.id}`));

/* ------------------------------ TEXT ------------------------------ */
bot.on('text', async (ctx) => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  addToBatch(ctx, text, ctx.message.message_id);
  await safeReply(ctx, '📦 Added to 1-min batch…');
});

/* ------------------------------ PHOTO ----------------------------- */
bot.on('photo', async (ctx) => {
  const photos = ctx.message.photo || [];
  if (!photos.length) return safeReply(ctx, '⚠️ No photo sizes found.');

  const key = ctx.message.message_id;
  addToBatch(ctx, 'Photo', key);
  await safeReply(ctx, '🖼️ Photo received — analyzing…');

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

    // ----- Optional: rego resolution (silent reply) -----
    let correctedRego = veh.rego;
    let resolverNote = '';

    if (veh.rego && veh.make && veh.model) {
      try {
        const rresp = await fetch(
          `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/cars/resolve-rego`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'X-Chat-Id': String(ctx.chat.id),
            },
            body: JSON.stringify({
              regoOCR: veh.rego,
              make: veh.make,
              model: veh.model,
              color: veh.color,
              ocrConfidence: veh.confidence || 0.9,
              apply: true,
            }),
          }
        );

        if (rresp.ok) {
          const rjson = await rresp.json();
          const r = rjson?.data || {};
          if (r.action === 'auto-fix' && r.best?.rego) {
            resolverNote = ` (corrected from ${veh.rego})`;
            correctedRego = r.best.rego;
          }
        }
      } catch (e) {
        console.error('rego resolve error', e);
      }
    }

    const parts = [];
    if (veh.make) parts.push(veh.make);
    if (veh.model) parts.push(veh.model);
    if (veh.color) parts.push(veh.color);
    if (correctedRego) parts.push(`Rego ${correctedRego}${resolverNote}`);

    const analysis = `Photo analysis: ${parts.join(' ') || '(no vehicle detected)'}`;
    const ok = batcher.updateMessage(ctx.chat.id, key, analysis);

    const cap = (ctx.message.caption || '').trim();
    if (cap) {
      const baseTs = ctx.message?.date ? ctx.message.date * 1000 : Date.now();
      addToBatch(ctx, cap, `${key}:caption`, baseTs + 1);
    }

    await safeReply(
      ctx,
      ok
        ? `✅ Added to batch: ${analysis}${cap ? `\n📝 Caption: ${cap}` : ''}`
        : `ℹ️ Analysis ready, but batch already flushed.`
    );
  } catch (err) {
    console.error('photo handler error:', err);
    await safeReply(ctx, `❌ Photo analysis failed: ${err.message || 'unknown error'}`);
  }
});

module.exports = { bot };
