import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentAdapter, TurnRequest, TurnResult } from "../src/adapters/types";
import { parseConfig } from "../src/core/config";
import { buildPersona } from "../src/core/prompt";
import { Room, isNoop } from "../src/core/room";
import { Fake, idle, makeRoom } from "./helpers";

const CFG = (limits = "") => `${limits}accounts: { c: { provider: claude, maxConcurrent: 3 } }
workers:
  - { id: lead, name: Lan, role: Lead, account: c, coordinator: true }
  - { id: be, name: Minh, role: Backend, account: c }
  - { id: qa, name: Hà, role: QA, account: c }
`;
const rig = (reply: (req: TurnRequest) => string | TurnResult, o: { limits?: string; debounce?: number } = {}) => {
  const fake = new Fake(reply);
  const r = makeRoom(fake, { config: parseConfig(CFG(o.limits ?? "")) });
  return { fake, ...r };
};
const settle = (room: Room) => new Promise<void>((r) => setTimeout(r, 40)).then(() => idle(room)).then(() => new Promise<void>((r) => setTimeout(r, 40)));
const sys = (room: Room) => room.snapshot().messages.filter((m) => m.from === "system");

test("limits: one human message can set off only so many worker turns, then work stops with one clear notice", async () => {
  let n = 0;
  const { fake, room } = rig((req) => `${req.worker.id === "lead" ? "@be" : "@lead"} làm tiếp bước ${++n}`, { limits: "limits: { chainTurns: 4 }\n" });
  room.post("user", "@lead bắt đầu");
  await settle(room);
  assert.equal(fake.calls.length, 4, "exactly the allowed number of turns");
  const notices = sys(room).filter((m) => m.text.startsWith("🧯"));
  assert.equal(notices.length, 1, "announced once, not once per blocked message");
  assert.ok(notices[0].alert && !notices[0].text.includes("@") || notices[0].text.includes("@tên-worker"), "it is an alert");
  assert.match(notices[0].text, /4 lượt/);
  assert.match(notices[0].text, /limits\.chainTurns/);

  // the human typing again starts a fresh conversation with a fresh allowance
  room.post("user", "@be tiếp đi");
  await settle(room);
  assert.equal(fake.calls.length, 8);
});

test("limits: a human message is never blocked, whatever the earlier conversation used up", async () => {
  let n = 0;
  const { fake, room } = rig(() => `@lead @be @qa xong ${++n}`, { limits: "limits: { chainTurns: 2 }\n" });
  room.post("user", "@lead a");
  await settle(room);
  const before = fake.calls.length;
  room.post("user", "@qa b");
  await settle(room);
  assert.ok(fake.calls.length > before, "the user can always talk to a worker");
});

test("limits: the conversation id follows the work, including task assignments made by a worker's tool call", async () => {
  const { room, fake } = rig((req) => {
    if (req.worker.id === "lead") room.createTask("lead", { title: "API", assignee: "be" });
    return "đã giao";
  });
  const root = room.post("user", "@lead lên kế hoạch");
  await settle(room);
  const msgs = room.snapshot().messages;
  const lead = msgs.find((m) => m.from === "lead")!;
  const assign = msgs.find((m) => m.from === "system" && /được giao task/.test(m.text))!;
  assert.equal(root.chain, root.id, "a human message starts a conversation");
  assert.equal(lead.chain, root.id);
  assert.equal(assign.chain, root.id, "the assignment belongs to the same conversation");
  assert.ok(fake.calls.some((c) => c.worker.id === "be"), "…and still woke the assignee");
});

test("limits: a task that has cost too much stops agent-to-agent work on it, but the user can still continue it", async () => {
  const cost = (c: number): TurnResult => ({ text: "@qa kiểm tra giúp", sessionId: "s", usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, costUsd: c, estimated: false } });
  const { fake, room } = rig((req) => (req.worker.id === "qa" ? "ok xong" : cost(0.05)), { limits: "limits: { usdPerTask: 0.04 }\n" });
  room.post("user", "@be làm việc", { taskId: "T1" });
  await settle(room);
  const callsAfterFirst = fake.calls.length;
  const notices = sys(room).filter((m) => /Task T1 đã tốn/.test(m.text));
  assert.equal(notices.length, 1, "told once");
  assert.ok(notices[0].alert);
  assert.equal(fake.calls.filter((c) => c.worker.id === "qa").length, 0, "qa was not woken by be's message on the expensive task");
  room.post("user", "@be tiếp tục nhé", { taskId: "T1" });
  await settle(room);
  assert.ok(fake.calls.length > callsAfterFirst, "the user can continue the task");
});

test("noop: a reply of [NOOP] to another worker is not posted and wakes nobody; a human always gets an answer", async () => {
  const { fake, room } = rig((req) => (req.worker.id === "be" ? "[NOOP]" : "@be xem giúp"));
  room.post("user", "@lead bắt đầu");
  await settle(room);
  const msgs = room.snapshot().messages;
  assert.equal(msgs.filter((m) => m.from === "be").length, 0, "be said nothing new, so nothing was posted");
  assert.equal(room.suppressed.noop, 1);
  assert.equal(fake.calls.length, 2, "lead, then be, and nobody woken by the empty answer");

  room.post("user", "@be bạn khỏe không?");
  await settle(room);
  const reply = room.snapshot().messages.filter((m) => m.from === "be");
  assert.deepEqual(reply.map((m) => m.text), ["[NOOP]"], "when a human asked, even [NOOP] is shown instead of silence");
  assert.equal(room.suppressed.noop, 1);
});

test("noop: the exact forms that count", () => {
  for (const t of ["[NOOP]", "[noop]", "  [NOOP] không có gì", "NOOP", "noop."]) assert.ok(isNoop(t), t);
  for (const t of ["NOOPS", "không noop", "tôi sẽ không làm gì", "", "đã [NOOP] rồi"]) assert.ok(!isNoop(t), t);
});

