const test = require("node:test");
const assert = require("node:assert/strict");
const { http, db, tenants, configs, rewards } = require("./index");
try { require("./sortRush"); } catch { /* the workers may name it differently; index.js is expected to load it */ }

const cfg = () => ({
  ui: { title: "Sort" },
  logic: { duration_seconds: 30, max_plays_per_participant: 2, base_points: 100, wrong_penalty: 25, combo_every: 3 },
  categories: [{ id: "recycle", label: "Recycle" }, { id: "compost", label: "Compost" }],
  items: ["a", "b", "c", "d", "e", "f"].map((id, i) => ({ id, label: id.toUpperCase(), category_id: i % 2 ? "compost" : "recycle" })),
});
const setup = (config = cfg()) => {
  db.reset();
  tenants.addCampaign("t1", "c1"); tenants.addCampaign("t2", "c2");
  const pub = configs.publishInstance({ key: "k1", campaignSlug: "c1", type: "sort_rush", config });
  tenants.addParticipant({ id: "p1", campaignSlug: "c1", qrCode: "qr1" });
  tenants.addParticipant({ id: "p2", campaignSlug: "c1", qrCode: "qr2" });
  tenants.addParticipant({ id: "px", campaignSlug: "c2", qrCode: "qrx" });
  return pub;
};
const start = (over = {}, now = 1000) => http.handle("POST", "/public/sort-rush/start", { campaign_slug: "c1", instance_key: "k1", qr_code: "qr1", request_id: "r1", ...over }, { now });
const act = (sid, item, cat, eid, now = 2000) => http.handle("POST", "/public/sort-rush/action", { session_id: sid, event_id: eid, item_id: item, category_id: cat, client_seq: 1 }, { now });
const truth = Object.fromEntries(cfg().items.map((i) => [i.id, i.category_id]));

test("start refuses a QR or an instance of another campaign, and never leaks the answer key", () => {
  assert.equal(setup().ok, true);
  assert.equal(start({ qr_code: "qrx" }).status, 403);
  assert.equal(start({ instance_key: "nope" }).status, 404);
  const s = start();
  assert.equal(s.status, 200);
  assert.equal(s.body.items.length, 6);
  assert.ok(!JSON.stringify(s.body).includes("category_id"), "items must not carry category_id");
  assert.ok(!JSON.stringify(s.body.items).includes("compost") && !JSON.stringify(s.body.items).includes("recycle"), "no category name on items");
});

test("the same request_id gives the same session and the quota is enforced", () => {
  setup();
  const a = start(), b = start();
  assert.equal(a.body.session_id, b.body.session_id);
  assert.equal(start({ request_id: "r2" }).status, 200);
  assert.equal(start({ request_id: "r3" }).status, 429);
});

test("the same event_id ten times records one action", () => {
  setup();
  const sid = start().body.session_id;
  const first = act(sid, "a", "recycle", "e1");
  for (let i = 0; i < 9; i += 1) assert.equal(act(sid, "a", "recycle", "e1").body.duplicate, true);
  assert.equal(first.body.correct, true);
  const st = http.handle("GET", `/public/sort-rush/state/${sid}?qr_code=qr1`, {}, { now: 2000 });
  assert.deepEqual(st.body.answered, ["a"]);
  assert.equal(st.body.score, 100);
});

test("an item cannot be processed twice, and bad input is refused", () => {
  setup();
  const sid = start().body.session_id;
  assert.equal(act(sid, "a", "recycle", "e1").status, 200);
  assert.equal(act(sid, "a", "compost", "e2").status, 409);
  assert.equal(act(sid, "zzz", "recycle", "e3").status, 400);
  assert.equal(act(sid, "b", "nowhere", "e4").status, 400);
  assert.equal(act("gs_none", "b", "compost", "e5").status, 404);
});

test("scoring: combo bonus, wrong penalty floors at zero, client score is ignored", () => {
  setup();
  const sid = start().body.session_id;
  assert.equal(act(sid, "a", truth.a === "recycle" ? "compost" : "recycle", "w1").body.score, 0);
  for (const [i, id] of ["a", "b", "c"].entries()) act(sid, id, truth[id], `ok${i}`);
  const fin = http.handle("POST", "/public/sort-rush/finish", { session_id: sid, score: 999999 }, { now: 3000 });
  // a was answered wrongly (0), so the later "a" is refused; b and c are correct: 200, combo 2, no bonus yet
  assert.equal(fin.status, 200);
  assert.equal(fin.body.score, 200);
  assert.equal(fin.body.reward_eligible, true);
});

test("scoring: three in a row earns the bonus", () => {
  setup();
  const sid = start().body.session_id;
  const last = ["a", "b", "c"].map((id, i) => act(sid, id, truth[id], `k${i}`)).pop();
  assert.equal(last.body.score, 100 * 3 + 100);
  assert.equal(http.handle("POST", "/public/sort-rush/finish", { session_id: sid }, { now: 3000 }).body.score, 400);
});

test("finish twice issues one reward; actions after finish are refused", () => {
  setup();
  const sid = start().body.session_id;
  act(sid, "a", truth.a, "e1");
  const f1 = http.handle("POST", "/public/sort-rush/finish", { session_id: sid }, { now: 3000 });
  const f2 = http.handle("POST", "/public/sort-rush/finish", { session_id: sid }, { now: 3500 });
  assert.deepEqual(f1.body, f2.body);
  assert.equal(rewards.rewardCount(), 1);
  assert.equal(act(sid, "b", truth.b, "e2").status, 409);
});

test("expired sessions refuse actions; only the owner can read the state", () => {
  setup();
  const sid = start({}, 1000).body.session_id;
  assert.equal(act(sid, "a", truth.a, "e1", 1000 + 36_000).status, 410);
  assert.equal(http.handle("GET", `/public/sort-rush/state/${sid}?qr_code=qr2`, {}, { now: 2000 }).status, 403);
  assert.equal(http.handle("GET", `/public/sort-rush/state/${sid}?qr_code=qr1`, {}, { now: 2000 }).status, 200);
});

test("bad configs are refused at publish with a list of errors", () => {
  const bad = (mut) => { setup(); const c = cfg(); mut(c); return configs.publishInstance({ key: "kb", campaignSlug: "c1", type: "sort_rush", config: c }); };
  for (const mut of [
    (c) => { c.categories = [c.categories[0]]; },
    (c) => { c.items = c.items.slice(0, 5); },
    (c) => { c.items[0].category_id = "ghost"; },
    (c) => { c.items[1].id = c.items[0].id; },
    (c) => { c.logic.duration_seconds = 5; },
    (c) => { c.items[0].label = "<b>x</b>"; },
    (c) => { c.categories[0].label = "x".repeat(81); },
  ]) {
    const r = bad(mut);
    assert.equal(r.ok, false); assert.ok(r.errors.length > 0);
  }
});
