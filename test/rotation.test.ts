import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/core/config";
import { BASH_OUTPUT_CHARS } from "../src/adapters/claude";
import { Fake, idle, makeRoom } from "./helpers";

const CFG = (extra = "") => `accounts: { c: { provider: claude, maxConcurrent: 3 } }
workers:
  - { id: lead, name: Lan, role: Lead, account: c, coordinator: true }
  - { id: be, name: Minh, role: Backend, account: c${extra} }
`;
const usage = (ctx: number, calls = 1) => ({ input: 10, output: 100, cacheRead: Math.round(ctx * calls * 0.9), cacheWrite: Math.round(ctx * calls * 0.1) - 10, costUsd: 0.1, estimated: false, numTurns: calls });
const run = async (cfg: string, ctx: number, calls = 1) => {
  // The first turn is small (a fresh session); the second reaches `ctx`.
  let n = 0;
  const fake = new Fake((req) => ({ sessionId: `s-${req.worker.id}`, text: "ok", usage: usage(++n === 1 ? 20_000 : ctx, calls) }));
  const r = makeRoom(fake, { config: parseConfig(cfg) });
  r.room.post("user", "@be làm");
  await idle(r.room);
  r.room.post("user", "@be làm tiếp");
  await idle(r.room);
  r.room.post("user", "@be làm nữa");
  await idle(r.room);
  return { fake, r };
};

test("rotation: a session whose context passed the limit is replaced on the next turn, which gets memory and journal again", async () => {
  const { fake, r } = await run(CFG(", contextLimit: 100000"), 120_000);
  assert.equal(fake.calls[0].sessionId, undefined);
  assert.equal(fake.calls[2].sessionId, undefined, "the turn after the big one starts a new session");
  assert.match(r.room.snapshot().messages.map((m) => m.text).join("\n"), /♻️ Session của Minh/);
  assert.ok(!r.room.snapshot().messages.some((m) => m.text.includes("@") && /♻️/.test(m.text)), "the notice has no @");
});

test("rotation: below the limit the session is kept; the average per call is used for multi-call turns", async () => {
  const keep = await run(CFG(", contextLimit: 100000"), 60_000, 5);
  assert.equal(keep.fake.calls[2].sessionId, "s-be");
  assert.ok(!keep.r.room.snapshot().messages.some((m) => /♻️/.test(m.text)));
});

test("rotation: default 150k for workers, never for the coordinator unless set; 0 turns it off", async () => {
  const def = await run(CFG(), 170_000);
  assert.equal(def.fake.calls[2].sessionId, undefined, "default limit applies to a normal worker");
  const small = await run(CFG(), 140_000);
  assert.equal(small.fake.calls[2].sessionId, "s-be");
  const off = await run(CFG(", contextLimit: 0"), 400_000);
  assert.equal(off.fake.calls[2].sessionId, "s-be");
  const fake = new Fake((req) => ({ sessionId: `s-${req.worker.id}`, text: "ok", usage: usage(400_000) }));
  const r = makeRoom(fake, { config: parseConfig(CFG()) });
  r.room.post("user", "@lead a"); await idle(r.room);
  r.room.post("user", "@lead b"); await idle(r.room);
  assert.equal(fake.calls[1].sessionId, "s-lead", "the coordinator keeps its session");
});

test("bash output cap is set below Claude Code's own default of 30000 characters", () => {
  assert.ok(Number(BASH_OUTPUT_CHARS) < 30000 && Number(BASH_OUTPUT_CHARS) >= 5000);
});

test("rotation: a fresh session that already weighs more than the limit is not replaced every turn; it is replaced once it has grown well past that base", async () => {
  const ctxs = [90_000, 92_000, 95_000, 150_000, 40_000];
  let n = 0;
  const fake = new Fake((req) => ({ sessionId: `s${n}`, text: "ok", usage: usage(ctxs[Math.min(n++, ctxs.length - 1)]) }));
  const r = makeRoom(fake, { config: parseConfig(CFG(", contextLimit: 80000")) });
  for (const t of ["a", "b", "c", "d", "e"]) { r.room.post("user", `@be ${t}`); await idle(r.room); }
  const resumed = fake.calls.map((c) => c.sessionId !== undefined);
  // turn 1 fresh (base 90K, over the limit but not 1.5x), 2-3 resumed, turn 4 grows to 150K (> 135K) → turn 5 fresh
  assert.deepEqual(resumed, [false, true, true, true, false]);
  assert.equal(r.room.snapshot().messages.filter((m) => /♻️/.test(m.text)).length, 1, "one rotation, not one per turn");
});
