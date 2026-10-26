import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENARIOS, runScenario } from "./bench/scenarios";

// The harness behind `npm run bench:room`, at a small size: it must show legacy and durable both finish without errors or repeated turns.
for (const scenario of SCENARIOS) {
  for (const mode of ["legacy", "durable"] as const) {
    test(`bench harness: ${scenario} (${mode}) has no errors and no repeated turn`, async () => {
      const result = await runScenario(scenario, mode, { latencyMs: 5, size: 3 });
      assert.deepEqual(result.errors, []);
      assert.equal(result.extraTurns, 0);
      assert.equal(result.ok, true);
    });
  }
}
