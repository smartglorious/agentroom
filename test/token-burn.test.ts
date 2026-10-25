import { test } from "node:test";
import assert from "node:assert/strict";
import type { TurnRequest, TurnResult } from "../src/adapters/types";
import { buildClaudeOptions } from "../src/adapters/claude";
import { parseConfig } from "../src/core/config";
import { Room } from "../src/core/room";
import { parseMentions, route, withoutNonRequests } from "../src/core/router";
import { Fake, idle, makeRoom } from "./helpers";

const CFG = (limits = "", extra = "") => `${limits}accounts: { c: { provider: claude, maxConcurrent: 3 }, g: { provider: claude, baseUrl: "https://x.example/anthropic", authTokenEnv: TOK, maxConcurrent: 1 } }
workers:
  - { id: lead, name: Lan, role: Lead, account: c, coordinator: true }
  - { id: be, name: Minh, role: Backend, account: c${extra} }
  - { id: gw, name: Gia, role: Gateway, account: g }
`;
const usage = (ctx: number, cost = 0.1) => ({ input: 10, output: 100, cacheRead: Math.round(ctx * 0.9), cacheWrite: Math.round(ctx * 0.1) - 10, costUsd: cost, estimated: false, numTurns: 1 });
const MIN = 60_000;

async function sessionAfterIdle(o: { ctx: number; idleMin: number; limits?: string; worker?: string }) {
  let clock = 1_000_000;
  const fake = new Fake((req) => ({ sessionId: `s-${req.worker.id}`, text: "ok", usage: usage(o.ctx) }));
  const r = makeRoom(fake, { config: parseConfig(CFG(o.limits ?? "")), now: () => clock });
  const w = o.worker ?? "be";
  r.room.post("user", `@${w} làm`);
  await idle(r.room);
  clock += o.idleMin * MIN;
  r.room.post("user", `@${w} làm tiếp`);
  await idle(r.room);
  return { fake, room: r.room, sessionOfSecond: fake.calls[1].sessionId, notes: r.room.snapshot().messages.filter((m) => m.text.startsWith("🕒")) };
}

test("idle: a big session woken after its cache has expired is replaced by a new one, with a notice that wakes nobody", async () => {
  const r = await sessionAfterIdle({ ctx: 120_000, idleMin: 56 });
  assert.equal(r.sessionOfSecond, undefined, "the second turn starts a new session");
  assert.equal(r.notes.length, 1);
  assert.ok(!r.notes[0].text.includes("@") && r.notes[0].to.length === 0);
  assert.match(r.notes[0].text, /56 phút/);
  assert.match(r.notes[0].text, /120k/);
  assert.match(r.fake.calls[1].prompt, /Trí nhớ|SOUL|Đồng đội/, "memory and teammates are sent again, as for any new session");
});

test("idle: nothing changes while the cache is still alive, for a small session, or when the feature is off", async () => {
  assert.equal((await sessionAfterIdle({ ctx: 120_000, idleMin: 50 })).sessionOfSecond, "s-be", "50 minutes: the cache is still there");
  assert.equal((await sessionAfterIdle({ ctx: 40_000, idleMin: 600 })).sessionOfSecond, "s-be", "a small session is cheap to wake");
  assert.equal((await sessionAfterIdle({ ctx: 120_000, idleMin: 600, limits: "limits: { idleFreshMinutes: 0 }\n" })).sessionOfSecond, "s-be", "0 turns it off");
  assert.equal((await sessionAfterIdle({ ctx: 120_000, idleMin: 90, limits: "limits: { idleFreshMinutes: 120 }\n" })).sessionOfSecond, "s-be", "the threshold is configurable");
});

test("idle: an account on another endpoint (not the plan) is left alone, and the coordinator is covered too", async () => {
  assert.equal((await sessionAfterIdle({ ctx: 120_000, idleMin: 600, worker: "gw" })).sessionOfSecond, "s-gw");
  assert.equal((await sessionAfterIdle({ ctx: 120_000, idleMin: 600, worker: "lead" })).sessionOfSecond, undefined);
});

test("idle: the size and the end of the last turn survive a restart", async () => {
  let clock = 5_000_000;
  const fake = new Fake((req) => ({ sessionId: "s1", text: "ok", usage: usage(100_000) }));
  const first = makeRoom(fake, { config: parseConfig(CFG()), now: () => clock });
  first.room.post("user", "@be a");
  await idle(first.room);
  const meta = first.deps.store.loadSessionMeta()["be:main"];
  assert.equal(meta.end, clock);
  assert.ok(meta.ctx! > 99_000 && meta.ctx! < 101_000);
});

