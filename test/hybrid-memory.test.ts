import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HybridMemoryRepository } from "../src/memory/repository";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { schemaMigrations } from "../src/storage/schema-v1";
import { SqliteConnection } from "../src/storage/sqlite";

const setup = async () => {
  const db = await SqliteConnection.open(join(mkdtempSync(join(tmpdir(), "ar-memory-")), "agentroom.db"));
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.run("INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'One', 'file:///one', 1, 1)");
  return db;
};

test("hybrid memory: candidate privacy, dedup, accept and scoped ACL/TTL recall", async () => {
  const db = await setup();
  try {
    const memory = new HybridMemoryRepository(db);
    await assert.rejects(memory.propose({ workspaceId: "w1", scope: "agent", scopeId: "qa", kind: "semantic",
      content: "api_key=sk-abcdefghijklmnop", confidence: 0.9, provenance: {}, reason: "observed", at: 10 }), /secret/);
    const candidate = await memory.propose({ id: "c1", workspaceId: "w1", scope: "agent", scopeId: "qa", kind: "semantic",
      content: "  SQLite uses WAL mode  ", confidence: 0.9, provenance: { source: "ADR" }, reason: "verified", at: 10 });
    assert.equal(candidate.status, "pending");
    assert.equal(await memory.accept("c1", { memoryId: "m1", importance: 0.8, acl: ["qa"], expiresAt: 100, at: 11 }), "m1");
    assert.deepEqual((await memory.recall({ workspaceId: "w1", agentId: "qa", scopes: [{ scope: "agent", scopeId: "qa" }], query: "SQLite WAL", now: 50 })).map((hit) => hit.id), ["m1"]);
    assert.deepEqual(await memory.recall({ workspaceId: "w1", agentId: "lead", scopes: [{ scope: "agent", scopeId: "qa" }], query: "SQLite", now: 50 }), []);
    assert.deepEqual(await memory.recall({ workspaceId: "w1", agentId: "qa", scopes: [{ scope: "agent", scopeId: "qa" }], query: "SQLite", now: 101 }), []);
    assert.equal((await memory.propose({ id: "c2", workspaceId: "w1", scope: "agent", scopeId: "qa", kind: "semantic",
      content: "SQLite uses WAL mode", confidence: 0.7, provenance: {}, reason: "again", at: 20 })).status, "duplicate");
  } finally { await db.close(); }
});

test("hybrid memory: supersede is explicit and delete removes row, FTS, relations and content", async () => {
  const db = await setup();
  try {
    const memory = new HybridMemoryRepository(db);
    await memory.propose({ id: "c1", workspaceId: "w1", scope: "workspace", scopeId: "w1", kind: "procedural",
      content: "Deploy on Friday", confidence: 0.8, provenance: { source: "user" }, reason: "preference", at: 10 });
    await memory.accept("c1", { memoryId: "m1", acl: ["*"], at: 11 });
    await memory.propose({ id: "c2", workspaceId: "w1", scope: "workspace", scopeId: "w1", kind: "procedural",
      content: "Deploy on Monday", confidence: 1, provenance: { source: "user" }, reason: "correction", at: 20 });
    await memory.accept("c2", { memoryId: "m2", acl: ["*"], supersedes: "m1", at: 21 });
    assert.deepEqual(await db.get("SELECT status FROM memories WHERE id = 'm1'"), { status: "superseded" });
    assert.deepEqual(await db.get("SELECT kind FROM memory_relations"), { kind: "supersedes" });
    await memory.delete("w1", "m2", "user requested", 30);
    assert.equal(await db.get("SELECT id FROM memories WHERE id = 'm2'"), undefined);
    assert.equal(await db.get("SELECT memory_id FROM memories_fts WHERE memory_id = 'm2'"), undefined);
    assert.equal((await db.get<{ count: number }>("SELECT count(*) AS count FROM memory_deletion_audit WHERE memory_id = 'm2'"))?.count, 1);
    assert.equal(JSON.stringify(await db.get("SELECT * FROM memory_deletion_audit WHERE memory_id = 'm2'")).includes("Deploy"), false);
  } finally { await db.close(); }
});
