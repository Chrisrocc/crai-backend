// src/services/batcher.js
// Rolling-window, per-chat batching:
// - Start a 2 min window when first message arrives.
// - If any message arrives in the LAST 1 min of the current window, extend by +2 min.
// - Repeat as needed.
// - Flush on window expiry or when maxItems is reached.

class Batcher {
  /**
   * @param {{
   *   onFlush: (chatId: number|string, messages: Array<{speaker:string,text:string,key?:string|number,ts:number}>) => Promise<void> | void,
   *   baseWindowMs?: number,           // initial window length (default 120000 = 2 min)
   *   extendThresholdMs?: number,      // "last minute" threshold (default 60000 = 1 min)
   *   extendByMs?: number,             // how much to extend by (default 120000 = 2 min)
   *   maxItems?: number,               // immediate flush when reached (default 100)
   *   windowMs?: number                // backward-compat alias for baseWindowMs
   * }} opts
   */
  constructor({
    onFlush,
    baseWindowMs = 120_000,
    extendThresholdMs = 60_000,
    extendByMs = 120_000,
    maxItems = 100,
    windowMs, // legacy
  }) {
    if (typeof onFlush !== 'function') {
      throw new Error('Batcher requires an onFlush(chatId, messages) function');
    }
    // Backward compat: if windowMs provided, treat it as baseWindowMs
    if (Number.isFinite(windowMs)) baseWindowMs = windowMs;

    this.onFlush = onFlush;
    this.baseWindowMs = baseWindowMs;
    this.extendThresholdMs = extendThresholdMs;
    this.extendByMs = extendByMs;
    this.maxItems = maxItems;

    /** @type {Map<string|number, {
     *   timer: any,
     *   messages: Array<{speaker:string,text:string,key?:string|number,ts:number}>,
     *   startAt: number,
     *   deadline: number
     * }>} */
    this.state = new Map();
  }

  /**
   * Add/queue a message for a chat.
   * Starts a window if not running; extends it if the message lands in the last-minute threshold.
   */
  addMessage({ chatId, speaker, text, key, ts = Date.now() }) {
    if (!chatId || !text) return;
    let s = this.state.get(chatId);
    const now = Date.now();

    if (!s) {
      // start new window
      const deadline = now + this.baseWindowMs;
      s = { messages: [], timer: null, startAt: now, deadline };
      this.state.set(chatId, s);
      s.timer = setTimeout(() => this.flush(chatId).catch(console.error), this.baseWindowMs);
    }

    // push message
    s.messages.push({ speaker, text, key, ts });

    // Extend logic: if we're inside the "last minute" of the current window, extend by +2 min
    const remaining = s.deadline - now;
    if (remaining <= this.extendThresholdMs) {
      s.deadline += this.extendByMs;
      // re-arm the timer to match the new deadline
      clearTimeout(s.timer);
      const newDelay = Math.max(0, s.deadline - Date.now());
      s.timer = setTimeout(() => this.flush(chatId).catch(console.error), newDelay);
    }

    // Immediate flush if we hit the max batch size
    if (s.messages.length >= this.maxItems) {
      this.flush(chatId).catch(console.error);
    }
  }

  /**
   * Update the text of a specific message (by key) before flush.
   * Returns true if updated, false otherwise.
   */
  updateMessage(chatId, key, newText) {
    const s = this.state.get(chatId);
    if (!s || key == null) return false;
    const msg = s.messages.find((m) => m.key === key);
    if (!msg) return false;
    msg.text = newText;
    return true;
  }

  /**
   * Force-flush a chat’s batch immediately.
   */
  async flush(chatId) {
    const s = this.state.get(chatId);
    if (!s) return;
    clearTimeout(s.timer);
    this.state.delete(chatId);

    // chronological order
    s.messages.sort((a, b) => a.ts - b.ts);

    if (s.messages.length) {
      await this.onFlush(chatId, s.messages);
    }
  }

  /**
   * Optional: flush all chats (e.g., on shutdown).
   */
  async flushAll() {
    const ids = Array.from(this.state.keys());
    for (const id of ids) {
      try { // eslint-disable-next-line no-await-in-loop
        await this.flush(id);
      } catch (e) {
        console.error('Batcher.flushAll error:', e);
      }
    }
  }
}

module.exports = { Batcher };
