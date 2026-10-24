import { test } from "node:test";
import assert from "node:assert/strict";
import type { TurnRequest } from "../src/adapters/types";
import { parseConfig } from "../src/core/config";
import { RateLimitError, Scheduler } from "../src/core/scheduler";
import { Fake, idle, makeRoom } from "./helpers";

const CFG = (extra = "") => `accounts:
  main: { provider: claude, maxConcurrent: 2 }
  ds: { provider: claude, baseUrl: "https://api.deepseek.com/anthropic", authTokenEnv: DS_KEY, maxConcurrent: 2 }
  other: { provider: codex, maxConcurrent: 1 }
workers:
  - { id: lead, name: Lan, role: Lead, account: main, coordinator: true }
  - { id: qa, name: Hà, role: QA, account: main, model: claude-haiku-5-5${extra} }
`;
const settle = (room: import("../src/core/room").Room) => new Promise<void>((r) => setTimeout(r, 40)).then(() => idle(room)).then(() => new Promise<void>((r) => setTimeout(r, 40)));
const accounts = (fake: Fake) => fake.calls.map((c) => `${c.worker.id}:${c.account.id}`);

test("fallback config: same provider and host required, unknown/self rejected, default empty", () => {
  assert.deepEqual(parseConfig(CFG()).workers[1].fallback, []);
  assert.deepEqual(parseConfig(CFG(", fallback: [ds]")).workers[1].fallback, ["ds"]);
  assert.throws(() => parseConfig(CFG(", fallback: [nope]")), /không phải account/);
  assert.throws(() => parseConfig(CFG(", fallback: [main]")), /chính account/);
  assert.throws(() => parseConfig(CFG(", fallback: [other]")), /cùng provider/);
});

test("fallback: a rate limit on the main account moves the same messages to the fallback at once, with its own session and no Claude model name", async () => {
  let n = 0;
  const fake = new Fake((req: TurnRequest) => {
    if (req.account.id === "main") throw new RateLimitError("usage limit reached", 3_600_000);
    return { sessionId: `ds-${++n}`, text: "xong trên ds" };
  });
  const r = makeRoom(fake, { config: parseConfig(CFG(", fallback: [ds]")), scheduler: new Scheduler({ baseBackoffMs: 3_600_000 }) });
  r.room.post("user", "@qa kiểm tra giúp");
  await settle(r.room);
  assert.deepEqual(accounts(fake), ["qa:main", "qa:ds"]);
  assert.equal(fake.calls[1].worker.model, undefined, "the Claude model name is not sent to another endpoint");
  assert.equal(fake.calls[1].sessionId, undefined, "a fallback account starts its own session");
  const texts = r.room.snapshot().messages.map((m) => m.text);
  assert.ok(texts.some((t) => /🔀 Hà tạm chạy trên account ds vì account main/.test(t)));
  assert.ok(texts.some((t) => t === "xong trên ds"), "the answer reached the chat");
  assert.ok(!texts.some((t) => /🔀/.test(t) && t.includes("@")), "notices carry no @");
  // while main is held, the next message goes straight to the fallback (the session is reused)
  r.room.post("user", "@qa thêm một việc");
  await settle(r.room);
  assert.deepEqual(accounts(fake).slice(2), ["qa:ds"]);
  assert.equal(fake.calls[2].sessionId, "ds-1", "the fallback session is resumed");
  assert.equal(texts.filter((t) => /🔀/.test(t)).length, 1, "announced once");
});

test("fallback: when the main account is free again the worker goes back to it, announced once; without a fallback nothing changes", async () => {
  const sched = new Scheduler();
  const fake = new Fake((req: TurnRequest) => ({ sessionId: `s-${req.account.id}`, text: "ok" }));
  const r = makeRoom(fake, { config: parseConfig(CFG(", fallback: [ds]")), scheduler: sched });
  sched.pauseUntil("main", Date.now() + 3_600_000);
  r.room.post("user", "@qa một");
  await settle(r.room);
  sched.resume("main");
  r.room.post("user", "@qa hai");
  await settle(r.room);
  assert.deepEqual(accounts(fake), ["qa:ds", "qa:main"]);
  const texts = r.room.snapshot().messages.map((m) => m.text);
  assert.equal(texts.filter((t) => /↩️ Hà quay về account main/.test(t)).length, 1);

  const plain = new Fake((req: TurnRequest) => { if (req.account.id === "main" && plain.calls.length === 1) throw new RateLimitError("usage limit", 20); return "ok"; });
  const p = makeRoom(plain, { config: parseConfig(CFG()), scheduler: new Scheduler({ baseBackoffMs: 20 }) });
  p.room.post("user", "@qa thử");
  await new Promise((x) => setTimeout(x, 300));
  assert.deepEqual(accounts(plain), ["qa:main", "qa:main"], "no fallback configured: wait and retry on the same account, as before");
});

test("fallback: turns already queued on a blocked account are sent to the fallback", async () => {
  const sched = new Scheduler();
  const fake = new Fake(async (req: TurnRequest) => { if (req.worker.id === "lead") await new Promise((x) => setTimeout(x, 150)); return `ok ${req.worker.id}`; });
  const r = makeRoom(fake, { config: parseConfig(CFG(", fallback: [ds]")), scheduler: sched });
  sched.setLimit("main", 1);   // after the room set the limits from the config
  r.room.post("user", "@lead trước");   // occupies main's only slot
  r.room.post("user", "@qa sau");       // queued behind it
  await new Promise((x) => setTimeout(x, 30));
  (r.room as unknown as { deps: { scheduler: Scheduler } }).deps.scheduler.pauseUntil("main", Date.now() + 3_600_000);
  (r.room as unknown as { rebalance(a: string): void }).rebalance("main");
  await settle(r.room);
  assert.ok(accounts(fake).includes("qa:ds"), "the queued turn ran on the fallback");
});
