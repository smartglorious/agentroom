const db = require("./db");
const rewards = require("./rewards");
db.defineUnique("game_sessions", "id");
db.defineUnique("game_sessions", "participantId", "requestId");
let seq = 0;
// The session authority shared by every game: quota, expiry, finalize + reward eligibility.
function createSession({ participantId, campaignSlug, instanceKey, type, requestId, configSnapshot, now, ttlSeconds }) {
  const existing = db.find("game_sessions", (s) => s.participantId === participantId && s.requestId === requestId);
  if (existing) return { session: existing, created: false };
  const max = configSnapshot.logic?.max_plays_per_participant ?? 3;
  const used = db.filter("game_sessions", (s) => s.participantId === participantId && s.instanceKey === instanceKey).length;
  if (used >= max) return { error: "quota" };
  seq += 1;
  const session = db.insert("game_sessions", {
    id: `gs_${seq}`, participantId, campaignSlug, instanceKey, type, requestId, status: "active",
    configSnapshot, startedAt: now, expiresAt: now + ttlSeconds * 1000, score: null, rewardEligible: false,
  });
  return { session, created: true };
}
function getSession(id) { return db.find("game_sessions", (s) => s.id === id); }
function finalizeSession(id, score, tier = "participation") {
  const s = getSession(id);
  if (!s) throw new Error("unknown session");
  if (s.status === "finished") return s;
  s.status = "finished"; s.score = score; s.rewardEligible = true;
  rewards.issueReward(id, tier);
  return s;
}
module.exports = { createSession, getSession, finalizeSession };
