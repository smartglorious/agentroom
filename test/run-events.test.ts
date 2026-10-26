import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "../src/storage/events";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { SqliteRunRepository } from "../src/storage/run-events";
import { schemaV1Migrations } from "../src/storage/schema-v1";
import { SqliteConnection } from "../src/storage/sqlite";

const setup = async () => {
  const db = await SqliteConnection.open(join(mkdtempSync(join(tmpdir(), "ar-run-events-")), "agentroom.db"));
  await new SqliteMigrationRunner(db, schemaV1Migrations).apply();
  await db.run("INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'Workspace', 'file:///w1', 100, 100)");
  await db.run("INSERT INTO tasks(id, workspace_id, title, status, created_by, created_at, updated_at) VALUES ('t1', 'w1', 'Task', 'todo', 'user', 100, 100)");
  return { db, runs: new SqliteRunRepository(db), events: new SqliteEventStore(db) };
};

test("run events: lifecycle is event-backed and terminal states stay terminal", async () => {
  const { db, runs, events } = await setup();
  try {
    const created = await runs.create("w1", "r1", { taskId: "t1", budget: { tokens: 1000 }, route: { model: "m" } }, { eventId: "r-e1", occurredAt: 101 });
    assert.equal(created.status, "queued");
    assert.deepEqual(created.budget, { tokens: 1000 });
    await runs.transition("w1", "r1", "queued", "running", { eventId: "r-e2", occurredAt: 102, expectedVersion: 1 });
    const done = await runs.transition("w1", "r1", "running", "succeeded", { eventId: "r-e3", occurredAt: 103, expectedVersion: 2 });
    assert.equal(done.status, "succeeded");
    assert.equal(done.version, 3);
    await assert.rejects(
      runs.transition("w1", "r1", "succeeded", "running", { eventId: "r-e4", occurredAt: 104, expectedVersion: 3 }),
      /Invalid run transition/,
    );
    assert.equal((await events.readAggregate("run", "r1")).length, 3);
  } finally {
    await db.close();
  }
});

test("run events: invalid state and cross-workspace task fail atomically", async () => {
  const { db, runs, events } = await setup();
  try {
    await db.run("INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w2', 'Other', 'file:///w2', 100, 100)");
    await assert.rejects(runs.create("w2", "r1", { taskId: "t1" }, { eventId: "bad-create", occurredAt: 101 }), /FOREIGN KEY/i);
    assert.equal((await events.readAggregate("run", "r1")).length, 0);

    await runs.create("w1", "r1", { taskId: "t1" }, { eventId: "r-e1", occurredAt: 101 });
    await assert.rejects(
      runs.transition("w1", "r1", "running", "succeeded", { eventId: "bad-state", occurredAt: 102, expectedVersion: 1 }),
      /cannot transition/,
    );
    assert.equal((await events.readAggregate("run", "r1")).length, 1);
  } finally {
    await db.close();
  }
});

test("run events: projection rebuild reaches the same state", async () => {
  const { db, runs } = await setup();
  try {
    await runs.create("w1", "r1", { taskId: "t1", attempt: 2 }, { eventId: "r-e1", occurredAt: 101 });
    await runs.transition("w1", "r1", "queued", "running", { eventId: "r-e2", occurredAt: 102, expectedVersion: 1 });
    await runs.transition("w1", "r1", "running", "paused", { eventId: "r-e3", occurredAt: 103, expectedVersion: 2 });
    const before = await runs.get("w1", "r1");
    await db.run("DELETE FROM runs WHERE id = 'r1'");
    await runs.rebuild("w1");
    assert.deepEqual(await runs.get("w1", "r1"), before);
  } finally {
    await db.close();
  }
});
