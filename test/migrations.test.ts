import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMigrationRunner, type SqliteMigration } from "../src/storage/migrations";
import { SqliteConnection } from "../src/storage/sqlite";

const openDatabase = () => SqliteConnection.open(join(mkdtempSync(join(tmpdir(), "ar-migrations-")), "agentroom.db"));

const v1: SqliteMigration = {
  version: 1,
  name: "create_widget",
  sql: "CREATE TABLE widget(id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT",
};

const v2: SqliteMigration = {
  version: 2,
  name: "index_widget_name",
  sql: "CREATE INDEX widget_name_idx ON widget(name)",
};

test("migrations: applies pending history and reruns without changing it", async () => {
  const db = await openDatabase();
  try {
    const runner = new SqliteMigrationRunner(db, [v2, v1]);
    const initial = await runner.status();
    assert.deepEqual(initial.applied, []);
    assert.deepEqual(initial.pending.map((migration) => migration.version), [1, 2]);
    assert.equal(initial.currentVersion, 0);
    assert.equal(initial.targetVersion, 2);
    const first = await runner.apply();
    assert.equal(first.currentVersion, 2);
    assert.equal(first.pending.length, 0);
    assert.equal(first.applied.length, 2);
    assert.match(first.applied[0].checksum, /^[a-f0-9]{64}$/);

    const appliedAt = first.applied.map((migration) => migration.appliedAt);
    const second = await runner.apply();
    assert.deepEqual(second.applied.map((migration) => migration.appliedAt), appliedAt);
    assert.deepEqual(await db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'widget_name_idx'"), { name: "widget_name_idx" });
  } finally {
    await db.close();
  }
});

test("migrations: rejects edited history and a database newer than the build", async () => {
  const db = await openDatabase();
  try {
    await new SqliteMigrationRunner(db, [v1]).apply();
    await assert.rejects(new SqliteMigrationRunner(db, [{ ...v1, sql: `${v1.sql}; -- edited` }]).status(), /diverged/);
    await assert.rejects(new SqliteMigrationRunner(db, []).status(), /newer/);
  } finally {
    await db.close();
  }
});

test("migrations: a failed migration rolls back schema and ledger together", async () => {
  const db = await openDatabase();
  try {
    const broken: SqliteMigration = {
      version: 2,
      name: "broken",
      sql: "CREATE TABLE should_rollback(id INTEGER); INSERT INTO missing_table VALUES (1)",
    };
    await assert.rejects(new SqliteMigrationRunner(db, [v1, broken]).apply(), /missing_table/);
    const state = await new SqliteMigrationRunner(db, [v1, broken]).status();
    assert.equal(state.currentVersion, 1);
    assert.equal(state.pending.length, 1);
    assert.equal(await db.get("SELECT name FROM sqlite_master WHERE name = 'should_rollback'"), undefined);
  } finally {
    await db.close();
  }
});

test("migrations: validates versions, names and SQL before touching the database", async () => {
  const db = await openDatabase();
  try {
    assert.throws(() => new SqliteMigrationRunner(db, [{ ...v1, version: 2 }]), /contiguous/);
    assert.throws(() => new SqliteMigrationRunner(db, [{ ...v1, name: " " }]), /empty name/);
    assert.throws(() => new SqliteMigrationRunner(db, [{ ...v1, sql: " " }]), /empty SQL/);
  } finally {
    await db.close();
  }
});
