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
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
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

test("legacy importer: every field of a task survives the import, so verification passes (a task with `level` used to fail it)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ar-import-level-"));
  const state = join(root, "state");
  mkdirSync(state);
  // Required<Task>: when Task gains a field this stops compiling until the field is added here, and so to the projection.
  const full: Required<import("../src/core/types").Task> = {
    id: "full", title: "Full", description: "d", assignee: "be", status: "done", dependsOn: ["base"], createdBy: "lead", level: "high", result: "ok", updatedAt: 500,
  };
  const base = { id: "base", title: "Base", description: "", status: "done", dependsOn: [], createdBy: "user", updatedAt: 400 };
  writeFileSync(join(state, "tasks.json"), JSON.stringify([full, base]));
  const scan = scanLegacyState(state);
  assert.deepEqual(scan.errors, []);
  const db = await database();
  try {
    await importLegacyState(db, "w1", scan, 600);
    const verification = await verifyLegacyImport(db, "w1", scan);
    assert.deepEqual(verification.mismatches, []);
    assert.equal(verification.ok, true);
    assert.deepEqual(await new SqliteTaskRepository(db).get("w1", "full"), full, "the task comes back exactly as it was written");
  } finally {
    await db.close();
  }
});

test("legacy importer: a changed source is an error by default, and with `refresh` the snapshot follows the file", async () => {
  const fixture = legacy();
  const db = await database();
  try {
    await importLegacyState(db, "w1", scanLegacyState(fixture.state), 200);
    const changed = fixture.tasks.map((t) => (t.id === "base" ? { ...t, status: "done", result: "ok", level: "mid", updatedAt: 150 } : t));
    writeFileSync(join(fixture.state, "tasks.json"), JSON.stringify(changed));
    writeFileSync(join(fixture.state, "sessions.json"), '{"be:main":"session-2"}');
    const scan = scanLegacyState(fixture.state);
    await assert.rejects(importLegacyState(db, "w1", scan, 300), /Legacy source changed/);
    assert.deepEqual(await importLegacyState(db, "w1", scan, 300, { refresh: true }), { imported: 0, skipped: 4, total: 6, refreshed: 2 });
    const verification = await verifyLegacyImport(db, "w1", scan);
    assert.deepEqual(verification.mismatches, []);
    assert.equal(verification.ok, true);
    const base = await new SqliteTaskRepository(db).get("w1", "base");
    assert.equal(base?.status, "done");
    assert.equal(base?.level, "mid");
    assert.equal(base?.result, "ok");
    assert.deepEqual((await new SqliteTaskRepository(db).get("w1", "next"))?.dependsOn, ["base"]);
    // refreshing again with nothing changed does nothing, and going back and forth between two states keeps working
    assert.deepEqual(await importLegacyState(db, "w1", scan, 400, { refresh: true }), { imported: 0, skipped: 6, total: 6 });
    writeFileSync(join(fixture.state, "tasks.json"), JSON.stringify(fixture.tasks));
    const back = scanLegacyState(fixture.state);
    await importLegacyState(db, "w1", back, 500, { refresh: true });
    writeFileSync(join(fixture.state, "tasks.json"), JSON.stringify(changed));
    const again = scanLegacyState(fixture.state);
    await importLegacyState(db, "w1", again, 600, { refresh: true });
    assert.equal((await verifyLegacyImport(db, "w1", again)).ok, true);
    // the projection can be rebuilt from the event log and still matches
    await new SqliteTaskRepository(db).rebuild("w1");
    assert.equal((await verifyLegacyImport(db, "w1", again)).ok, true);
  } finally {
    await db.close();
  }
});

test("migration v9: a database made before tasks kept their level takes it back from the import ledger", async () => {
  const fixture = legacy();
  writeFileSync(join(fixture.state, "tasks.json"), JSON.stringify([{ id: "lv", title: "Lv", description: "", status: "todo", dependsOn: [], createdBy: "lead", level: "high", updatedAt: 1 }]));
  const scan = scanLegacyState(fixture.state);
  const file = join(mkdtempSync(join(tmpdir(), "ar-import-v8-")), "agentroom.db");
  const db = await SqliteConnection.open(file);
  try {
    await new SqliteMigrationRunner(db, schemaMigrations.slice(0, 8)).apply();     // what 0.15.15–0.15.19 created
    await db.run("INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'Workspace', 'file:///w1', 100, 100)");
    // an old projection: the task without its level, and the ledger row that kept the task as read
    await db.run("INSERT INTO tasks(id, workspace_id, title, description, status, created_by, version, created_at, updated_at) VALUES ('lv', 'w1', 'Lv', '', 'todo', 'lead', 1, 1, 1)");
    const record = scan.records.find((r) => r.key === "lv")!;
    await db.run("INSERT INTO legacy_imports(workspace_id, source_kind, source_key, source_hash, payload_json, target_id, importer_version, imported_at) VALUES ('w1', 'tasks.json', 'lv', ?, ?, 'lv', 1, 1)", [record.hash, JSON.stringify(record.payload)]);
    await new SqliteMigrationRunner(db, schemaMigrations).apply();
    assert.equal((await new SqliteTaskRepository(db).get("w1", "lv"))?.level, "high");
  } finally {
    await db.close();
  }
});

test("legacy importer: dependsOn order, duplicates and unknown keys in the file do not fail verification; a real difference names its field", async () => {
  const root = mkdtempSync(join(tmpdir(), "ar-import-deps-"));
  const state = join(root, "state");
  mkdirSync(state);
  const mk = (id: string, extra: object = {}) => ({ id, title: id, description: "", status: "todo", dependsOn: [], createdBy: "user", updatedAt: 1, ...extra });
  writeFileSync(join(state, "tasks.json"), JSON.stringify([
    mk("a"), mk("b"), mk("c"),
    mk("z", { dependsOn: ["c", "a", "b", "a"], legacyField: "from an older version" }),
  ]));
  const scan = scanLegacyState(state);
  const db = await database();
  try {
    await importLegacyState(db, "w1", scan, 10);
    assert.deepEqual((await verifyLegacyImport(db, "w1", scan)).mismatches, []);
    await db.run("UPDATE tasks SET title = 'changed' WHERE id = 'a'");
    assert.deepEqual((await verifyLegacyImport(db, "w1", scan)).mismatches, ["task-projection:a(title)"]);
  } finally {
    await db.close();
  }
});
