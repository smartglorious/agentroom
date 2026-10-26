import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { SqliteDeadLetterStore } from "../src/storage/dead-letters";
import { classifyExecutionFailure } from "../src/storage/execution-errors";
import { SqliteRunRepository } from "../src/storage/run-events";
import { schemaMigrations } from "../src/storage/schema-v1";
import { SqliteConnection } from "../src/storage/sqlite";
import { SqliteStepRepository } from "../src/storage/step-events";
import { DurableWorkflowService } from "../src/storage/workflow";

const database = async (file?: string) => {
  const path = file ?? join(mkdtempSync(join(tmpdir(), "ar-workflow-")), "agentroom.db");
  const db = await SqliteConnection.open(path);
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.run("INSERT OR IGNORE INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'Workspace', 'file:///w1', 1, 1)");
  await db.run("INSERT OR IGNORE INTO tasks(id, workspace_id, title, status, created_by, created_at, updated_at) VALUES ('t1', 'w1', 'Task', 'todo', 'user', 1, 1)");
  return { db, path };
};

const ids = () => {
  let sequence = 0;
  return (kind: string) => `${kind}-${++sequence}`;
};

test("workflow: checkpointed running work recovers after restart and lease expiry", async () => {
  const first = await database();
  let now = 100;
  const nextId = ids();
  const service = new DurableWorkflowService(first.db, { now: () => now, id: nextId, leaseMs: 50 });
  await service.start({ workspaceId: "w1", runId: "r1", taskId: "t1", steps: [{ id: "s1", kind: "model", idempotencyKey: "model:0" }] });
  const leased = (await service.claimNext("w1", "worker"))!;
  const running = await service.startClaimed(leased);
  const steps = new SqliteStepRepository(first.db);
  await steps.checkpoint("w1", "s1", "cp1", running.leaseToken!, { providerCursor: "c1" }, 1,
    { eventId: "checkpoint", occurredAt: now, expectedVersion: running.version }, "c1");
  await first.db.close();

  now = 200;
  const reopened = await database(first.path);
  try {
    const resumedService = new DurableWorkflowService(reopened.db, { now: () => now, id: nextId, leaseMs: 50 });
    assert.deepEqual(await resumedService.recover("w1"), { repairedRuns: 0, expiredLeases: 1 });
    assert.deepEqual((await new SqliteStepRepository(reopened.db).latestCheckpoint("w1", "s1"))?.state, { providerCursor: "c1" });
    const reclaimed = (await resumedService.claimNext("w1", "worker-2"))!;
    assert.equal(reclaimed.attempt, 2);
    const restarted = await resumedService.startClaimed(reclaimed);
    const run = await resumedService.succeed(restarted);
    assert.equal(run.status, "succeeded");
  } finally {
    await reopened.db.close();
  }
});

test("workflow: recovery repairs a crash between run creation and step creation", async () => {
  const { db } = await database();
  try {
    const runs = new SqliteRunRepository(db);
    await runs.create("w1", "r1", { taskId: "t1", route: { workflow: {
      maxAttempts: 3, steps: [{ id: "s1", kind: "tool", idempotencyKey: "tool:0" }],
    } } }, { eventId: "run-created", occurredAt: 100 });
    const service = new DurableWorkflowService(db, { now: () => 200, id: ids() });
    assert.deepEqual(await service.recover("w1"), { repairedRuns: 1, expiredLeases: 0 });
    assert.equal((await runs.get("w1", "r1"))?.status, "running");
    assert.equal((await new SqliteStepRepository(db).get("w1", "s1"))?.status, "pending");
    assert.deepEqual(await service.recover("w1"), { repairedRuns: 0, expiredLeases: 0 });
  } finally {
    await db.close();
  }
});

test("workflow: retries use bounded exponential backoff then fail the run", async () => {
  const { db } = await database();
  let now = 100;
  try {
    const service = new DurableWorkflowService(db, { now: () => now, id: ids(), retryBaseMs: 10, leaseMs: 100 });
    await service.start({ workspaceId: "w1", runId: "r1", taskId: "t1", maxAttempts: 2,
      steps: [{ id: "s1", kind: "tool", idempotencyKey: "tool:0" }] });
    const first = await service.startClaimed((await service.claimNext("w1", "worker"))!);
    await service.fail(first, { code: "TEMP" }, true);
    now = 109;
    assert.equal(await service.claimNext("w1", "worker"), undefined);
    now = 110;
    const second = await service.startClaimed((await service.claimNext("w1", "worker"))!);
    assert.equal(second.attempt, 2);
    const run = await service.fail(second, { code: "TEMP" }, true);
    assert.equal(run.status, "failed");
    assert.equal(await service.claimNext("w1", "worker"), undefined);
    assert.deepEqual((await new SqliteDeadLetterStore(db).pending("w1")).map((item) => [item.classification, item.action]), [
      ["transient", "retry_exhausted"],
    ]);
  } finally {
    await db.close();
  }
});

test("workflow: deterministic and ambiguous failures dead-letter without blind retry", async () => {
  assert.deepEqual(classifyExecutionFailure({ status: 401, message: "invalid API key" }),
    { classification: "auth", action: "fix_credentials" });
  assert.deepEqual(classifyExecutionFailure(new Error("tool outcome unknown after connection reset")),
    { classification: "unknown_effect", action: "reconcile_effect" });

  const { db } = await database();
  try {
    const service = new DurableWorkflowService(db, { now: () => 100, id: ids() });
    await service.start({ workspaceId: "w1", runId: "r1", taskId: "t1", maxAttempts: 5,
      steps: [{ id: "s1", kind: "tool", idempotencyKey: "publish:release" }] });
    const running = await service.startClaimed((await service.claimNext("w1", "worker"))!);
    const run = await service.fail(running, new Error("tool outcome unknown after connection reset"));
    assert.equal(run.status, "failed");
    const pending = await new SqliteDeadLetterStore(db).pending("w1");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].classification, "unknown_effect");
    assert.equal(pending[0].action, "reconcile_effect");
    assert.equal((await new SqliteStepRepository(db).get("w1", "s1"))?.attempt, 1);
    const resolved = await new SqliteDeadLetterStore(db).resolve(pending[0].id, "resolved", { receipt: "external-1" }, 200);
    assert.equal(resolved.status, "resolved");
    await assert.rejects(new SqliteDeadLetterStore(db).resolve(pending[0].id, "discarded", {}, 201), /already resolved/);
  } finally {
    await db.close();
  }
});

test("workflow: pause requires a safe point; resume and cancel are durable", async () => {
  const { db } = await database();
  try {
    const service = new DurableWorkflowService(db, { now: () => 100, id: ids() });
    await service.start({ workspaceId: "w1", runId: "r1", taskId: "t1", steps: [{ id: "s1", kind: "model", idempotencyKey: "model:0" }] });
    assert.equal((await service.pause("w1", "r1")).status, "paused");
    assert.equal(await service.claimNext("w1", "worker"), undefined);
    await service.resume("w1", "r1");
    await service.claimNext("w1", "worker");
    await assert.rejects(service.pause("w1", "r1"), /safe point/);
    const cancelled = await service.cancel("w1", "r1");
    assert.equal(cancelled.status, "cancelled");
    assert.equal((await new SqliteStepRepository(db).get("w1", "s1"))?.status, "cancelled");
  } finally {
    await db.close();
  }
});
