import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OptimisticConcurrencyError, SqliteEventStore } from "../src/storage/events";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { schemaMigrations } from "../src/storage/schema-v1";
import { SqliteConnection } from "../src/storage/sqlite";
import { SqliteTaskRepository } from "../src/storage/task-events";

const setup = async () => {
  const db = await SqliteConnection.open(join(mkdtempSync(join(tmpdir(), "ar-task-events-")), "agentroom.db"));
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.run("INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'Workspace', 'file:///w1', 100, 100)");
  await db.run("INSERT INTO agents(id, workspace_id, name, created_at, updated_at) VALUES ('be', 'w1', 'Backend', 100, 100)");
  return { db, tasks: new SqliteTaskRepository(db), events: new SqliteEventStore(db) };
};

test("task events: commands append events and update the projection atomically", async () => {
  const { db, tasks, events } = await setup();
  try {
    assert.deepEqual(await tasks.create("w1", "t1", { title: "Build", createdBy: "user" }, { eventId: "e1", occurredAt: 101 }), {
      id: "t1", title: "Build", description: "", status: "todo", dependsOn: [], createdBy: "user", updatedAt: 101,
    });
    const claimed = await tasks.claim("w1", "t1", "be", { eventId: "e2", occurredAt: 102, expectedVersion: 1 });
    assert.equal(claimed.status, "in_progress");
    assert.equal(claimed.assignee, "be");
    const completed = await tasks.complete("w1", "t1", "be", "done", { eventId: "e3", occurredAt: 103, expectedVersion: 2 });
    assert.equal(completed.status, "done");
    assert.equal(completed.result, "done");

    const history = await events.readAggregate("task", "t1");
    assert.deepEqual(history.map((event) => [event.seq, event.aggregateVersion, event.type]), [
      [1, 1, "TaskCreated"], [2, 2, "TaskClaimed"], [3, 3, "TaskCompleted"],
    ]);
  } finally {
    await db.close();
  }
});

test("task events: retries are idempotent and stale writers are rejected", async () => {
  const { db, tasks, events } = await setup();
  try {
    const input = { title: "Build", createdBy: "user" };
    const meta = { eventId: "same", occurredAt: 101 };
    await tasks.create("w1", "t1", input, meta);
    await tasks.create("w1", "t1", input, meta);
    assert.equal((await events.readAggregate("task", "t1")).length, 1);

    await assert.rejects(
      tasks.claim("w1", "t1", "be", { eventId: "stale", occurredAt: 102, expectedVersion: 0 }),
      OptimisticConcurrencyError,
    );
    await assert.rejects(
      tasks.create("w1", "t1", { title: "Changed", createdBy: "user" }, meta),
      /different content/,
    );
    assert.equal((await tasks.get("w1", "t1"))?.status, "todo");
  } finally {
    await db.close();
  }
});

test("task events: a failed projection rolls its event back", async () => {
  const { db, tasks, events } = await setup();
  try {
    await tasks.create("w1", "t1", { title: "Build", createdBy: "user" }, { eventId: "e1", occurredAt: 101 });
    await assert.rejects(
      tasks.claim("w1", "t1", "missing-agent", { eventId: "e2", occurredAt: 102, expectedVersion: 1 }),
      /FOREIGN KEY/i,
    );
    assert.equal((await events.readAggregate("task", "t1")).length, 1);
    assert.equal((await tasks.get("w1", "t1"))?.status, "todo");
  } finally {
    await db.close();
  }
});

test("task events: projection rebuild restores task state from the event log", async () => {
  const { db, tasks, events } = await setup();
  try {
    await tasks.create("w1", "t1", { title: "Build", createdBy: "user" }, { eventId: "e1", occurredAt: 101 });
    await tasks.claim("w1", "t1", "be", { eventId: "e2", occurredAt: 102, expectedVersion: 1 });
    await tasks.complete("w1", "t1", "be", "done", { eventId: "e3", occurredAt: 103, expectedVersion: 2 });
    await db.run("DELETE FROM tasks WHERE id = 't1'");
    assert.equal(await tasks.get("w1", "t1"), undefined);

    await tasks.rebuild("w1");
    assert.equal((await tasks.get("w1", "t1"))?.status, "done");
    assert.equal((await tasks.get("w1", "t1"))?.result, "done");
    assert.deepEqual((await events.readWorkspace("w1", 1, 2)).map((event) => event.eventId), ["e2", "e3"]);
  } finally {
    await db.close();
  }
});

test("task events: completing dependencies deterministically unblocks their projection", async () => {
  const { db, tasks } = await setup();
  try {
    await tasks.create("w1", "base", { title: "Base", createdBy: "user" }, { eventId: "e1", occurredAt: 101 });
    await tasks.create("w1", "next", { title: "Next", createdBy: "user", dependsOn: ["base"] }, { eventId: "e2", occurredAt: 102 });
    assert.equal((await tasks.get("w1", "next"))?.status, "blocked");

    await tasks.complete("w1", "base", "be", "done", { eventId: "e3", occurredAt: 103, expectedVersion: 1 });
    assert.equal((await tasks.get("w1", "next"))?.status, "todo");
    await db.run("DELETE FROM task_dependencies WHERE task_id = 'next'");
    await db.run("DELETE FROM tasks WHERE id IN ('next', 'base')");
    await tasks.rebuild("w1");
    assert.equal((await tasks.get("w1", "next"))?.status, "todo");
  } finally {
    await db.close();
  }
});
