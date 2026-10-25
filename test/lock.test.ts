import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RoomLock } from "../src/core/lock";
import { ensureWorktree, expandHome, localBase } from "../src/core/worktree";

const tmp = () => mkdtempSync(join(tmpdir(), "lock-"));

test("lock: first window gets it, second is refused with the holder's details", () => {
  const f = join(tmp(), "state", "room.lock");
  const a = new RoomLock(f, { host: "laptop", pid: 111 });
  const b = new RoomLock(f, { host: "devbox", pid: 222 });
  assert.deepEqual(a.acquire(), { ok: true });
  const r = b.acquire();
  assert.equal(r.ok, false);
  assert.deepEqual([(r as { holder: { host: string; pid: number } }).holder.host, (r as { holder: { host: string; pid: number } }).holder.pid], ["laptop", 111]);
  assert.equal(b.isHeld, false);
  a.release(); b.release();
});

test("lock: release lets the next window in; re-acquire by the same instance is fine", () => {
  const f = join(tmp(), "room.lock");
  const a = new RoomLock(f), b = new RoomLock(f);
  a.acquire();
  assert.deepEqual(a.acquire(), { ok: true });
  a.release();
  assert.equal(existsSync(f), false);
  assert.deepEqual(b.acquire(), { ok: true });
  b.release();
});

test("lock: an abandoned lock (no heartbeat) is taken over, a fresh one is not", () => {
  const f = join(tmp(), "room.lock");
  const clock = { t: 1_000_000 };
  const dead = new RoomLock(f, { now: () => clock.t, staleMs: 20_000 });
  dead.acquire();
  clock.t += 19_000;
  assert.equal(new RoomLock(f, { now: () => clock.t, staleMs: 20_000 }).acquire().ok, false);
  clock.t += 2_000;
  const heir = new RoomLock(f, { now: () => clock.t, staleMs: 20_000 });
  assert.deepEqual(heir.acquire(), { ok: true });
  assert.equal(heir.peek()!.token, heir.token);
  heir.release();
  dead.release();
});

test("lock: heartbeat keeps it fresh; a corrupt file counts as abandoned", () => {
  const f = join(tmp(), "room.lock");
  const clock = { t: 5_000 };
  const a = new RoomLock(f, { now: () => clock.t, staleMs: 20_000 });
  a.acquire();
  for (let i = 0; i < 10; i++) { clock.t += 10_000; a.beat(); }
  assert.equal(new RoomLock(f, { now: () => clock.t, staleMs: 20_000 }).acquire().ok, false, "still held after 100s thanks to beats");
  a.release();
  writeFileSync(f, "{not json");
  const b = new RoomLock(f);
  assert.deepEqual(b.acquire(), { ok: true });
  b.release();
});

test("lock: take over makes the previous holder notice and report it lost", () => {
  const f = join(tmp(), "room.lock");
  const a = new RoomLock(f), b = new RoomLock(f);
  let lost = 0;
  a.on("lost", () => lost++);
  a.acquire();
  b.takeOver();
  a.beat();
  assert.equal(lost, 1);
  assert.equal(a.isHeld, false);
  a.beat();
  assert.equal(lost, 1, "reported once");
  a.release();
  assert.equal(JSON.parse(readFileSync(f, "utf8")).token, b.token, "a's release must not delete b's lock");
  b.release();
});

test("lock: racing windows — at most one believes it holds the lock after a heartbeat", () => {
  const f = join(tmp(), "room.lock");
  const racers = Array.from({ length: 6 }, () => new RoomLock(f));
  const results = racers.map((r) => r.acquire().ok);
  assert.equal(results.filter(Boolean).length, 1);
  racers.forEach((r) => r.release());
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function repo() {
  const d = tmp();
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.email", "t@t"); git(d, "config", "user.name", "t");
  writeFileSync(join(d, "a.txt"), "a");
  git(d, "add", "."); git(d, "commit", "-qm", "init");
  return d;
}

test("workdir: relative, absolute and ~ paths resolve; the workspace is the default", () => {
  assert.equal(localBase("/ws", {}), "/ws");
  assert.equal(localBase("/ws", { workdir: "../other" }), resolve("/ws", "../other"));
  assert.equal(localBase("/ws", { workdir: "/abs/clone" }), "/abs/clone");
  assert.equal(localBase("/ws", { workdir: "~/code/app" }, "/home/u"), join("/home/u", "code/app"));
  assert.equal(expandHome("~", "/home/u"), "/home/u");
  assert.equal(expandHome("~x/y", "/home/u"), "~x/y");
});

test("worktree: created inside a different clone, ignored by git there, reused, and branch is agentroom/<id>", async () => {
  const other = repo();
  const dir = await ensureWorktree(other, { id: "be", worktree: true });
  assert.equal(dir, join(other, ".agentroom", "worktrees", "be"));
  assert.equal(git(dir, "branch", "--show-current"), "agentroom/be");
  assert.equal(git(other, "status", "--porcelain"), "", "the clone stays clean");
  assert.match(readFileSync(join(other, ".agentroom", ".gitignore"), "utf8"), /^\*$/m);
  assert.equal(await ensureWorktree(other, { id: "be", worktree: true }), dir);
  // an existing .gitignore is extended, not replaced
  const third = repo();
  mkdirSync(join(third, ".agentroom"));
  writeFileSync(join(third, ".agentroom", ".gitignore"), "state/");
  await ensureWorktree(third, { id: "fe", worktree: true });
  assert.equal(readFileSync(join(third, ".agentroom", ".gitignore"), "utf8"), "state/\nworktrees/\n");
});

test("worktree: no worktree flag → base itself; not a repo → base; missing folder → clear error", async () => {
  const plain = tmp();
  assert.equal(await ensureWorktree(plain, { id: "x", worktree: false }), plain);
  assert.equal(await ensureWorktree(plain, { id: "x", worktree: true }), plain);
  await assert.rejects(ensureWorktree(join(plain, "nope"), { id: "x", worktree: true }), /không tồn tại/);
});
