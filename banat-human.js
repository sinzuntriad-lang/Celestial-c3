"use strict";

const { BANAT_SHORTHANDS } = require("./banat-abbreviations");
const { chooseSocialResponse, socialTimingMultiplier } = require("./banat-social");
const { humanize } = require("./human-mimic");
const { calculateHumanDelay } = require("./human-delay");
const { startTyping, stopTyping } = require("./human-typing");

// FAST profile: typing indicator shows almost right away, then a short "typing"
// time scaled to the reply length. Tune with env vars (no code change needed):
//   BANAT_REPLY_DELAY_MS   pause before typing starts (default 150)
//   BANAT_SPEED_FACTOR     multiplier on the human typing time (default 0.3; 1 = old slow feel)
//   BANAT_MAX_TYPING_MS    hard cap on typing time (default 1800)
//   BANAT_MIN_TYPING_MS    minimum typing time so the indicator is visible (default 500)
const REPLY_DELAY_MS = Math.max(0, Number(process.env.BANAT_REPLY_DELAY_MS || 150));
const SPEED_FACTOR = Math.max(0.05, Number(process.env.BANAT_SPEED_FACTOR || 0.3));
const MAX_DELAY_MS = Math.max(600, Number(process.env.BANAT_MAX_TYPING_MS || process.env.BANAT_MAX_HUMAN_DELAY_MS || 1800));
const MIN_TYPING_MS = Math.max(200, Math.min(MAX_DELAY_MS, Number(process.env.BANAT_MIN_TYPING_MS || 500)));
const state = new Map();

function createHumanContext(threadID, incomingText = "") {
  const key = String(threadID || "unknown"), now = Date.now(), prev = state.get(key);
  const within = prev && now - prev.at < 45_000;
  const recentMessages = within ? Math.min(8, Number(prev.count || 0) + 1) : 1;
  const incomingWords = String(incomingText).trim().split(/\s+/).filter(Boolean).length;
  const mode = recentMessages >= 5 ? "rushed" : recentMessages >= 3 ? "normal" : "chill";
  const momentum = Math.max(1, recentMessages + (incomingWords >= 18 ? 1 : 0) + (incomingWords >= 35 ? 1 : 0));
  state.set(key, { at: now, count: recentMessages });
  return { threadID: key, incomingText: String(incomingText), incomingWords, incomingChars: String(incomingText).length, recentMessages, momentum, mode, elapsedSincePreviousMs: within ? now - prev.at : null };
}

function prepareBanatReply(threadID, message, incomingText = "") {
  const context = createHumanContext(threadID, incomingText);
  let text = humanize(message, {
    abbreviations: BANAT_SHORTHANDS,
    abbreviationRate: Number(process.env.BANAT_SHORTHAND_RATE || 0.035),
    typoRate: Number(process.env.BANAT_TYPO_RATE || 0.085),
    caseVariationRate: Number(process.env.BANAT_CASE_VARIATION_RATE || 0.035),
    spaceVariationRate: Number(process.env.BANAT_SPACE_SLIP_RATE || 0.018),
    abbreviate: true, typos: true, punctuation: true
  });

  const social = chooseSocialResponse(incomingText, text, context);
  const timing = calculateHumanDelay(text, { ...context, social }, { max: 2200, maxTypingMs: 6500, hesitationRate: Number(process.env.BANAT_HESITATION_RATE || 0.11) });
  const multiplier = socialTimingMultiplier(social);

  return {
    text,
    context: { ...context, social },
    social,
    reactionMs: Math.max(60, Math.min(500, REPLY_DELAY_MS * multiplier + Math.random() * 120)),
    typingMs: Math.max(MIN_TYPING_MS, Math.min(MAX_DELAY_MS, (Number(timing.typingMs) || MIN_TYPING_MS) * SPEED_FACTOR * multiplier))
  };
}

function sendBanatReplyWithTyping(api, message, threadID, replyToMessageID = null, dependencies = {}) {
  const send = dependencies.trafficSendMessage;
  if (typeof send !== "function") return Promise.resolve(false);

  const prepared = prepareBanatReply(threadID, message, dependencies.incomingText || "");
  const delay = Math.max(40, Number(dependencies.replyDelayMs || prepared.reactionMs));

  return new Promise(resolve => {
    setTimeout(() => {
      startTyping(api, threadID);
      setTimeout(() => {
        let done = false;
        const finish = ok => { if (done) return; done = true; stopTyping(api, threadID); resolve(ok); };
        try {
          send(api, prepared.text, threadID, (err, info) => {
            if (err) { console.error("[BANAT] send failed:", err?.message || err); finish(false); return; }
            const id = typeof info === "string" ? info : info?.messageID || info?.messageId || info?.id;
            try {
              if (id && typeof api?.setMessageReactionMqtt === "function") api.setMessageReactionMqtt("😆", String(id), String(threadID), () => {});
              else if (id && typeof api?.setMessageReaction === "function") api.setMessageReaction("😆", String(id), () => {}, true);
            } catch (_) {}
            finish(true);
          }, replyToMessageID || null);
        } catch (e) { console.error("[BANAT] reply error:", e); finish(false); }
      }, prepared.typingMs);
    }, delay);
  });
}

module.exports = { BANAT_REPLY_DELAY_MS: REPLY_DELAY_MS, BANAT_MAX_HUMAN_DELAY_MS: MAX_DELAY_MS, prepareBanatReply, sendBanatReplyWithTyping };
