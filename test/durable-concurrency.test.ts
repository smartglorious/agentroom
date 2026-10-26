import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/core/config";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { schemaMigrations } from "../src/storage/schema-v1";
import { SqliteConnection } from "../src/storage/sqlite";
import { DurableTurnQueue } from "../src/storage/turn-queue";
import { Fake, idle, makeRoom } from "./helpers";

const CFG = `accounts: { c: { provider: claude, maxConcurrent: 2 } }
workers:
  - { id: lead, name: Lan, role: Lead, account: c, coordinator: true }
  - { id: be, name: Minh, role: Dev, account: c }
`;

test("durable: one human message that wakes two workers runs both turns", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ar-dual-")), "agentroom.db");
  const db = await SqliteConnection.open(file);
  try {
    await new SqliteMigrationRunner(db, schemaMigrations).apply();
    await db.run("INSERT OR IGNORE INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'Workspace', 'file:///w1', 1, 1)");
    const fake = new Fake(() => "[NOOP]");
    const { room } = makeRoom(fake, { config: parseConfig(CFG), turnQueue: new DurableTurnQueue(db, "w1", { leaseMs: 1_000 }) });
    room.post("user", "@lead Nhờ @be làm việc");
    await idle(room);
    await new Promise((r) => setTimeout(r, 100));
    const errors = room.snapshot().messages.filter((m) => m.from === "system" && /hit an error|gặp lỗi/.test(m.text));
    assert.deepEqual(errors.map((m) => m.text), [], "no worker turn may fail");
    assert.deepEqual(fake.calls.map((c) => c.worker.id).sort(), ["be", "lead"]);
  } finally {
    await db.close();
  }
});

test("durable: a turn longer than its lease keeps the lease, so another worker's claim neither expires it nor makes it fail at the end", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ar-lease-")), "agentroom.db");
  const db = await SqliteConnection.open(file);
  try {
    await new SqliteMigrationRunner(db, schemaMigrations).apply();
    await db.run("INSERT OR IGNORE INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'Workspace', 'file:///w1', 1, 1)");
    const fake = new Fake(async (req) => {
      if (req.worker.id === "be") await new Promise((r) => setTimeout(r, 1_200));
      return "[NOOP]";
    });
    const { room } = makeRoom(fake, { config: parseConfig(CFG), turnQueue: new DurableTurnQueue(db, "w1", { leaseMs: 300 }) });
    room.post("user", "@be Việc dài");
    await new Promise((r) => setTimeout(r, 700));
    // be's lease (300 ms) would be long gone; this claim runs recover over every step.
    room.post("user", "@lead Việc ngắn");
    await idle(room);
    await new Promise((r) => setTimeout(r, 200));
    const errors = room.snapshot().messages.filter((m) => m.from === "system" && /hit an error|gặp lỗi/.test(m.text));
    assert.deepEqual(errors.map((m) => m.text), [], "no worker turn may fail");
    assert.deepEqual(fake.calls.map((c) => c.worker.id).sort(), ["be", "lead"], "the long turn ran once, not again after its lease lapsed");
  } finally {
    await db.close();
  }
});
