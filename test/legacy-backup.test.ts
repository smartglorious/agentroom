import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLegacyBackup, inventoryLegacyState, restoreLegacyBackup } from "../src/storage/legacy-backup";
import { RoomStore } from "../src/core/store";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "ar-backup-"));
  const state = join(root, "state");
  const backups = join(root, "backups");
  mkdirSync(state);
  writeFileSync(join(state, "tasks.json"), '[{"id":"t1"}]');
  writeFileSync(join(state, "chat.jsonl"), '{"id":"m1"}\n');
  writeFileSync(join(state, "usage.jsonl"), '{"turnId":"u1"}\n');
  return { root, state, backups };
};

test("legacy backup: copies known files, verifies hashes and publishes a complete manifest", () => {
  const { state, backups } = fixture();
  const manifest = createLegacyBackup(state, backups, "migration-1", new Date("2026-10-25T00:00:00.000Z"));
  assert.equal(manifest.complete, true);
  assert.deepEqual(manifest.files.map((file) => file.path), ["chat.jsonl", "tasks.json", "usage.jsonl"]);
  assert.match(manifest.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(readFileSync(join(backups, "migration-1", "tasks.json"), "utf8"), '[{"id":"t1"}]');
  assert.deepEqual(JSON.parse(readFileSync(join(backups, "migration-1", "manifest.json"), "utf8")), manifest);
  assert.throws(() => createLegacyBackup(state, backups, "migration-1"), /already exists/);
});

test("legacy backup: rejects unsafe IDs and never follows symbolic links", (t) => {
  const { root, state, backups } = fixture();
  assert.throws(() => createLegacyBackup(state, backups, "../escape"), /Invalid migration ID/);
  const target = join(root, "secret.txt");
  writeFileSync(target, "secret");
  try {
    symlinkSync(target, join(state, "sessions.json"));
  } catch (error) {
    t.skip(`symlinks unavailable: ${String(error)}`);
    return;
  }
  const inventory = inventoryLegacyState(state);
  assert.deepEqual(inventory.skipped, [{ path: "sessions.json", reason: "symbolic link" }]);
  const manifest = createLegacyBackup(state, backups, "migration-2");
  assert.equal(manifest.files.some((file) => file.path === "sessions.json"), false);
});

test("legacy backup: an interrupted staging directory can be verified and resumed", () => {
  const { state, backups } = fixture();
  const staging = join(backups, ".resume.staging");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "tasks.json"), "partial");
  const manifest = createLegacyBackup(state, backups, "resume");
  assert.equal(manifest.complete, true);
  assert.equal(readFileSync(join(backups, "resume", "tasks.json"), "utf8"), '[{"id":"t1"}]');
});

test("legacy backup: verified restore opens through the legacy adapter and never overwrites", () => {
  const { root, state, backups } = fixture();
  writeFileSync(join(state, "tasks.json"), JSON.stringify([{
    id: "t1", title: "Restored", description: "", status: "todo", dependsOn: [], createdBy: "user", updatedAt: 1,
  }]));
  createLegacyBackup(state, backups, "restore-me");
  const target = join(root, "restored-state");
  restoreLegacyBackup(join(backups, "restore-me"), target);
  assert.equal(new RoomStore(target).loadTasks()[0].title, "Restored");
  assert.throws(() => restoreLegacyBackup(join(backups, "restore-me"), target), /not empty/);
});

test("legacy backup: corrupt bytes are rejected before the restore target is created", () => {
  const { root, state, backups } = fixture();
  createLegacyBackup(state, backups, "corrupt");
  writeFileSync(join(backups, "corrupt", "tasks.json"), "tampered");
  const target = join(root, "must-not-exist");
  assert.throws(() => restoreLegacyBackup(join(backups, "corrupt"), target), /checksum mismatch/);
  assert.throws(() => readFileSync(join(target, "tasks.json")), /ENOENT/);
});
