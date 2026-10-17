"use strict";

/**
 * ECLIPSE Human Typing
 * --------------------
 * Owns only the Messenger typing-indicator lifecycle. It deliberately has
 * no text-generation or delay-calculation logic.
 *
 * ws3-fca's sendTypingIndicator() returns a function that ends the indicator;
 * we keep it per thread so stopTyping() really stops it (older code relied on
 * api.sendTyping which may not exist). The indicator is refreshed every 3.5s
 * so it never expires mid-reply.
 */

const active = new Map(); // threadID -> { stop, timer }

function begin(api, threadID) {
  let stop = null;
  try {
    if (typeof api.sendTypingIndicator === "function") {
      const ret = api.sendTypingIndicator(threadID, (error) => {
        if (error) console.warn("[HUMAN-TYPING] Typing indicator failed:", error?.message || error);
      });
      if (typeof ret === "function") stop = ret;
      return { ok: true, stop };
    }
    if (typeof api.sendTyping === "function") {
      api.sendTyping(threadID, true);
      return { ok: true, stop: () => api.sendTyping(threadID, false) };
    }
  } catch (error) {
    console.warn("[HUMAN-TYPING] Unable to start typing indicator:", error?.message || error);
  }
  return { ok: false, stop: null };
}

function startTyping(api, threadID) {
  if (!api || !threadID) return false;
  const key = String(threadID);
  if (active.has(key)) return true;

  const first = begin(api, threadID);
  if (!first.ok) return false;

  const entry = { stop: first.stop, timer: null };
  entry.timer = setInterval(() => {
    const next = begin(api, threadID);
    if (next.stop) entry.stop = next.stop;
  }, 3500);
  if (typeof entry.timer.unref === "function") entry.timer.unref();
  active.set(key, entry);
  return true;
}

function stopTyping(api, threadID) {
  if (!threadID) return false;
  const key = String(threadID);
  const entry = active.get(key);
  if (entry) {
    clearInterval(entry.timer);
    active.delete(key);
  }
  try {
    if (entry && typeof entry.stop === "function") { entry.stop(); return true; }
    if (api && typeof api.sendTyping === "function") { api.sendTyping(threadID, false); return true; }
  } catch (error) {
    console.warn("[HUMAN-TYPING] Unable to stop typing indicator:", error?.message || error);
  }
  return false;
}

function withTyping(api, threadID, durationMs, send) {
  const duration = Math.max(0, Number(durationMs) || 0);
  startTyping(api, threadID);

  return new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        const result = await send();
        stopTyping(api, threadID);
        resolve(result);
      } catch (error) {
        stopTyping(api, threadID);
        reject(error);
      }
    }, duration);
  });
}

module.exports = { startTyping, stopTyping, withTyping };
