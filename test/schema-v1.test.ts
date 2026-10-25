import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { schemaV1Migrations } from "../src/storage/schema-v1";
import { SqliteConnection } from "../src/storage/sqlite";

const database = () => join(mkdtempSync(join(tmpdir(), "ar-schema-v1-")), "agentroom.db");

const seedWorkspace = async (db: SqliteConnection, id = "w1", root = "file:///workspace") => {
  await db.run(
    "INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [id, `Workspace ${id}`, root, 100, 100],
  );
};

const seedTask = async (db: SqliteConnection, id: string, workspaceId = "w1") => {
  await db.run(
    "INSERT INTO tasks(id, workspace_id, title, status, created_by, created_at, updated_at) VALUES (?, ?, ?, 'todo', 'user', ?, ?)",
    [id, workspaceId, `Task ${id}`, 100, 100],
  );
};

test("schema v1: creates the execution spine and survives reopen", async () => {
  const file = database();
  const first = await SqliteConnection.open(file);
  await new SqliteMigrationRunner(first, schemaV1Migrations).apply();
  const tables = await first.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  assert.deepEqual(tables.map((row) => row.name), [
    "_agentroom_migrations", "agents", "events", "legacy_imports", "runs", "steps", "task_dependencies", "tasks", "workspaces",
  ]);
  await seedWorkspace(first);
  await seedTask(first, "t1");
  await first.close();

  const reopened = await SqliteConnection.open(file);
  try {
    const state = await new SqliteMigrationRunner(reopened, schemaV1Migrations).status();
    assert.equal(state.currentVersion, 1);
    assert.deepEqual(await reopened.get("SELECT title, status, version FROM tasks WHERE id = 't1'"), {
      title: "Task t1", status: "todo", version: 1,
    });
    assert.deepEqual(await reopened.all("PRAGMA foreign_key_check"), []);
    assert.deepEqual(await reopened.get<{ integrity_check: string }>("PRAGMA integrity_check"), { integrity_check: "ok" });
  } finally {
    await reopened.close();
  }
});

test("schema v1: enforces workspace boundaries, state, JSON and idempotency", async () => {
  const db = await SqliteConnection.open(database());
  try {
    await new SqliteMigrationRunner(db, schemaV1Migrations).apply();
    await seedWorkspace(db);
    await seedWorkspace(db, "w2", "file:///other");
    await db.run("INSERT INTO agents(id, workspace_id, name, created_at, updated_at) VALUES ('a1', 'w1', 'Lead', 100, 100)");
    await seedTask(db, "t1");
    await seedTask(db, "t2");
    await seedTask(db, "other", "w2");

    await assert.rejects(db.run("UPDATE tasks SET status = 'unknown' WHERE id = 't1'"), /CHECK constraint/i);
    await assert.rejects(db.run("UPDATE agents SET profile_json = 'nope' WHERE id = 'a1'"), /CHECK constraint/i);
    await assert.rejects(db.run("UPDATE tasks SET assignee_agent_id = 'a1' WHERE id = 'other'"), /FOREIGN KEY/i);
    await assert.rejects(db.run("INSERT INTO task_dependencies VALUES ('w1', 't1', 't1', 100)"), /CHECK constraint/i);
    await assert.rejects(db.run("INSERT INTO task_dependencies VALUES ('w1', 't1', 'other', 100)"), /FOREIGN KEY/i);

    await db.run("INSERT INTO runs(id, workspace_id, task_id, status, attempt, created_at, updated_at) VALUES ('r1', 'w1', 't1', 'queued', 1, 100, 100)");
    await db.run("INSERT INTO steps(id, workspace_id, run_id, ordinal, kind, status, idempotency_key, created_at, updated_at) VALUES ('s1', 'w1', 'r1', 0, 'model', 'pending', 'model:0', 100, 100)");
    await assert.rejects(
      db.run("INSERT INTO steps(id, workspace_id, run_id, ordinal, kind, status, idempotency_key, created_at, updated_at) VALUES ('s2', 'w1', 'r1', 1, 'model', 'pending', 'model:0', 100, 100)"),
      /UNIQUE constraint/i,
    );
  } finally {
    await db.close();
  }
});

test("schema v1: event sequence is monotonic and the timeline is append-only", async () => {
  const db = await SqliteConnection.open(database());
  try {
    await new SqliteMigrationRunner(db, schemaV1Migrations).apply();
    await seedWorkspace(db);
    for (const [eventId, type] of [["e1", "TaskCreated"], ["e2", "TaskClaimed"]]) {
      await db.run(
        "INSERT INTO events(event_id, workspace_id, aggregate_type, aggregate_id, aggregate_version, type, schema_version, payload_json, occurred_at) VALUES (?, 'w1', 'task', 't1', ?, ?, 1, '{}', 100)",
        [eventId, eventId === "e1" ? 1 : 2, type],
      );
    }
    assert.deepEqual(await db.all("SELECT seq, event_id FROM events ORDER BY seq"), [
      { seq: 1, event_id: "e1" }, { seq: 2, event_id: "e2" },
    ]);
    await assert.rejects(db.run("UPDATE events SET type = 'Changed' WHERE event_id = 'e1'"), /append-only/);
    await assert.rejects(db.run("DELETE FROM events WHERE event_id = 'e1'"), /append-only/);
    await assert.rejects(
      db.run("INSERT INTO events(event_id, workspace_id, aggregate_type, aggregate_id, aggregate_version, type, schema_version, payload_json, occurred_at) VALUES ('e3', 'w1', 'task', 't1', 3, 'Bad', 1, 'not-json', 100)"),
      /CHECK constraint/i,
    );
  } finally {
    await db.close();
  }
});
