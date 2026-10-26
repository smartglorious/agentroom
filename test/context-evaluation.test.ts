import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRetrievalGate, evaluateRetrieval } from "../src/context/evaluation";

test("retrieval evaluation: reports recall, citation precision and ACL leaks", () => {
  const clean = evaluateRetrieval([
    { expectedSourceIds: ["a", "b"], forbiddenSourceIds: ["secret"], retrievedSourceIds: ["a", "b"] },
    { expectedSourceIds: ["c"], retrievedSourceIds: ["c"] },
  ]);
  assert.deepEqual(clean, { cases: 2, recallAtK: 1, citationPrecision: 1, aclLeaks: 0 });
  assert.doesNotThrow(() => assertRetrievalGate(clean));

  const leaking = evaluateRetrieval([
    { expectedSourceIds: ["a", "b"], forbiddenSourceIds: ["secret"], retrievedSourceIds: ["a", "noise", "secret"] },
  ]);
  assert.equal(leaking.recallAtK, 0.5);
  assert.equal(leaking.citationPrecision, 1 / 3);
  assert.equal(leaking.aclLeaks, 1);
  assert.throws(() => assertRetrievalGate(leaking), /ACL leak/);
});
