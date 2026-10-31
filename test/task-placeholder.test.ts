import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importLegacyState, scanLegacyState, verifyLegacyImport } from "../src/storage/legacy-importer";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { schemaMigrations } from "../src/storage/schema-v1";
import { SqliteConnection } from "../src/storage/sqlite";
import { SqliteTaskRepository } from "../src/storage/task-events";

const database = async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ar-placeholder-")), "agentroom.db");
  const db = await SqliteConnection.open(file);
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.run("INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'Workspace', 'file:///w1', 100, 100)");
  return db;
};

// A durable turn that names a task creates a placeholder row first (turn-queue ensureTask: no event). The legacy file knows the task too.
// The next start must fill the placeholder in, not insert a second row (that was `UNIQUE constraint failed: tasks.workspace_id, tasks.id`).
test("legacy importer: a task whose placeholder row already exists is filled in, not inserted twice", async () => {
  const state = join(mkdtempSync(join(tmpdir(), "ar-placeholder-state-")), "state");
  mkdirSync(state, { recursive: true });
  const db = await database();
  try {
    await db.run("INSERT INTO tasks(id, workspace_id, title, status, created_by, created_at, updated_at) VALUES ('T-turn', 'w1', 'Room task T-turn', 'todo', 'system', 150, 150)");
    writeFileSync(join(state, "tasks.json"), JSON.stringify([
      { id: "T-turn", title: "made later", description: "the real text", status: "in_progress", assignee: "be", dependsOn: [], createdBy: "lead", level: "high", updatedAt: 200 },
    ]));
    const scan = scanLegacyState(state);
    await importLegacyState(db, "w1", scan, 300, { refresh: true });
    const row = await new SqliteTaskRepository(db).get("w1", "T-turn");
    assert.equal(row?.title, "made later");
    assert.equal(row?.assignee, "be");
    assert.equal(row?.level, "high");
    assert.equal((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE id = 'T-turn'"))?.n, 1, "one row, not two");
    assert.deepEqual((await verifyLegacyImport(db, "w1", scan)).mismatches, []);
  } finally {
    await db.close();
  }
});
