import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENTROOM_TOOL_MANIFESTS, executeToolWithLimits, ToolManifestRegistry, ToolRuntimeError } from "../src/gateway/tools";

test("tool gateway: every AgentRoom tool has typed policy effects and unknown tools fail closed", () => {
  const registry = new ToolManifestRegistry(AGENTROOM_TOOL_MANIFESTS);
  assert.deepEqual(registry.list().map((manifest) => manifest.id),
    ["ask_user", "claim_task", "complete_task", "create_task", "forget", "journal", "list_tasks", "post_message", "propose_skill", "read_channel", "recall", "remember"]);
  assert.deepEqual(registry.policyInput("forget"), { tool: "forget", risk: "destructive",
    effects: { files: "delete", network: "local", process: "none", secrets: "none" }, idempotent: true });
  assert.throws(() => registry.policyInput("shell_magic"), /deny by default/);
  assert.throws(() => registry.register(AGENTROOM_TOOL_MANIFESTS[0]), /already registered/);
});

test("tool gateway: timeout aborts with unknown outcome and oversized output never reaches context", async () => {
  const manifest = AGENTROOM_TOOL_MANIFESTS[0];
  let aborted = false;
  await assert.rejects(executeToolWithLimits(manifest, (signal) => new Promise<string>((resolve) => {
    signal.addEventListener("abort", () => { aborted = true; resolve("too late"); });
  }), { timeoutMs: 5 }), (error: unknown) => error instanceof ToolRuntimeError && error.code === "timeout_unknown_effect");
  assert.equal(aborted, true);
  await assert.rejects(executeToolWithLimits(manifest, async () => "123456", { maxOutputBytes: 5 }),
    (error: unknown) => error instanceof ToolRuntimeError && error.code === "output_too_large");
  assert.deepEqual(await executeToolWithLimits(manifest, async () => ({ ok: true })),
    { value: { ok: true }, outputBytes: 11, truncated: false });
});
