// The existing game to follow as a pattern: how a game plugs into tenants, sessions, rewards, validators and routes.
const http = require("./http");
const tenants = require("./tenants");
const sessions = require("./gameSessions");
const configs = require("./configs");

configs.registerValidator("tap_frenzy", (c) => (c?.logic?.duration_seconds >= 5 && c.logic.duration_seconds <= 60 ? [] : ["duration_seconds must be 5..60"]));

http.register("POST", "/public/tap-frenzy/start", ({ body, ctx }) => {
  const instance = tenants.instanceOf(body.instance_key);
  const participant = tenants.participantByQr(body.qr_code);
  if (!instance || instance.type !== "tap_frenzy") return { status: 404, body: { error: "instance not found" } };
  if (!participant || participant.campaignSlug !== instance.campaignSlug) return { status: 403, body: { error: "qr does not belong to this campaign" } };
  const r = sessions.createSession({
    participantId: participant.id, campaignSlug: instance.campaignSlug, instanceKey: instance.key, type: "tap_frenzy",
    requestId: body.request_id, configSnapshot: instance.config, now: ctx.now, ttlSeconds: instance.config.logic.duration_seconds + 5,
  });
  if (r.error === "quota") return { status: 429, body: { error: "play limit reached" } };
  return { status: 200, body: { session_id: r.session.id, expires_at: r.session.expiresAt } };
});

http.register("POST", "/public/tap-frenzy/finish", ({ body }) => {
  const s = sessions.getSession(body.session_id);
  if (!s) return { status: 404, body: { error: "session not found" } };
  const taps = Math.min(Number(body.taps) || 0, 400);
  const done = sessions.finalizeSession(s.id, taps * 10);
  return { status: 200, body: { score: done.score, reward_eligible: done.rewardEligible } };
});
