// src/services/batcher.js
class Batcher {
  /**
   * @param {{ windowMs?: number, onFlush: (chatId: number|string, messages: Array<{speaker:string,text:string,key?:string|number,ts:number}>) => Promise<void> }} opts
   */
  constructor({ windowMs = 60_000, onFlush }) {
    this.windowMs = windowMs;
    this.onFlush = onFlush;
    /** @type {Map<string|number, { timer: any, messages: Array<{speaker:string,text:string,key?:string|number,ts:number}>, startAt:number }>} */
    this.state = new Map();
  }

  addMessage({ chatId, speaker, text, key, ts = Date.now() }) {
    if (!text || !chatId) return;
    let s = this.state.get(chatId);
    if (!s) {
      s = { messages: [], timer: null, startAt: ts };
      this.state.set(chatId, s);
      s.timer = setTimeout(() => this.flush(chatId).catch(console.error), this.windowMs);
    }
    s.messages.push({ speaker, text, key, ts });
  }

  updateMessage(chatId, key, newText) {
    const s = this.state.get(chatId);
    if (!s || key == null) return false;
    const msg = s.messages.find((m) => m.key === key);
    if (!msg) return false;
    msg.text = newText;
    return true;
  }

  async flush(chatId) {
    const s = this.state.get(chatId);
    if (!s) return;
    clearTimeout(s.timer);
    this.state.delete(chatId);
    s.messages.sort((a, b) => a.ts - b.ts);
    if (s.messages.length) {
      await this.onFlush(chatId, s.messages);
    }
  }
}

module.exports = { Batcher };
