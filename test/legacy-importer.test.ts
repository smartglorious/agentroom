import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importLegacyState, scanLegacyState, verifyLegacyImport } from "../src/storage/legacy-importer";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { schemaV1Migrations } from "../src/storage/schema-v1";
import { SqliteConnection } from "../src/storage/sqlite";
import { SqliteTaskRepository } from "../src/storage/task-events";

const legacy = () => {
  const root = mkdtempSync(join(tmpdir(), "ar-import-"));
  const state = join(root, "state");
  mkdirSync(state);
  const tasks = [
    { id: "next", title: "Next", description: "", status: "blocked", dependsOn: ["base"], createdBy: "user", updatedAt: 102 },
    { id: "base", title: "Base", description: "work", assignee: "be", status: "in_progress", dependsOn: [], createdBy: "user", updatedAt: 101 },
  ];
  writeFileSync(join(state, "tasks.json"), JSON.stringify(tasks, null, 2));
  writeFileSync(join(state, "chat.jsonl"), '{"id":"m1","text":"hello"}\n{"id":"m2","text":"world"}\n');
  writeFileSync(join(state, "sessions.json"), '{"be:main":"session-1"}');
  writeFileSync(join(state, "usage.jsonl"), '{"turnId":"turn-1","input":10}\n');
  return { state, tasks };
};

const database = async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ar-import-db-")), "agentroom.db");
  const db = await SqliteConnection.open(file);
  await new SqliteMigrationRunner(db, schemaV1Migrations).apply();
  await db.run("INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'Workspace', 'file:///w1', 100, 100)");
  return db;
};

test("legacy importer: imports lossless records and task projections idempotently", async () => {
  const fixture = legacy();
  const scan = scanLegacyState(fixture.state);
  assert.deepEqual(scan.errors, []);
  assert.equal(scan.records.length, 6);
  const db = await database();
  try {
    assert.deepEqual(await importLegacyState(db, "w1", scan, 200), { imported: 6, skipped: 0, total: 6 });
    assert.deepEqual(await importLegacyState(db, "w1", scan, 300), { imported: 0, skipped: 6, total: 6 });
    const verification = await verifyLegacyImport(db, "w1", scan);
    assert.deepEqual(verification, {
      ok: true, sourceRecords: 6, ledgerRecords: 6, tasks: 2, foreignKeyErrors: 0, mismatches: [],
    });
    const tasks = new SqliteTaskRepository(db);
    assert.equal((await tasks.get("w1", "base"))?.assignee, "be");
    assert.deepEqual((await tasks.get("w1", "next"))?.dependsOn, ["base"]);
    assert.equal((await db.get<{ count: number }>("SELECT count(*) AS count FROM events"))?.count, 2);
  } finally {
    await db.close();
  }
});

test("legacy importer: changed source conflicts without partially updating the import", async () => {
  const fixture = legacy();
  const db = await database();
  try {
    await importLegacyState(db, "w1", scanLegacyState(fixture.state), 200);
    fixture.tasks[1].title = "Changed";
    writeFileSync(join(fixture.state, "tasks.json"), JSON.stringify(fixture.tasks));
    await assert.rejects(importLegacyState(db, "w1", scanLegacyState(fixture.state), 300), /Legacy source changed/);
    assert.equal((await new SqliteTaskRepository(db).get("w1", "base"))?.title, "Base");
    assert.equal((await db.get<{ count: number }>("SELECT count(*) AS count FROM legacy_imports"))?.count, 6);
  } finally {
    await db.close();
  }
});

test("legacy importer: corrupt input and invalid dependency graphs fail before writes", async () => {
  const fixture = legacy();
  writeFileSync(join(fixture.state, "chat.jsonl"), '{"id":"ok"}\nnot-json\n');
  const corrupt = scanLegacyState(fixture.state);
  assert.equal(corrupt.errors.length, 1);
  const db = await database();
  try {
    await assert.rejects(importLegacyState(db, "w1", corrupt), /parse error/);
    assert.equal((await db.get<{ count: number }>("SELECT count(*) AS count FROM legacy_imports"))?.count, 0);

    writeFileSync(join(fixture.state, "chat.jsonl"), "");
    fixture.tasks[0].dependsOn = ["missing"];
    writeFileSync(join(fixture.state, "tasks.json"), JSON.stringify(fixture.tasks));
    await assert.rejects(importLegacyState(db, "w1", scanLegacyState(fixture.state)), /missing dependency/);
    assert.equal((await db.get<{ count: number }>("SELECT count(*) AS count FROM events"))?.count, 0);
  } finally {
    await db.close();
  }
});
