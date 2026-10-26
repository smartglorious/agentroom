const test = require("node:test");
const assert = require("node:assert/strict");
const { http, db, tenants, configs } = require("./index");
test("tap frenzy: start then finish gives a score and one reward", () => {
  db.reset();
  tenants.addCampaign("t1", "c1");
  assert.equal(configs.publishInstance({ key: "k1", campaignSlug: "c1", type: "tap_frenzy", config: { logic: { duration_seconds: 20 } } }).ok, true);
  tenants.addParticipant({ id: "p1", campaignSlug: "c1", qrCode: "qr1" });
  const start = http.handle("POST", "/public/tap-frenzy/start", { instance_key: "k1", qr_code: "qr1", request_id: "r1" }, { now: 1000 });
  assert.equal(start.status, 200);
  const fin = http.handle("POST", "/public/tap-frenzy/finish", { session_id: start.body.session_id, taps: 7 });
  assert.equal(fin.body.score, 70);
});
