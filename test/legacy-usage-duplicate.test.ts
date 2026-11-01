import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importLegacyState, scanLegacyState, verifyLegacyImport } from "../src/storage/legacy-importer";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { schemaMigrations } from "../src/storage/schema-v1";
import { SqliteConnection } from "../src/storage/sqlite";

const database = async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ar-usage-dup-")), "agentroom.db");
  const db = await SqliteConnection.open(file);
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.run("INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'Workspace', 'file:///w1', 100, 100)");
  return db;
};

// The file the room wrote for a failed durable turn: the success row and the failure row share one turnId.
const state = () => {
  const dir = join(mkdtempSync(join(tmpdir(), "ar-usage-dup-state-")), "state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "usage.jsonl"), [
    JSON.stringify({ turnId: "T1", ts: 10, worker: "qa", costUsd: 1.07, tokenProvenance: "provider" }),
    JSON.stringify({ turnId: "T1", ts: 11, worker: "qa", costUsd: null, error: "Event version conflict: expected 3, actual 4" }),
    JSON.stringify({ turnId: "T2", ts: 12, worker: "be", costUsd: 0.5 }),
  ].join("\n") + "\n");
  return dir;
};

test("legacy usage: a turn with a success row and a failure row imports, and a second import changes nothing", async () => {
  const dir = state();
  const scan = scanLegacyState(dir);
  assert.deepEqual(scan.errors, [], "a repeated turnId in the usage ledger is not an error");
  const keys = scan.records.filter((r) => r.kind === "usage.jsonl").map((r) => r.key);
  assert.deepEqual(keys, ["T1", "T1#2", "T2"]);
  const db = await database();
  try {
    const first = await importLegacyState(db, "w1", scan, 300);
    assert.equal(first.imported, 3);
    assert.equal((await verifyLegacyImport(db, "w1", scan)).ok, true);
    const again = await importLegacyState(db, "w1", scanLegacyState(dir), 400, { refresh: true });
    assert.equal(again.imported, 0, "nothing new on the second import");
    assert.equal(again.skipped, 3);
  } finally {
    await db.close();
  }
});
