import { test } from "node:test";
import assert from "node:assert/strict";
import { droppedByHops, route } from "../src/core/router";
import type { Worker } from "../src/core/types";
import { Fake, idle, makeRoom } from "./helpers";
import { parseConfig } from "../src/core/config";

const W = (id: string, coordinator = false) => ({ id, name: id, role: id, account: "c", coordinator, skills: [], useSkills: [], allowedTools: [], worktree: false } as unknown as Worker);
const workers = [W("lead", true), W("qa"), W("be")];
const opts = { maxAgentHops: 6, maxFanout: 3 };

test("droppedByHops: a worker's ask cut by the hop limit is reported, a coordinator report is not", () => {
  assert.deepEqual(droppedByHops({ from: "be", text: "@qa kiểm tra giúp", depth: 6 }, workers, opts), ["qa"]);
  assert.deepEqual(droppedByHops({ from: "be", text: "@lead xong", depth: 6 }, workers, opts), [], "the coordinator still gets it, nothing to report");
  assert.deepEqual(droppedByHops({ from: "be", text: "@qa kiểm tra", depth: 2 }, workers, opts), [], "below the limit nothing is cut");
  assert.deepEqual(droppedByHops({ from: "be", text: "xong\ncc: @qa", depth: 6 }, workers, opts), [], "a cc line asks nobody");
  assert.deepEqual(route({ from: "be", text: "@qa kiểm tra giúp", depth: 6 }, workers, opts), [], "and still wakes nobody");
});

test("room: the cut is announced once per conversation, with no @ in the notice", async () => {
  const replies: Record<string, string> = { be: "@qa kiểm tra giúp", qa: "@be cảm ơn", lead: "[NOOP]" };
  const fake = new Fake((req) => replies[req.worker.id] ?? "[NOOP]");
  const cfg = parseConfig(`accounts: { c: { provider: claude, maxConcurrent: 3 } }
limits: { chainTurns: 12 }
options: {}
workers:
  - { id: lead, name: Lan, role: Lead, account: c, coordinator: true }
  - { id: qa, name: Tuấn, role: QA, account: c }
  - { id: be, name: Minh, role: Backend, account: c }
`);
  const { room } = makeRoom(fake, { config: cfg, options: { maxAgentHops: 2, contextMessages: 30, memoryBudgetChars: 12000 } as never });
  room.post("user", "@be bắt đầu");
  await idle(room);
  await new Promise((r) => setTimeout(r, 100));
  const notices = room.snapshot().messages.filter((m) => m.from === "system" && m.text.startsWith("🧯"));
  assert.equal(notices.length, 1, `one notice for the conversation, got ${notices.length}`);
  assert.match(notices[0].text, /Tuấn/, "names the person who was cut off");
  assert.ok(!notices[0].text.includes("@"), "no @ in a system notice");
  room.stopAll();
});