test("repeat: the same answer twice in one conversation is not posted again", async () => {
  let n = 0;
  const { fake, room } = rig((req) => (req.worker.id === "be" ? "@lead Đã xong, file add.js đúng yêu cầu." : `@be kiểm tra lần ${++n}`), { limits: "limits: { chainTurns: 20 }\n" });
  room.post("user", "@lead bắt đầu");
  await settle(room);
  assert.equal(room.snapshot().messages.filter((m) => m.from === "be").length, 1, "the second identical report was dropped");
  assert.equal(room.suppressed.repeat >= 1, true);
  assert.ok(fake.calls.length >= 3);
});

test("debounce: replies that arrive together are answered in one turn", async () => {
  const fake = new Fake(() => "ok");
  const a = makeRoom(fake, { config: parseConfig(CFG()) });
  const room = new Room({ ...a.deps, options: { ...a.deps.options, agentDebounceMs: 80 } });
  room.post("lead", "@be việc một", { depth: 1 });
  room.post("qa", "@be việc hai", { depth: 1 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fake.calls.length, 0, "still waiting");
  await settle(room);
  assert.equal(fake.calls.filter((c) => c.worker.id === "be").length, 1, "one turn for both");
  const p = fake.calls.find((c) => c.worker.id === "be")!.prompt;
  assert.match(p, /việc một/);
  assert.match(p, /việc hai/);
});

test("debounce: a human message does not wait, and stopping a worker cancels what was waiting for it", async () => {
  const fake = new Fake(() => "ok");
  const a = makeRoom(fake, { config: parseConfig(CFG()) });
  const room = new Room({ ...a.deps, options: { ...a.deps.options, agentDebounceMs: 200 } });
  room.post("user", "@be ngay");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fake.calls.filter((c) => c.worker.id === "be").length, 1, "no delay for people");
  room.post("lead", "@qa việc", { depth: 1 });
  room.stop("qa");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fake.calls.filter((c) => c.worker.id === "qa").length, 0, "the pending wake-up was cancelled");
});

test("rules: the persona tells workers about [NOOP] and not to @mention just to thank", () => {
  const cfg = parseConfig(CFG());
  const p = buildPersona(cfg.workers[1], cfg.workers);
  assert.match(p.stable.text, /\[NOOP\]/);
  assert.match(p.stable.text, /Đừng @mention ai chỉ để cảm ơn/);
});

test("config: limits default to 6 turns per conversation, 3 workers woken per worker message and no task budget; bad values are rejected", () => {
  const d = parseConfig(CFG());
  assert.deepEqual(d.limits, { chainTurns: 6, maxFanout: 3 });
  const c = parseConfig(CFG("limits: { chainTurns: 6, usdPerTask: 0.5 }\n"));
  assert.deepEqual(c.limits, { chainTurns: 6, maxFanout: 3, usdPerTask: 0.5 });
  assert.equal(parseConfig(CFG("limits: { maxFanout: 1 }\n")).limits.maxFanout, 1);
  assert.throws(() => parseConfig(CFG("limits: { maxFanout: 0 }\n")));
  assert.throws(() => parseConfig(CFG("limits: { chainTurns: 1 }\n")));
  assert.throws(() => parseConfig(CFG("limits: { usdPerTask: 0 }\n")));
});

import { route, withoutCc } from "../src/core/router";

const team = parseConfig(`accounts: { c: { provider: claude, maxConcurrent: 3 } }
workers:
${["lead", "be", "fe", "qa", "fw"].map((id) => `  - { id: ${id}, name: ${id}, role: x, account: c${id === "lead" ? ", coordinator: true" : ""} }`).join("\n")}
`).workers;

test("router: a worker's cc:/FYI: lines wake nobody, and one worker message wakes at most maxFanout workers", () => {
  const o = { maxAgentHops: 6, maxFanout: 3 };
  assert.deepEqual(route({ from: "lead", depth: 1, text: "@be làm A\ncc: @qa @fe @fw" }, team, o), ["be"]);
  assert.deepEqual(route({ from: "lead", depth: 1, text: "xong\n  FYI: @be, @qa" }, team, o), []);
  assert.deepEqual(route({ from: "lead", depth: 1, text: "@be @fe @qa @fw việc" }, team, o), ["be", "fe", "qa"], "first three mentioned");
  assert.equal(route({ from: "lead", depth: 1, text: "@all x" }, team, o).length, 3);
  assert.deepEqual(route({ from: "user", depth: 0, text: "@be @fe @qa @fw @lead" }, team, o), ["be", "fe", "qa", "fw", "lead"], "a person is never limited");
  assert.deepEqual(route({ from: "lead", depth: 1, text: "@be @fe @qa @fw" }, team, { maxAgentHops: 6 }), ["be", "fe", "qa", "fw"], "no limit when not set");
  assert.equal(withoutCc("a\ncc: @x\nb"), "a\n\nb");
});

test("room: a worker's message with cc lines wakes only the asked worker; the persona teaches the cc and fan-out rules", async () => {
  const { fake, room } = rig((req) => (req.worker.id === "lead" ? "@be làm bước 1\ncc: @qa" : "[NOOP]"));
  room.post("user", "@lead bắt đầu");
  await settle(room);
  assert.ok(fake.calls.some((c) => c.worker.id === "be"));
  assert.ok(!fake.calls.some((c) => c.worker.id === "qa"), "cc did not wake qa");
  const p = buildPersona(parseConfig(CFG()).workers[1], parseConfig(CFG()).workers);
  assert.match(p.stable.text, /bắt đầu bằng `cc:`/);
});
