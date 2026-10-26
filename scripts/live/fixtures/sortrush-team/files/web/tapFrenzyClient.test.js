const test = require("node:test");
const assert = require("node:assert/strict");
const { createTapClient } = require("./tapFrenzyClient");
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
test("tap client: start then finish returns the server score", () => {
  const calls = [];
  const api = (method, path, body) => { calls.push(path); return path.endsWith("start") ? { status: 200, body: { session_id: "gs_1" } } : { status: 200, body: { score: 70 } }; };
  const c = createTapClient({ api, store: memory() });
  assert.equal(c.start({ instance_key: "k", qr_code: "q" }).status, "playing");
  assert.equal(c.finish(7).score, 70);
});
