import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/core/router";
import type { Worker } from "../src/core/types";

const W = (id: string, coordinator = false) => ({ id, name: id, role: id, account: "c", coordinator, skills: [], useSkills: [], allowedTools: [], worktree: false } as unknown as Worker);
const workers = [W("lead", true), W("qa"), W("dev")];
const opts = { maxAgentHops: 6, maxFanout: 3 };

// Past the hop limit a worker's report still reaches the coordinator (the escalation point), and nobody else.
test("route: at the hop limit a worker's report still reaches the coordinator, and nobody else", () => {
  assert.deepEqual(route({ from: "qa", text: "@lead xong", depth: 6 }, workers, opts), ["lead"]);
  assert.deepEqual(route({ from: "qa", text: "@dev làm tiếp", depth: 6 }, workers, opts), [], "a worker-to-worker hop stays limited");
  assert.deepEqual(route({ from: "qa", text: "xong\ncc: @lead", depth: 6 }, workers, opts), [], "a cc line still wakes nobody");
});
