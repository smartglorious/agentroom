import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { schemaMigrations } from "../src/storage/schema-v1";
import { SqliteConnection } from "../src/storage/sqlite";

test("schema v4: adds durable execution, failure and context tables", async () => {
  const db = await SqliteConnection.open(join(mkdtempSync(join(tmpdir(), "ar-schema-v2-")), "agentroom.db"));
  try {
    const state = await new SqliteMigrationRunner(db, schemaMigrations).apply();
    assert.equal(state.currentVersion, 4);
    const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    for (const name of ["checkpoints", "tool_receipts", "execution_outbox", "execution_dead_letters", "context_sources", "context_chunks", "context_chunks_fts", "task_packets"]) {
      assert.equal(tables.some((table) => table.name === name), true);
    }
    const columns = await db.all<{ name: string }>("PRAGMA table_info(steps)");
    for (const name of ["attempt", "lease_token", "lease_owner", "lease_expires_at", "error_json", "retry_at"]) {
      assert.equal(columns.some((column) => column.name === name), true);
    }
  } finally {
    await db.close();
  }
});
