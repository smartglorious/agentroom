import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "../src/storage/events";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { schemaMigrations } from "../src/storage/schema-v1";
import { SqliteConnection } from "../src/storage/sqlite";
import { SqliteStepRepository } from "../src/storage/step-events";

const setup = async () => {
  const db = await SqliteConnection.open(join(mkdtempSync(join(tmpdir(), "ar-step-events-")), "agentroom.db"));
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.exec(`
    INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'Workspace', 'file:///w1', 1, 1);
    INSERT INTO tasks(id, workspace_id, title, status, created_by, created_at, updated_at) VALUES ('t1', 'w1', 'Task', 'todo', 'user', 1, 1);
    INSERT INTO runs(id, workspace_id, task_id, status, attempt, created_at, updated_at) VALUES ('r1', 'w1', 't1', 'running', 1, 1, 1);
  `);
  return { db, steps: new SqliteStepRepository(db), events: new SqliteEventStore(db) };
};

test("step events: lease, heartbeat, run and checkpoint are fenced and durable", async () => {
  const { db, steps, events } = await setup();
  try {
    await steps.create("w1", "s1", { runId: "r1", ordinal: 0, kind: "model", idempotencyKey: "model:0" }, { eventId: "s-e1", occurredAt: 100 });
    await steps.lease("w1", "s1", "worker-1", "lease-1", 200, { eventId: "s-e2", occurredAt: 110, expectedVersion: 1 });
    await steps.heartbeat("w1", "s1", "lease-1", 250, { eventId: "s-e3", occurredAt: 120, expectedVersion: 2 });
    await steps.start("w1", "s1", "lease-1", { eventId: "s-e4", occurredAt: 130, expectedVersion: 3 });
    const checkpoint = await steps.checkpoint("w1", "s1", "cp1", "lease-1", { cursor: 7 }, 1,
      { eventId: "s-e5", occurredAt: 140, expectedVersion: 4 }, "provider:7");
    assert.deepEqual(checkpoint?.state, { cursor: 7 });
    assert.match(checkpoint?.stateHash ?? "", /^[a-f0-9]{64}$/);
    const done = await steps.succeed("w1", "s1", "lease-1", { eventId: "s-e6", occurredAt: 150, expectedVersion: 5 });
    assert.equal(done.status, "succeeded");
    assert.equal(done.attempt, 1);
    assert.equal(done.leaseToken, undefined);
    assert.equal((await events.readAggregate("step", "s1")).length, 6);
    await assert.rejects(db.run("UPDATE checkpoints SET state_json = '{}' WHERE id = 'cp1'"), /immutable/);
  } finally {
    await db.close();
  }
});

test("step events: stale tokens roll back events and expired leases can be reclaimed", async () => {
  const { db, steps, events } = await setup();
  try {
    await steps.create("w1", "s1", { runId: "r1", ordinal: 0, kind: "tool", idempotencyKey: "tool:0" }, { eventId: "s-e1", occurredAt: 100 });
    await steps.lease("w1", "s1", "worker-1", "old", 120, { eventId: "s-e2", occurredAt: 110, expectedVersion: 1 });
    await assert.rejects(
      steps.start("w1", "s1", "wrong", { eventId: "bad-token", occurredAt: 115, expectedVersion: 2 }),
      /stale lease/,
    );
    assert.equal((await events.readAggregate("step", "s1")).length, 2);
    await assert.rejects(
      steps.expireLease("w1", "s1", "old", { eventId: "too-early", occurredAt: 119, expectedVersion: 2 }),
      /has not expired/,
    );
    await steps.expireLease("w1", "s1", "old", { eventId: "expired", occurredAt: 121, expectedVersion: 2 });
    const reclaimed = await steps.lease("w1", "s1", "worker-2", "new", 250, { eventId: "reclaimed", occurredAt: 130, expectedVersion: 3 });
    assert.equal(reclaimed.leaseOwner, "worker-2");
    assert.equal(reclaimed.attempt, 2);
  } finally {
    await db.close();
  }
});

test("step events: approval pause releases the lease and resumes through pending", async () => {
  const { db, steps } = await setup();
  try {
    await steps.create("w1", "s1", { runId: "r1", ordinal: 0, kind: "approval", idempotencyKey: "approval:0" }, { eventId: "s-e1", occurredAt: 100 });
    await steps.lease("w1", "s1", "worker", "lease", 200, { eventId: "s-e2", occurredAt: 110, expectedVersion: 1 });
    await steps.start("w1", "s1", "lease", { eventId: "s-e3", occurredAt: 120, expectedVersion: 2 });
    const waiting = await steps.waitForApproval("w1", "s1", "lease", { eventId: "s-e4", occurredAt: 130, expectedVersion: 3 });
    assert.equal(waiting.status, "waiting_approval");
    assert.equal(waiting.leaseToken, undefined);
    const resumed = await steps.resume("w1", "s1", { eventId: "s-e5", occurredAt: 140, expectedVersion: 4 });
    assert.equal(resumed.status, "pending");
  } finally {
    await db.close();
  }
});
