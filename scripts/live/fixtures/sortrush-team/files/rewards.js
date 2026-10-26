const db = require("./db");
db.defineUnique("rewards", "sessionId");
// Shared exactly-once issuance: one reward per session, whatever the caller does.
function issueReward(sessionId, tier) { return db.insert("rewards", { sessionId, tier }); }
function rewardCount() { return db.table("rewards").length; }
module.exports = { issueReward, rewardCount };
