import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "../src/storage/events";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { SqliteOutbox } from "../src/storage/outbox";
import { schemaMigrations } from "../src/storage/schema-v1";
import { SqliteConnection } from "../src/storage/sqlite";
import { SqliteToolReceiptStore, toolArgsHash } from "../src/storage/tool-receipts";

const setup = async () => {
  const db = await SqliteConnection.open(join(mkdtempSync(join(tmpdir(), "ar-effects-")), "agentroom.db"));
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.exec(`
    INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'Workspace', 'file:///w1', 1, 1);
    INSERT INTO tasks(id, workspace_id, title, status, created_by, created_at, updated_at) VALUES ('t1', 'w1', 'Task', 'todo', 'user', 1, 1);
    INSERT INTO runs(id, workspace_id, task_id, status, attempt, created_at, updated_at) VALUES ('r1', 'w1', 't1', 'running', 1, 1, 1);
    INSERT INTO steps(id, workspace_id, run_id, ordinal, kind, status, idempotency_key, version, created_at, updated_at)
      VALUES ('s1', 'w1', 'r1', 0, 'tool', 'running', 'tool:0', 1, 1, 1);
  `);
  return db;
};

test("tool receipts: semantic keys fence duplicate and conflicting effects", async () => {
  const db = await setup();
  try {
    const receipts = new SqliteToolReceiptStore(db);
    const intent = { id: "receipt-1", workspaceId: "w1", stepId: "s1", semanticKey: "write:config", toolId: "Write", args: { b: 2, a: 1 }, risk: "write", at: 10 };
    const first = await receipts.begin(intent);
    assert.equal(first.execute, true);
    assert.equal(first.receipt.argsHash, toolArgsHash({ a: 1, b: 2 }));
    const retryBeforeOutcome = await receipts.begin({ ...intent, id: "ignored", args: { a: 1, b: 2 } });
    assert.equal(retryBeforeOutcome.execute, false, "an unresolved intent must be reconciled, not executed again");

    const done = await receipts.resolve("receipt-1", "succeeded", { bytes: 12 }, 20);
    assert.equal(done.status, "succeeded");
    assert.deepEqual(done.receipt, { bytes: 12 });
    assert.equal((await receipts.begin(intent)).execute, false);
    assert.equal((await receipts.resolve("receipt-1", "succeeded", { bytes: 12 }, 30)).updatedAt, 20);
    await assert.rejects(receipts.resolve("receipt-1", "failed", { reason: "late" }, 30), /already succeeded/);
    await assert.rejects(receipts.begin({ ...intent, args: { a: 2 } }), /different intent/);
  } finally {
    await db.close();
  }
});

test("outbox: event and delivery intent commit atomically, then retry with bounded state", async () => {
  const db = await setup();
  try {
    const events = new SqliteEventStore(db);
    const outbox = new SqliteOutbox(db);
    await events.append({
      eventId: "event-1", workspaceId: "w1", aggregateType: "workspace", aggregateId: "w1",
      expectedVersion: 0, type: "NoticeQueued", schemaVersion: 1, payload: {}, occurredAt: 10,
    }, async (tx, event) => outbox.enqueueWithin(tx, {
      workspaceId: "w1", eventId: event.eventId, destination: "telegram", payload: { text: "hello" }, availableAt: 10,
    }));
    assert.deepEqual((await outbox.pending(10)).map((item) => item.payload), [{ text: "hello" }]);
    const item = (await outbox.pending(10))[0];
    await outbox.failed(item.seq, "network", 20);
    assert.equal((await outbox.pending(19)).length, 0);
    assert.equal((await outbox.pending(20))[0].attempts, 1);
    await outbox.delivered(item.seq, 21);
    assert.equal((await outbox.pending(100)).length, 0);
  } finally {
    await db.close();
  }
});

test("outbox: a projector failure rolls back both event and outbox row", async () => {
  const db = await setup();
  try {
    const events = new SqliteEventStore(db);
    const outbox = new SqliteOutbox(db);
    await assert.rejects(events.append({
      eventId: "event-bad", workspaceId: "w1", aggregateType: "workspace", aggregateId: "w1",
      expectedVersion: 0, type: "NoticeQueued", schemaVersion: 1, payload: {}, occurredAt: 10,
    }, async (tx, event) => {
      await outbox.enqueueWithin(tx, { workspaceId: "w1", eventId: event.eventId, destination: "x", payload: {}, availableAt: 10 });
      throw new Error("projector failed");
    }), /projector failed/);
    assert.equal((await events.readAggregate("workspace", "w1")).length, 0);
    assert.equal((await outbox.pending(100)).length, 0);
  } finally {
    await db.close();
  }
});
