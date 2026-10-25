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
import { ContextBroker } from "../src/context/broker";
import { SqliteContextSources } from "../src/context/sources";
import { Fake, idle, makeRoom } from "./helpers";

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

test("Room bridge: normal turns complete a durable Run/Step without changing the reply UX", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ar-room-bridge-")), "agentroom.db");
  const db = await open(file);
  try {
    const queue = new DurableTurnQueue(db, "w1", { leaseMs: 1_000 });
    const fake = new Fake(() => "done");
    const { room } = makeRoom(fake, { turnQueue: queue });
    room.post("user", "@lead please continue");
    await idle(room);
    assert.equal(fake.calls.length, 1);
    assert.equal(room.snapshot().messages.some((item) => item.from === "lead" && item.text === "done"), true);
    assert.deepEqual(await db.get("SELECT status FROM runs"), { status: "succeeded" });
    assert.deepEqual(await db.get("SELECT status FROM steps"), { status: "succeeded" });
  } finally {
    await db.close();
  }
});

test("Room bridge: startup restores an expired in-flight batch and finishes it once", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ar-room-recover-")), "agentroom.db");
  let now = 100;
  const firstDb = await open(file);
  const firstQueue = new DurableTurnQueue(firstDb, "w1", { now: () => now, leaseMs: 50 });
  const turn = await firstQueue.enqueue({ workerId: "lead", sessionKey: "lead:main", messages: [message] });
  await firstQueue.claim(turn, "dead-process");
  await firstDb.close();

  now = 151;
  const secondDb = await open(file);
  try {
    const queue = new DurableTurnQueue(secondDb, "w1", { now: () => now, leaseMs: 50 });
    const fake = new Fake(() => "recovered");
    const { room } = makeRoom(fake, { turnQueue: queue, now: () => now });
    assert.equal(await room.recoverDurableTurns(), 1);
    await idle(room);
    assert.equal(fake.calls.length, 1);
    assert.equal((await secondDb.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", [turn.runId]))?.status, "succeeded");
    assert.equal(await room.recoverDurableTurns(), 0);
  } finally {
    await secondDb.close();
  }
});

test("Room bridge: startup waits for a live lease and automatically recovers when it expires", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ar-room-live-lease-")), "agentroom.db");
  let now = 100;
  const firstDb = await open(file);
  const firstQueue = new DurableTurnQueue(firstDb, "w1", { now: () => now, leaseMs: 30 });
  const turn = await firstQueue.enqueue({ workerId: "lead", sessionKey: "lead:main", messages: [message] });
  await firstQueue.claim(turn, "still-live");
  await firstDb.close();

  const secondDb = await open(file);
  const queue = new DurableTurnQueue(secondDb, "w1", { now: () => now, leaseMs: 30 });
  const fake = new Fake(() => "after-expiry");
  const { room } = makeRoom(fake, { turnQueue: queue, now: () => now });
  try {
    assert.equal(await room.recoverDurableTurns(), 0);
    assert.equal(fake.calls.length, 0);
    now = 131;
    await new Promise((resolve) => setTimeout(resolve, 60));
    await idle(room);
    assert.equal(fake.calls.length, 1);
  } finally {
    room.stopAll();
    await secondDb.close();
  }
});

test("Room bridge: a durable model turn receives its sealed ACL-filtered context packet", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ar-room-packet-")), "agentroom.db");
  const db = await open(file);
  try {
    await new SqliteContextSources(db).replace({ id: "guide", workspaceId: "w1", kind: "file", uri: "file:///guide", title: "Guide",
      trust: "untrusted", acl: ["lead"], chunks: [{ id: "guide-1", locator: "guide.md#L1", content: "migration checkpoint evidence" }], at: 10 });
    const queue = new DurableTurnQueue(db, "w1");
    const fake = new Fake(() => "used packet");
    const { room, deps } = makeRoom(fake, { turnQueue: queue, contextBroker: new ContextBroker(db) });
    room.post("user", "@lead review migration checkpoint");
    await idle(room);
    assert.match(fake.calls[0].prompt, /<task_packet/);
    assert.match(fake.calls[0].prompt, /migration checkpoint evidence/);
    assert.match(fake.calls[0].prompt, /trust=untrusted/);
    assert.equal((await db.get<{ count: number }>("SELECT count(*) AS count FROM task_packets"))?.count, 1);
    const reply = room.snapshot().messages.find((item) => item.from === "lead")!;
    assert.deepEqual(deps.inspector.load(reply.turnId!)?.taskPacket?.sources.map((source) => source.sourceId), ["guide"]);
  } finally {
    await db.close();
  }
});
