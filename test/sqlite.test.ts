import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteConnection } from "../src/storage/sqlite";

const database = () => join(mkdtempSync(join(tmpdir(), "ar-sqlite-")), "nested", "agentroom.db");

test("sqlite: bootstrap creates its folder and verifies WAL, foreign keys and FTS5", async () => {
  const file = database();
  const db = await SqliteConnection.open(file, { busyTimeoutMs: 1234 });
  try {
    assert.equal(existsSync(file), true);
    assert.match(db.health.sqliteVersion, /^3\./);
    assert.equal(db.health.journalMode.toLowerCase(), "wal");
    assert.equal(db.health.foreignKeys, true);
    assert.equal(db.health.fts5, true);
    assert.equal(db.health.busyTimeoutMs, 1234);
    await db.exec("CREATE VIRTUAL TABLE docs USING fts5(body)");
    await db.run("INSERT INTO docs(body) VALUES (?)", ["durable agent workflow"]);
    assert.equal((await db.all("SELECT rowid FROM docs WHERE docs MATCH ?", ["durable"])).length, 1);
  } finally {
    await db.close();
  }
});

test("sqlite: parameterized reads and writes survive reopen", async () => {
  const file = database();
  const first = await SqliteConnection.open(file);
  await first.exec("CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  const inserted = await first.run("INSERT INTO item(name) VALUES (?)", ["alpha"]);
  assert.equal(inserted.lastId, 1);
  assert.equal(inserted.changes, 1);
  assert.deepEqual(await first.get<{ id: number; name: string }>("SELECT id, name FROM item WHERE id = ?", [1]), { id: 1, name: "alpha" });
  await first.close();

  const reopened = await SqliteConnection.open(file);
  try {
    assert.deepEqual(await reopened.all<{ name: string }>("SELECT name FROM item ORDER BY id"), [{ name: "alpha" }]);
  } finally {
    await reopened.close();
  }
});

test("sqlite: transactions commit, roll back, serialize, and enforce foreign keys", async () => {
  const db = await SqliteConnection.open(database());
  try {
    await db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); CREATE TABLE log(value TEXT)");
    await assert.rejects(db.run("INSERT INTO child(parent_id) VALUES (?)", [99]), /FOREIGN KEY/i);
    await db.transaction(async (tx) => {
      await tx.run("INSERT INTO log(value) VALUES (?)", ["committed"]);
    });
    await assert.rejects(db.transaction(async (tx) => {
      await tx.run("INSERT INTO log(value) VALUES (?)", ["rolled back"]);
      throw new Error("stop");
    }), /stop/);
    await Promise.all(["one", "two"].map((value) => db.transaction(async (tx) => {
      await tx.run("INSERT INTO log(value) VALUES (?)", [value]);
    })));
    assert.deepEqual((await db.all<{ value: string }>("SELECT value FROM log ORDER BY rowid")).map((r) => r.value), ["committed", "one", "two"]);
  } finally {
    await db.close();
  }
  await assert.rejects(db.get("SELECT 1"), /closed/);
});

test("sqlite: invalid configuration fails before the connection can be used", async () => {
  await assert.rejects(SqliteConnection.open(database(), { busyTimeoutMs: -1 }), /Invalid SQLite busy timeout/);
  await assert.rejects(SqliteConnection.open("  "), /path is empty/);
});
