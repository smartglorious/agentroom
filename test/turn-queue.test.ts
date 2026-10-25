import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "../src/core/types";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { schemaMigrations } from "../src/storage/schema-v1";
import { SqliteConnection } from "../src/storage/sqlite";
import { DurableTurnQueue } from "../src/storage/turn-queue";

const open = async (file: string) => {
  const db = await SqliteConnection.open(file);
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.run("INSERT OR IGNORE INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'Workspace', 'file:///w1', 1, 1)");
  return db;
};

const message: ChatMessage = { id: "m1", ts: 10, from: "user", text: "ship it", to: ["lead"], depth: 0, chain: "m1" };

test("turn queue: the same Room batch creates one deterministic run and claims only its own step", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ar-turn-queue-")), "agentroom.db");
  const db = await open(file);
  try {
    let seq = 0;
    const queue = new DurableTurnQueue(db, "w1", { now: () => 100, id: (kind) => `${kind}-${++seq}` });
    const first = await queue.enqueue({ workerId: "lead", sessionKey: "lead:main", messages: [message] });
    const duplicate = await queue.enqueue({ workerId: "lead", sessionKey: "lead:main", messages: [message] });
    assert.equal(duplicate.runId, first.runId);
    assert.equal((await db.get<{ count: number }>("SELECT count(*) AS count FROM runs"))?.count, 1);
    const claimed = (await queue.claim(first, "dispatcher"))!;
    assert.equal(claimed.step.id, first.stepId);
    assert.equal((await queue.succeed(claimed)).status, "succeeded");
    assert.deepEqual(await queue.recoverable(), []);
  } finally {
    await db.close();
  }
});

test("turn queue: a killed turn reappears with its exact message batch after lease expiry", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ar-turn-restart-")), "agentroom.db");
  let now = 100;
  const firstDb = await open(file);
  const firstQueue = new DurableTurnQueue(firstDb, "w1", { now: () => now, leaseMs: 50 });
  const turn = await firstQueue.enqueue({ workerId: "lead", sessionKey: "lead:main", messages: [message] });
  await firstQueue.claim(turn, "process-1");
  await firstDb.close();

  now = 151;
  const secondDb = await open(file);
  try {
    const secondQueue = new DurableTurnQueue(secondDb, "w1", { now: () => now, leaseMs: 50 });
    const recovered = await secondQueue.recoverable();
    assert.deepEqual(recovered, [turn]);
    assert.equal((await secondQueue.claim(recovered[0], "process-2"))?.step.attempt, 2);
  } finally {
    await secondDb.close();
  }
});
