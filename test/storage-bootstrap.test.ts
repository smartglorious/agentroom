import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareStorage } from "../src/storage/bootstrap";

const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), "ar-storage-bootstrap-"));
  const state = join(root, ".agentroom", "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "tasks.json"), JSON.stringify([{
    id: "t1", title: "Imported", description: "", status: "todo", dependsOn: [], createdBy: "user", updatedAt: 1,
  }]));
  return { root, state };
};

test("storage bootstrap: legacy mode does not create SQLite or backups", async () => {
  const { root, state } = workspace();
  assert.deepEqual(await prepareStorage(root, state, "legacy"), { requested: "legacy", active: "legacy" });
  assert.equal(existsSync(join(state, "agentroom.db")), false);
  assert.equal(existsSync(join(root, ".agentroom", "backups")), false);
});

test("storage bootstrap: verify mode backs up, imports, verifies and remains legacy-authoritative", async () => {
  const { root, state } = workspace();
  const first = await prepareStorage(root, state, "verify");
  assert.equal(first.error, undefined);
  assert.equal(first.active, "legacy");
  assert.equal(first.health?.foreignKeys, true);
  assert.equal(first.verification?.ok, true);
  assert.equal(existsSync(first.database!), true);
  assert.equal(existsSync(join(root, ".agentroom", "backups", first.backupId!, "manifest.json")), true);

  const second = await prepareStorage(root, state, "verify");
  assert.equal(second.error, undefined);
  assert.equal(second.backupId, first.backupId);
  assert.equal(second.verification?.ledgerRecords, 1);
});

test("storage bootstrap: corrupt legacy input falls back clearly without creating a database", async () => {
  const { root, state } = workspace();
  writeFileSync(join(state, "tasks.json"), "broken");
  const result = await prepareStorage(root, state, "verify");
  assert.equal(result.active, "legacy");
  assert.match(result.error ?? "", /parse error/);
  assert.equal(existsSync(join(state, "agentroom.db")), false);
});

test("storage bootstrap: durable mode returns a verified live connection", async () => {
  const { root, state } = workspace();
  const result = await prepareStorage(root, state, "durable");
  assert.equal(result.error, undefined);
  assert.equal(result.active, "durable");
  assert.ok(result.workspaceId);
  assert.ok(result.connection);
  try {
    assert.deepEqual(await result.connection!.get("SELECT status FROM tasks WHERE id = 't1'"), { status: "todo" });
  } finally {
    await result.connection!.close();
  }
});

test("storage bootstrap: a live project keeps working across restarts: the legacy files change between starts and the snapshot is refreshed, in verify and durable", async () => {
  for (const mode of ["verify", "durable"] as const) {
    const { root, state } = workspace();
    const first = await prepareStorage(root, state, mode);
    assert.equal(first.error, undefined, `${mode}: first start`);
    await first.connection?.close();
    // What a running room does between two starts: tasks move on, a task gets a level, sessions and cursors change.
    writeFileSync(join(state, "tasks.json"), JSON.stringify([
      { id: "t1", title: "Imported", description: "", status: "done", dependsOn: [], createdBy: "user", updatedAt: 5, assignee: "be", result: "ok", level: "high" },
      { id: "t2", title: "New", description: "", status: "todo", dependsOn: ["t1"], createdBy: "lead", updatedAt: 6, level: "low" },
    ]));
    writeFileSync(join(state, "sessions.json"), JSON.stringify({ "be:main": "s-2" }));
    const second = await prepareStorage(root, state, mode);
    assert.equal(second.error, undefined, `${mode}: restart after the files changed`);
    assert.equal(second.active, mode === "durable" ? "durable" : "legacy");
    assert.equal(second.verification?.ok, true);
    await second.connection?.close();
    const third = await prepareStorage(root, state, mode);
    assert.equal(third.error, undefined, `${mode}: restart with nothing changed`);
    await third.connection?.close();
  }
});
