import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherCleanup, listBatches, restoreCleanup, scanCleanup } from "../src/core/cleanup";

function repo() {
  const r = mkdtempSync(join(tmpdir(), "ar-clean-"));
  execFileSync("git", ["init", "-q", r]);
  const w = (rel: string, body = "x") => { mkdirSync(join(r, rel, ".."), { recursive: true }); writeFileSync(join(r, rel), body); };
  w("src/app.ts", "code"); w("src/notes.tmp", "scratch"); w("a/.DS_Store"); w("a/b/__pycache__/m.pyc", "zz"); w("keep.bak", "tracked backup");
  w("node_modules/p/x.tmp"); w(".git/hooks/y.tmp");
  execFileSync("git", ["-C", r, "add", "src/app.ts", "keep.bak"]);
  return { r, w };
}

test("cleanup: scan is read-only, finds junk/temp/cache, skips git-tracked files, node_modules and .git", () => {
  const { r } = repo();
  const rels = scanCleanup(r).map((i) => i.rel).sort();
  assert.deepEqual(rels, ["a/.DS_Store", "a/b/__pycache__", "src/notes.tmp"]);
  assert.ok(existsSync(join(r, "src/notes.tmp")), "scan must not touch anything");
});

test("cleanup: gather MOVES into .agentroom/cleanup/<stamp>, writes a manifest, deletes nothing", () => {
  const { r } = repo();
  const { dir, manifest, skipped } = gatherCleanup(r, ["src/notes.tmp", "a/b/__pycache__"]);
  assert.equal(skipped.length, 0);
  assert.ok(!existsSync(join(r, "src/notes.tmp")));
  assert.equal(readFileSync(join(dir, "files/src/notes.tmp"), "utf8"), "scratch");
  assert.ok(existsSync(join(dir, "files/a/b/__pycache__/m.pyc")));
  assert.equal(manifest.entries.length, 2);
  assert.equal(listBatches(r).length, 1);
});

test("cleanup: refuses paths outside the project, .git, node_modules, and ../ escapes; missing ones are reported", () => {
  const { r } = repo();
  const res = gatherCleanup(r, ["../outside.tmp", ".git/hooks/y.tmp", "node_modules/p/x.tmp", "nope.tmp", "/etc/hostname"]);
  assert.equal(res.manifest.entries.length, 0);
  assert.equal(res.skipped.length, 5);
  assert.ok(existsSync(join(r, "node_modules/p/x.tmp")) && existsSync(join(r, ".git/hooks/y.tmp")));
  assert.ok(!existsSync(join(r, ".agentroom/cleanup")), "no empty batch folder");
});

test("cleanup: restore puts files back and never overwrites a newer file", () => {
  const { r, w } = repo();
  const { manifest } = gatherCleanup(r, ["src/notes.tmp", "a/.DS_Store"]);
  w("a/.DS_Store", "newer");
  const res = restoreCleanup(r, manifest.stamp);
  assert.deepEqual(res.restored, ["src/notes.tmp"]);
  assert.equal(res.skipped[0].why, "đã có file mới ở chỗ cũ");
  assert.equal(readFileSync(join(r, "a/.DS_Store"), "utf8"), "newer");
  assert.throws(() => restoreCleanup(r, "../x"));
});

test("cleanup: symlinks are not followed; old Inspector turn records are offered only when asked", () => {
  const { r, w } = repo();
  symlinkSync("/tmp", join(r, "lnk.tmp"));
  assert.ok(!scanCleanup(r).some((i) => i.rel === "lnk.tmp"));
  w(".agentroom/state/turns/old.json", "{}"); w(".agentroom/state/turns/new.json", "{}");
  const old = (Date.now() - 40 * 86_400_000) / 1000;
  utimesSync(join(r, ".agentroom/state/turns/old.json"), old, old);
  assert.ok(!scanCleanup(r).some((i) => i.kind === "agentroom"));
  assert.deepEqual(scanCleanup(r, { turnsOlderThanDays: 30 }).filter((i) => i.kind === "agentroom").map((i) => i.rel), [".agentroom/state/turns/old.json"]);
});

test("cleanup: adds cleanup/ to an existing .agentroom/.gitignore once", () => {
  const { r, w } = repo();
  w(".agentroom/.gitignore", "state/\n"); w("x.tmp");
  gatherCleanup(r, ["x.tmp"]); w("y.tmp"); gatherCleanup(r, ["y.tmp"], Date.now() + 5000);
  assert.equal(readFileSync(join(r, ".agentroom/.gitignore"), "utf8"), "state/\ncleanup/\n");
});
