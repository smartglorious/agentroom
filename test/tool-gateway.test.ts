import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENTROOM_TOOL_MANIFESTS, DurableToolGateway, executeToolWithLimits, ToolManifestRegistry, ToolRuntimeError } from "../src/gateway/tools";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteConnection } from "../src/storage/sqlite";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { schemaMigrations } from "../src/storage/schema-v1";
import { SqliteToolReceiptStore } from "../src/storage/tool-receipts";

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

test("tool gateway: durable intent includes policy input and fences ambiguous retry", async () => {
  const db = await SqliteConnection.open(join(mkdtempSync(join(tmpdir(), "ar-tool-gateway-")), "agentroom.db"));
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.exec(`
    INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1','W','file:///w',1,1);
    INSERT INTO tasks(id, workspace_id, title, status, created_by, created_at, updated_at) VALUES ('t1','w1','T','todo','user',1,1);
    INSERT INTO runs(id, workspace_id, task_id, status, attempt, created_at, updated_at) VALUES ('r1','w1','t1','running',1,1,1);
    INSERT INTO steps(id, workspace_id, run_id, ordinal, kind, status, idempotency_key, version, created_at, updated_at) VALUES ('s1','w1','r1',0,'tool','running','k',1,1,1);
  `);
  try {
    const gateway = new DurableToolGateway(new ToolManifestRegistry(AGENTROOM_TOOL_MANIFESTS), new SqliteToolReceiptStore(db));
    const done = await gateway.execute({ workspaceId: "w1", stepId: "s1", semanticKey: "remember:1", toolId: "remember", args: { text: "x" }, run: async () => ({ ok: true }) });
    assert.equal(done.receipt.status, "succeeded");
    assert.deepEqual((done.receipt.receipt as any).policy_input.effects.files, "write");
    await assert.rejects(gateway.execute({ workspaceId: "w1", stepId: "s1", semanticKey: "remember:1", toolId: "remember", args: { text: "x" }, run: async () => ({ ok: true }) }), /reconcile before retry/);
  } finally { await db.close(); }
});