test("quiet mentions: names in a table row or in an \"if\" line wake nobody; plain requests still do", () => {
  const workers = parseConfig(CFG()).workers.map((w) => ({ ...w })) as never;
  const asked = (text: string) => route({ from: "lead", text, depth: 0 }, workers, { maxAgentHops: 6 });
  assert.deepEqual(asked("| Worker | Việc |\n|---|---|\n| @be | chờ |\n| @gw | không có |"), []);
  assert.deepEqual(asked("Nếu cần kiểm tra thì @be xem giúp."), []);
  assert.deepEqual(asked("- If it fails, ask @be."), []);
  assert.deepEqual(asked("Xong phần mình.\n@be hãy chạy test.\nNếu lỗi thì @gw xem."), ["be"]);
  assert.deepEqual(asked("@be làm đi\ncc: @gw"), ["be"]);
  // the person is never filtered
  assert.deepEqual(route({ from: "user", text: "Nếu được thì @be làm", depth: 0 }, workers, { maxAgentHops: 6 }), ["be"]);
  assert.equal(withoutNonRequests("a\n| @x |\nb"), "a\n\nb");
  assert.deepEqual(parseMentions("Nếu @be", workers), ["be"]);
});

test("no double wake: what a worker already woke with post_message is not woken again by its final answer", async () => {
  let room!: Room;
  const fake = new Fake((req: TurnRequest): string | TurnResult => {
    if (req.worker.id === "lead") { room.post("lead", "@be kiểm tra giúp"); return "@be kiểm tra giúp, mình chờ kết quả"; }
    return "[NOOP]";
  });
  const r = makeRoom(fake, { config: parseConfig(CFG()) });
  room = r.room;
  room.post("user", "@lead lo việc này");
  await idle(room);
  assert.equal(fake.calls.filter((c) => c.worker.id === "be").length, 1, "be ran once, not twice");
  const finals = room.snapshot().messages.filter((m) => m.from === "lead");
  assert.equal(finals.length, 2, "both messages are still in the chat");
  assert.deepEqual(finals[1].to, [], "the second names be but wakes nobody");
});

test("no double wake: a final answer that asks somebody new still wakes them", async () => {
  let room!: Room;
  const fake = new Fake((req) => {
    if (req.worker.id === "lead") { room.post("lead", "@be kiểm tra giúp"); return "@gw xem phần của bạn"; }
    return "[NOOP]";
  });
  const r = makeRoom(fake, { config: parseConfig(CFG()) });
  room = r.room;
  room.post("user", "@lead lo việc này");
  await idle(room);
  assert.ok(fake.calls.some((c) => c.worker.id === "gw"));
  assert.ok(fake.calls.some((c) => c.worker.id === "be"));
});

test("maxModelTurns: Claude turns carry the limit (default 60), 0 removes it, and the Claude options pass it on", async () => {
  const fake = new Fake(() => "ok");
  const a = makeRoom(fake, { config: parseConfig(CFG()) });
  a.room.post("user", "@be a");
  await idle(a.room);
  assert.equal(fake.calls[0].maxTurns, 60);
  const fake2 = new Fake(() => "ok");
  const b = makeRoom(fake2, { config: parseConfig(CFG("limits: { maxModelTurns: 0 }\n")) });
  b.room.post("user", "@be a");
  await idle(b.room);
  assert.equal(fake2.calls[0].maxTurns, undefined);
  const base = { worker: a.deps.config.workers[1], cwd: "/x", systemAppend: "", mcpUrl: "http://x", account: a.deps.config.accounts[0], approve: async () => true };
  assert.equal(buildClaudeOptions({ ...base, maxTurns: 25 }, undefined, new AbortController()).maxTurns, 25);
  assert.equal(buildClaudeOptions(base, undefined, new AbortController()).maxTurns, undefined);
});

test("Inspector: the cost of a turn is what the turn cost, not the cumulative cost of the session", async () => {
  let n = 0;
  const costs = [0.1, 0.25];
  const fake = new Fake(() => ({ sessionId: "s1", text: "ok", usage: usage(30_000, costs[n++]) }));
  const r = makeRoom(fake, { config: parseConfig(CFG()) });
  r.room.post("user", "@be a");
  await idle(r.room);
  r.room.post("user", "@be b");
  await idle(r.room);
  const turns = r.deps.usage.all().filter((u) => u.worker === "be");
  const second = r.deps.inspector.load(turns[1].turnId)!;
  assert.ok(Math.abs(turns[1].costUsd! - 0.15) < 1e-9);
  assert.ok(Math.abs(second.usage!.costUsd! - 0.15) < 1e-9, "the Inspector shows the same number as the usage log");
});

test("defaults: limits.idleFreshMinutes 55 and maxModelTurns 60", () => {
  const d = parseConfig(CFG()).limits;
  assert.equal(d.idleFreshMinutes, 55);
  assert.equal(d.maxModelTurns, 60);
});
