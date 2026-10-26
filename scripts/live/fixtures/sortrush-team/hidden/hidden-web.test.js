const test = require("node:test");
const assert = require("node:assert/strict");
const { http, db, tenants, configs, rewards } = require("./index");
const { createSortRushClient } = require("./web/sortRushClient");

const cfg = () => ({
  ui: { title: "Sort" },
  logic: { duration_seconds: 30, max_plays_per_participant: 3, base_points: 100, wrong_penalty: 25, combo_every: 3 },
  categories: [{ id: "recycle", label: "Recycle" }, { id: "compost", label: "Compost" }],
  items: ["a", "b", "c", "d", "e", "f"].map((id, i) => ({ id, label: id.toUpperCase(), category_id: i % 2 ? "compost" : "recycle" })),
});
const truth = Object.fromEntries(cfg().items.map((i) => [i.id, i.category_id]));
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };
const world = () => {
  db.reset(); tenants.addCampaign("t1", "c1");
  configs.publishInstance({ key: "k1", campaignSlug: "c1", type: "sort_rush", config: cfg() });
  tenants.addParticipant({ id: "p1", campaignSlug: "c1", qrCode: "qr1" });
  tenants.addParticipant({ id: "p2", campaignSlug: "c1", qrCode: "qr2" });
};
let clock = 1000;
const live = () => (method, path, body) => http.handle(method, path, body, { now: clock });
const START = { campaign_slug: "c1", instance_key: "k1", qr_code: "qr1" };

test("client: start gives a view model without the answer key; a reload reuses the same session", () => {
  world();
  const store = memory();
  const a = createSortRushClient({ api: live(), store }).start(START);
  assert.equal(a.status, "playing"); assert.equal(a.items.length, 6);
  assert.ok(!JSON.stringify(a).includes("category_id"));
  const b = createSortRushClient({ api: live(), store }).start(START);
  assert.equal(b.sessionId, a.sessionId);
  assert.equal(db.table("game_sessions").length, 1);
});

test("client: errors and the play limit become statuses", () => {
  world();
  assert.deepEqual(createSortRushClient({ api: live(), store: memory() }).start({ ...START, qr_code: "nope" }), { status: "error", reason: 403 });
  for (let i = 0; i < 3; i += 1) assert.equal(createSortRushClient({ api: live(), store: memory() }).start(START).status, "playing");
  assert.equal(createSortRushClient({ api: live(), store: memory() }).start(START).status, "limit");
});

test("client: drop shows the server score and answered items; a double drop does not break", () => {
  world();
  const c = createSortRushClient({ api: live(), store: memory() }); c.start(START);
  const r1 = c.drop("a", truth.a);
  assert.equal(r1.correct, true); assert.equal(r1.score, 100); assert.deepEqual(r1.answered, ["a"]);
  const again = c.drop("a", truth.a);
  assert.deepEqual(again.answered, ["a"]);
  const wrong = c.drop("b", truth.b === "recycle" ? "compost" : "recycle");
  assert.equal(wrong.correct, false); assert.equal(wrong.score, 75);
  assert.ok(!JSON.stringify(wrong).includes("category_id"));
});

test("client: offline actions are queued, replayed with the same event_id, and recorded once", () => {
  world();
  const store = memory(); let down = false; const sent = [];
  const api = (m, p, b) => { if (down) throw new Error("offline"); if (b?.event_id) sent.push(b.event_id); return live()(m, p, b); };
  const c = createSortRushClient({ api, store }); c.start(START);
  down = true;
  const off = c.drop("a", truth.a);
  assert.equal(off.status, "offline"); assert.equal(off.queued, 1);
  assert.equal(c.drop("b", truth.b).queued, 2);
  assert.equal(c.finish().status, "pending");
  down = false;
  assert.equal(c.flush(), 2);
  assert.equal(c.flush(), 0);
  const sid = JSON.parse(JSON.stringify(c.resume({ qr_code: "qr1" }))).sessionId;
  assert.deepEqual(http.handle("GET", `/public/sort-rush/state/${sid}?qr_code=qr1`, {}, { now: clock }).body.answered, ["a", "b"], "recorded once each");
  assert.equal(new Set(sent).size, sent.length, "each queued action keeps one event_id");
});

test("client: finish flushes, takes the server score and never a local one", () => {
  world();
  const c = createSortRushClient({ api: live(), store: memory() }); c.start(START);
  for (const id of ["a", "b", "c"]) c.drop(id, truth[id]);
  const done = c.finish();
  assert.equal(done.status, "done"); assert.equal(done.score, 400); assert.equal(done.reward_eligible, true);
  assert.equal(rewards.rewardCount(), 1);
  assert.equal(rewards.rewardCount(), 1);
});

test("client: resume restores progress in a new client; another participant's session is dropped", () => {
  world();
  const store = memory();
  const c1 = createSortRushClient({ api: live(), store }); c1.start(START); c1.drop("a", truth.a);
  const c2 = createSortRushClient({ api: live(), store });
  const r = c2.resume({ qr_code: "qr1" });
  assert.equal(r.status, "playing"); assert.deepEqual(r.answered, ["a"]); assert.equal(r.score, 100); assert.equal(r.remaining.length, 5);
  assert.equal(c2.drop("b", truth.b).answered.length, 2, "the counter survives the reload, so event ids do not collide");
  const c3 = createSortRushClient({ api: live(), store });
  assert.equal(c3.resume({ qr_code: "qr2" }).status, "none");
  assert.equal(createSortRushClient({ api: live(), store: memory() }).resume({ qr_code: "qr1" }).status, "none");
});

test("client: an expired session is reported", () => {
  world(); clock = 1000;
  const c = createSortRushClient({ api: live(), store: memory() }); c.start(START);
  clock = 1000 + 40_000;
  assert.equal(c.drop("a", truth.a).status, "expired");
  clock = 1000;
});
