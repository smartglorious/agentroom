import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/core/config";
import { route } from "../src/core/router";
import type { Worker } from "../src/core/types";
import { Fake, idle, makeRoom } from "./helpers";

const W = (id: string, coordinator = false) => ({ id, name: id, role: id, account: "c", coordinator, skills: [], useSkills: [], allowedTools: [], worktree: false } as unknown as Worker);
const workers = [W("lead", true), W("qa"), W("dev")];
const opts = { maxAgentHops: 6, maxFanout: 3 };

test("route: at the hop limit a worker's report still reaches the coordinator, and nobody else", () => {
  assert.deepEqual(route({ from: "qa", text: "@lead xong", depth: 6 }, workers, opts), ["lead"]);
  assert.deepEqual(route({ from: "qa", text: "@dev làm tiếp", depth: 6 }, workers, opts), [], "a worker-to-worker hop stays limited");
  assert.deepEqual(route({ from: "qa", text: "xong\ncc: @lead", depth: 6 }, workers, opts), [], "a cc line still wakes nobody");
});

// A long chain: user -> dev -> qa (two turns, the chain limit is 2), then qa reports to the coordinator. Before the change the report was
// dropped as over the chain limit, so the coordinator never woke.
test("room: a report to the coordinator passes a chain that has used its turns; ordinary hops do not", async () => {
  const replies: Record<string, string> = { dev: "@qa kiểm tra giúp", qa: "@lead báo cáo kết quả", lead: "[NOOP]" };
  const fake = new Fake((req) => replies[req.worker.id] ?? "[NOOP]");
  const cfg = parseConfig(`accounts: { c: { provider: claude, maxConcurrent: 3 } }
limits: { chainTurns: 2 }
workers:
  - { id: lead, name: Lan, role: Lead, account: c, coordinator: true }
  - { id: qa, name: Q, role: QA, account: c }
  - { id: dev, name: D, role: Dev, account: c }
`);
  const { room } = makeRoom(fake, { config: cfg });
  room.post("user", "@dev làm việc");
  await idle(room);
  await new Promise((r) => setTimeout(r, 100));
  const woken = fake.calls.map((c) => c.worker.id);
  assert.ok(woken.includes("lead"), `the coordinator should wake on the report, woke: ${JSON.stringify(woken)}`);
  room.stopAll();
});
