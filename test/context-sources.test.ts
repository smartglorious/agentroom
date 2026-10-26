import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteContextSources } from "../src/context/sources";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { schemaMigrations } from "../src/storage/schema-v1";
import { SqliteConnection } from "../src/storage/sqlite";

const setup = async () => {
  const db = await SqliteConnection.open(join(mkdtempSync(join(tmpdir(), "ar-context-")), "agentroom.db"));
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.exec(`
    INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'One', 'file:///one', 1, 1);
    INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w2', 'Two', 'file:///two', 1, 1);
  `);
  return db;
};

test("context sources: FTS retrieval enforces workspace, ACL and active state", async () => {
  const db = await setup();
  try {
    const sources = new SqliteContextSources(db);
    await sources.replace({ id: "public", workspaceId: "w1", kind: "file", uri: "file:///one/public.md", title: "Public",
      trust: "trusted", acl: ["*"], chunks: [{ id: "c1", locator: "public.md#L1", content: "durable migration guide" }], at: 10 });
    await sources.replace({ id: "private", workspaceId: "w1", kind: "file", uri: "file:///one/private.md", title: "Private",
      trust: "untrusted", acl: ["qa"], chunks: [{ id: "c2", locator: "private.md#L1", content: "migration secret checklist" }], at: 10 });
    await sources.replace({ id: "other", workspaceId: "w2", kind: "file", uri: "file:///two/other.md", title: "Other",
      trust: "trusted", acl: ["*"], chunks: [{ id: "c3", locator: "other.md#L1", content: "migration from another workspace" }], at: 10 });

    assert.deepEqual((await sources.search({ workspaceId: "w1", agentId: "lead", query: "migration" })).map((item) => item.sourceId), ["public"]);
    assert.deepEqual(new Set((await sources.search({ workspaceId: "w1", agentId: "qa", query: "migration" })).map((item) => item.sourceId)), new Set(["public", "private"]));
    await sources.setState("w1", "public", "tombstoned", 20);
    assert.deepEqual((await sources.search({ workspaceId: "w1", agentId: "lead", query: "migration" })).map((item) => item.sourceId), []);
  } finally {
    await db.close();
  }
});

test("context sources: replacement is atomic, versioned and keeps FTS in sync", async () => {
  const db = await setup();
  try {
    const sources = new SqliteContextSources(db);
    const base = { id: "s1", workspaceId: "w1", kind: "file", uri: "file:///one/a.md", title: "A", trust: "trusted" as const, acl: ["*"] };
    await sources.replace({ ...base, chunks: [{ id: "old", locator: "a.md#L1", content: "old migration text" }], at: 10 });
    await sources.replace({ ...base, chunks: [{ id: "new", locator: "a.md#L2", content: "new checkpoint text" }], at: 20 });
    assert.equal((await db.get<{ version: number }>("SELECT version FROM context_sources WHERE id = 's1'"))?.version, 2);
    assert.equal((await sources.search({ workspaceId: "w1", agentId: "lead", query: "migration" })).length, 0);
    assert.deepEqual((await sources.search({ workspaceId: "w1", agentId: "lead", query: "checkpoint" })).map((item) => item.chunkId), ["new"]);

    await assert.rejects(sources.replace({ ...base, chunks: [
      { id: "dup", locator: "1", content: "x" }, { id: "dup", locator: "2", content: "y" },
    ], at: 30 }), /unique/);
    assert.deepEqual((await sources.search({ workspaceId: "w1", agentId: "lead", query: "checkpoint" })).map((item) => item.chunkId), ["new"]);
  } finally {
    await db.close();
  }
});
