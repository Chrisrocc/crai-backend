// src/services/logging/timelineLogger.js

const timelineLogger = {
  section(tctx, label, lines) {
    try {
      console.log(`\n===== ${label} =====`);
      if (Array.isArray(lines)) {
        for (const l of lines) console.log(l);
      } else if (typeof lines === 'string') {
        console.log(lines);
      } else {
        console.log(JSON.stringify(lines, null, 2));
      }
    } catch (err) {
      console.error("timelineLogger.section error:", err);
    }
  },

  prompt(tctx, label, { inputText, outputText }) {
    try {
      console.log(`\n===== ${label} (INPUT) =====`);
      console.log(inputText || '');

      console.log(`\n===== ${label} (OUTPUT) =====`);
      try {
        const parsed = JSON.parse(outputText);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log(outputText);
      }
    } catch (err) {
      console.error("timelineLogger.prompt error:", err);
    }
  },

  actions(tctx, actions) {
    try {
      console.log(`\n===== ACTIONS (RAW) =====`);
      console.log(JSON.stringify(actions, null, 2));
    } catch (err) {
      console.error("timelineLogger.actions error:", err);
    }
  },

  recordAudit(tctx, audit) {
    try {
      console.log(`\n===== AI AUDIT =====`);
      console.log(JSON.stringify(audit, null, 2));
    } catch (err) {
      console.error("timelineLogger.recordAudit error:", err);
    }
  }
};

module.exports = timelineLogger;
