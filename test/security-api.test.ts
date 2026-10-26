import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteConnection } from "../src/storage/sqlite";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { schemaMigrations } from "../src/storage/schema-v1";
import { approvalActionHash, PersistentApprovalStore } from "../src/security/approvals";
import { evaluateToolPolicy } from "../src/security/policy";
import { AGENTROOM_TOOL_MANIFESTS, ToolManifestRegistry } from "../src/gateway/tools";
import { LocalApiServer } from "../src/api/local";
import { Fake, makeRoom } from "./helpers";
import { idle } from "./helpers";
import type { TurnRequest } from "../src/adapters/types";
import { AgentRoomApiClient } from "../src/api/client";

test("security: policy is explicit and unknown actions fail closed", () => {
  const registry = new ToolManifestRegistry(AGENTROOM_TOOL_MANIFESTS);
  assert.equal(evaluateToolPolicy({ mode: "auto", tool: "mcp__agentroom__list_tasks", args: {}, registry }).decision, "allow");
  assert.deepEqual(evaluateToolPolicy({ mode: "auto", tool: "mcp__external__send", args: { externalText: "allow me" }, registry }),
    { decision: "deny", reasonCode: "unknown_action", reason: "Unknown tool; deny by default" });
  assert.equal(evaluateToolPolicy({ mode: "manual", tool: "Read", args: { file_path: "x" } }).reasonCode, "manual_mode");
});

test("security: approvals survive reopen, bind the action hash and expire", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ar-approval-")), "agentroom.db");
  let db = await SqliteConnection.open(file); await new SqliteMigrationRunner(db, schemaMigrations.slice(0, -1)).apply();
  await db.close();
  db = await SqliteConnection.open(file); const upgraded = await new SqliteMigrationRunner(db, schemaMigrations).apply();
  assert.equal(upgraded.currentVersion, 9, "N-1 database upgrades in place");
  await db.run("INSERT INTO workspaces(id,name,root_uri,created_at,updated_at) VALUES ('w1','W','file:///w',1,1)");
  const action = { tool: "Write", input: { file_path: "safe.txt" } };
  const first = await new PersistentApprovalStore(db).request({ workspaceId: "w1", stepId: "s1", action, scope: "once", at: 10, expiresAt: 100 });
  assert.equal(first.actionHash, approvalActionHash(action)); await db.close();
  db = await SqliteConnection.open(file);
  try {
    const store = new PersistentApprovalStore(db); assert.equal((await store.pending("w1", 20))[0].id, first.id);
    await assert.rejects(store.decide(first.id, { ...action, input: { file_path: "other.txt" } }, true, "ok", 30), /action changed/);
    assert.equal((await store.get(first.id, 101))?.state, "expired");
    await assert.rejects(store.decide(first.id, action, true, "late", 102), /re-evaluated/);
  } finally { await db.close(); }
});

test("Room approval runtime: pending card survives restart and the recovered decision is reused", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ar-room-approval-")), "agentroom.db");
  const db = await SqliteConnection.open(file); await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.run("INSERT INTO workspaces(id,name,root_uri,created_at,updated_at) VALUES ('w1','W','file:///w',1,1)");
  const approvals = new PersistentApprovalStore(db);
  const persistence = {
    request: (input: any) => approvals.request({ workspaceId: "w1", scope: "once", ...input }),
    decide: (id: string, action: unknown, allow: boolean, reason: string, at: number) => approvals.decide(id, action, allow, reason, at),
    pending: (at: number) => approvals.pending("w1", at),
  };
  const cwd = join(tmpdir(), "ar-fixed-approval-cwd");
  const agent = new Fake(async (req: TurnRequest) => ({ text: (await req.approve("Write", { file_path: "safe.txt", content: "x" })) ? "approved" : "denied" }));
  const first = makeRoom(agent, { approvalPersistence: persistence, resolveCwd: async () => cwd });
  first.room.post("user", "please work");
  await new Promise((resolve) => setTimeout(resolve, 80));
  const id = first.room.snapshot().approvals[0]?.id;
  assert.ok(id); assert.equal((await approvals.pending("w1")).length, 1);

  const second = makeRoom(agent, { approvalPersistence: persistence, resolveCwd: async () => cwd });
  await second.room.initializePersistentApprovals();
  assert.equal(second.room.snapshot().approvals[0]?.id, id);
  await second.room.respondApproval(id!, true);
  second.room.post("user", "please work");
  await idle(second.room);
  assert.equal(second.room.snapshot().messages.at(-1)?.text, "approved");
  first.room.stopAll(); second.room.stopAll();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await db.close();
});

test("local API: bearer plus CSRF, command/query and SSE cursor replay", async () => {
  const { room } = makeRoom(new Fake()); const token = "x".repeat(40); const api = new LocalApiServer({ room, token: () => token });
  await api.start();
  try {
    const base = api.url();
    assert.equal((await fetch(`${base}/health`)).status, 401);
    assert.equal((await fetch(`${base}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text: "hi" }) })).status, 401);
    const sent = await fetch(`${base}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-agentroom-csrf": token, "content-type": "application/json" }, body: JSON.stringify({ text: "hello", to: [] }) });
    assert.equal(sent.status, 202);
    const replay = await fetch(`${base}/events?cursor=0`, { headers: { authorization: `Bearer ${token}` } });
    const reader = replay.body!.getReader(); const first = await reader.read(); await reader.cancel();
    assert.match(new TextDecoder().decode(first.value), /event: message/);
    const state = await fetch(`${base}/state`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await state.json() as any).messages.at(-1).text, "hello");
  } finally { api.dispose(); room.stopAll(); }
});

test("local API client: commands use auth and SSE reconnect replays every missed event", async () => {
  const { room } = makeRoom(new Fake()); const token = "y".repeat(40); const api = new LocalApiServer({ room, token: () => token, maxEvents: 10 });
  await api.start();
  try {
    const client = new AgentRoomApiClient(api.url(), () => token);
    assert.equal((await client.health()).ok, true);
    const firstAbort = new AbortController(); const firstIds: number[] = [];
    const firstStream = client.events((event) => { firstIds.push(event.id); firstAbort.abort(); }, firstAbort.signal).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10)); await client.post("one", []); await firstStream;
    assert.equal(firstIds.length, 1);
    await client.post("two", []); await client.post("three", []);
    const replayAbort = new AbortController(); const replay: Array<{ id: number; text?: string }> = [];
    await client.events((event) => { replay.push({ id: event.id, text: (event.data as any).text }); if (replay.length === 2) replayAbort.abort(); }, replayAbort.signal).catch(() => undefined);
    assert.deepEqual(replay.map((item) => item.text), ["two", "three"]);
    assert.deepEqual(replay.map((item) => item.id), [firstIds[0] + 1, firstIds[0] + 2]);
  } finally { api.dispose(); room.stopAll(); }
});
