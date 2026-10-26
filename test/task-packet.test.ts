import { test } from "node:test";
import assert from "node:assert/strict";
import { allocatePacketTokens, canonicalJson, fitContextToBudget, sealTaskPacketV1, TASK_PACKET_V1_JSON_SCHEMA, verifyTaskPacketV1 } from "../src/context/task-packet";

const input = () => ({
  run_id: "r1", step_id: "s1", objective: "Review the migration",
  constraints: { deadline: null, max_output_tokens: 800 },
  identity: { agent_id: "qa", workspace_id: "w1" },
  policy: { autonomy: "auto", allowed_tools: ["fs.read"] },
  context: [{ content: "migration plan", source_id: "src1", locator: "plan.md#L1", score: 0.9,
    content_hash: "a".repeat(64), retrieval_reason: "lexical: migration", trust: "trusted" as const }],
  memory: [{ memory_id: "mem1", kind: "episodic", confidence: 0.8 }], artifacts: [],
  budget: { input_tokens: 1_000, output_tokens: 800, cost_usd: 0.1 },
  continuation: { checkpoint_id: null, attempt: 1 },
  provenance: { compiler_version: "1.0.0", created_at: "2026-10-26T00:00:00.000Z" },
});

test("TaskPacket v1: seals deterministically, validates strictly and detects tampering", () => {
  const first = sealTaskPacketV1({ ...input(), packet_id: "tp1" });
  const second = sealTaskPacketV1({ ...input(), packet_id: "tp1" });
  assert.equal(first.integrity.sha256, second.integrity.sha256);
  assert.equal(verifyTaskPacketV1(first).schema_version, "1.0");
  assert.throws(() => verifyTaskPacketV1({ ...first, objective: "tampered" }), /checksum mismatch/);
  assert.throws(() => sealTaskPacketV1({ ...input(), extra: true } as any));
  assert.equal(TASK_PACKET_V1_JSON_SCHEMA.additionalProperties, false);
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test("TaskPacket budget: preserves policy allocation and selects whole sources by score", () => {
  assert.deepEqual(allocatePacketTokens(1_003), { policy: 100, objective: 100, recent: 200, sources: 401, memory: 100, reserve: 102 });
  const selected = fitContextToBudget([
    { id: "low", content: "x".repeat(30), score: 0.1 },
    { id: "high", content: "x".repeat(30), score: 0.9 },
  ], 10);
  assert.deepEqual(selected.map((item) => item.id), ["high"]);
  assert.throws(() => allocatePacketTokens(99), /at least 100/);
});
