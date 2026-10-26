import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { SqliteRunRepository } from "../src/storage/run-events";
import { schemaMigrations } from "../src/storage/schema-v1";
import { SqliteConnection } from "../src/storage/sqlite";
import { SqliteStepRepository } from "../src/storage/step-events";
import { SqliteToolReceiptStore } from "../src/storage/tool-receipts";
import { DurableWorkflowService, type WorkflowStepSpec } from "../src/storage/workflow";

const open = async (file: string) => {
  const db = await SqliteConnection.open(file);
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.exec(`
    INSERT OR IGNORE INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'Workspace', 'file:///w1', 1, 1);
    INSERT OR IGNORE INTO tasks(id, workspace_id, title, status, created_by, created_at, updated_at) VALUES ('t1', 'w1', 'Task', 'todo', 'user', 1, 1);
  `);
  return db;
};

const file = () => join(mkdtempSync(join(tmpdir(), "ar-chaos-")), "agentroom.db");
const specs: WorkflowStepSpec[] = [
  { id: "s1", kind: "model", idempotencyKey: "model:0" },
  { id: "s2", kind: "tool", idempotencyKey: "tool:1" },
];

test("chaos: every partial initialization window converges without duplicate steps", async () => {
  for (const createdSteps of [0, 1, 2]) {
    const path = file();
    const first = await open(path);
    const runs = new SqliteRunRepository(first);
    const steps = new SqliteStepRepository(first);
    await runs.create("w1", "r1", { taskId: "t1", route: { workflow: { steps: specs, maxAttempts: 3 } } },
      { eventId: "run-created", occurredAt: 10 });
    for (let index = 0; index < createdSteps; index += 1) {
      await steps.create("w1", specs[index].id, { runId: "r1", ordinal: index, ...specs[index] },
        { eventId: `run:r1:step:${index}:created`, occurredAt: 10 });
    }
    await first.close();

    const reopened = await open(path);
    try {
      const service = new DurableWorkflowService(reopened, { now: () => 20 });
      await service.recover("w1");
      assert.equal((await new SqliteRunRepository(reopened).get("w1", "r1"))?.status, "running");
      assert.deepEqual((await new SqliteStepRepository(reopened).listForRun("w1", "r1")).map((step) => step.id), ["s1", "s2"]);
      assert.equal((await reopened.get<{ count: number }>("SELECT count(*) AS count FROM steps WHERE run_id = 'r1'"))?.count, 2);
    } finally {
      await reopened.close();
    }
  }
});

test("chaos: restart preserves a live lease, then reclaims it only after expiry", async () => {
  const path = file();
  let now = 100;
  const first = await open(path);
  const service = new DurableWorkflowService(first, { now: () => now, leaseMs: 50 });
  await service.start({ workspaceId: "w1", runId: "r1", taskId: "t1", steps: [specs[0]] });
  const leased = (await service.claimNext("w1", "worker"))!;
  await first.close();

  const reopened = await open(path);
  try {
    const recovered = new DurableWorkflowService(reopened, { now: () => now, leaseMs: 50 });
    assert.equal((await recovered.recover("w1")).expiredLeases, 0);
    assert.equal((await new SqliteStepRepository(reopened).get("w1", leased.id))?.status, "leased");
    now = 151;
    assert.equal((await recovered.recover("w1")).expiredLeases, 1);
    assert.equal((await new SqliteStepRepository(reopened).get("w1", leased.id))?.status, "pending");
  } finally {
    await reopened.close();
  }
});

test("chaos: unresolved tool intent survives restart as reconcile-only", async () => {
  const path = file();
  const first = await open(path);
  await first.exec(`
    INSERT INTO runs(id, workspace_id, task_id, status, attempt, created_at, updated_at) VALUES ('r1', 'w1', 't1', 'running', 1, 1, 1);
    INSERT INTO steps(id, workspace_id, run_id, ordinal, kind, status, idempotency_key, version, created_at, updated_at)
      VALUES ('s1', 'w1', 'r1', 0, 'tool', 'running', 'tool:0', 1, 1, 1);
  `);
  const intent = { id: "receipt", workspaceId: "w1", stepId: "s1", semanticKey: "deploy:prod", toolId: "deploy", args: { ref: "abc" }, risk: "network", at: 10 };
  assert.equal((await new SqliteToolReceiptStore(first).begin(intent)).execute, true);
  await first.close();

  const reopened = await open(path);
  try {
    const retry = await new SqliteToolReceiptStore(reopened).begin({ ...intent, id: "new-id", at: 20 });
    assert.equal(retry.execute, false);
    assert.equal(retry.receipt.status, "intent");
  } finally {
    await reopened.close();
  }
});

test("chaos: checkpoint checksum rejects storage corruption", async () => {
  const path = file();
  const db = await open(path);
  try {
    const service = new DurableWorkflowService(db, { now: () => 10, leaseMs: 1000 });
    await service.start({ workspaceId: "w1", runId: "r1", taskId: "t1", steps: [specs[0]] });
    const running = await service.startClaimed((await service.claimNext("w1", "worker"))!);
    const steps = new SqliteStepRepository(db);
    await steps.checkpoint("w1", "s1", "cp1", running.leaseToken!, { safe: true }, 1,
      { eventId: "checkpoint", occurredAt: 10, expectedVersion: running.version });
    // Simulate disk/extension corruption beneath the repository's immutable API.
    await db.exec("DROP TRIGGER checkpoints_no_update; UPDATE checkpoints SET state_json = '{\"safe\":false}' WHERE id = 'cp1'");
    await assert.rejects(steps.latestCheckpoint("w1", "s1"), /checksum mismatch/);
  } finally {
    await db.close();
  }
});
