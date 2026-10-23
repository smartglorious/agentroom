import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, SAMPLE_CONFIG } from "../src/core/config";
import { MAX_ENTRIES, MemoryError, MemoryStore, findSecret, fitTail, redactSecrets } from "../src/core/memory";
import { Fake, idle, makeRoom } from "./helpers";

const W = parseConfig(SAMPLE_CONFIG).workers;
const be = W.find((w) => w.id === "be")!;
const fresh = (now = () => new Date(2026, 9, 23, 14, 5)) => { const m = new MemoryStore(mkdtempSync(join(tmpdir(), "mem-")), now); m.ensureWorker(be); return m; };

test("memory: add, ids increment, forget, hand-written lines survive", () => {
  const m = fresh();
  const a = m.add("me", "be", "lesson", "Test e2e cần docker compose up db");
  const b = m.add("me", "be", "fact", "Bảng orders dùng soft-delete\nmọi query phải lọc");
  assert.deepEqual([a.id, b.id], ["M1", "M2"]);
  assert.equal(b.text, "Bảng orders dùng soft-delete mọi query phải lọc");
  assert.equal(a.date, "2026-10-23");
  writeFileSync(m.memoryFile("me", "be"), readFileSync(m.memoryFile("me", "be"), "utf8") + "Ghi chú tay của người dùng\n");
  m.forget("me", "be", "M1");
  assert.deepEqual(m.entries("me", "be").map((e) => e.id), ["M2"]);
  assert.match(readFileSync(m.memoryFile("me", "be"), "utf8"), /Ghi chú tay của người dùng/);
  assert.equal(m.add("me", "be", "fact", "mới").id, "M3");
  assert.throws(() => m.forget("me", "be", "M99"), MemoryError);
});

test("memory: decisions are protected unless forced", () => {
  const m = fresh();
  const d = m.add("team", "be", "decision", "Dùng Postgres, không dùng Mongo");
  assert.throws(() => m.forget("team", "be", d.id), /decision/);
  m.forget("team", "be", d.id, true);
  assert.equal(m.entries("team", "be").length, 0);
});

test("memory: refuses secrets, empty, oversized and a full file", () => {
  const m = fresh();
  for (const bad of ["key sk-abcdefghijklmnopqrstuvwx", "ghp_abcdefghijklmnopqrstuvwxyz0123", "AKIAABCDEFGHIJKLMNOP", "password = hunter2hunter2", "-----BEGIN RSA PRIVATE KEY-----"]) {
    assert.throws(() => m.add("me", "be", "fact", bad), /bí mật|khóa/, bad);
    assert.ok(findSecret(bad));
  }
  assert.throws(() => m.add("me", "be", "fact", "   "), /trống/);
  assert.throws(() => m.add("me", "be", "fact", "x".repeat(501)), /dài/);
  assert.throws(() => m.add("me", "be", "bogus" as never, "x"), /kind/);
  for (let i = 0; i < MAX_ENTRIES; i++) m.add("me", "be", "fact", `mục ${i}`);
  assert.throws(() => m.add("me", "be", "fact", "thêm"), /đầy/);
  assert.equal(redactSecrets("dùng sk-abcdefghijklmnopqrstuvwx nhé"), "dùng [đã ẩn] nhé");
});

test("memory: journal appends per day; recall finds memory, team and journal, newest first", () => {
  let day = 23;
  const m = fresh(() => new Date(2026, 9, day, 9, 30));
  m.journal("be", "Sửa lỗi timeout ở orders");
  day = 24;
  m.journal("be", "Thêm test cho orders");
  m.add("me", "be", "fact", "orders có soft-delete");
  m.add("team", "be", "decision", "Mọi API orders phải có test e2e");
  assert.deepEqual(m.journalDates("be"), ["2026-10-23", "2026-10-24"]);
  assert.throws(() => m.journal("be", "token = abcdef123456"), /khóa/);
  const hits = m.recall("be", "ORDERS", 10);
  assert.equal(hits.length, 4);
  assert.deepEqual(hits.map((h) => h.where), ["memory", "team", "journal 2026-10-24", "journal 2026-10-23"]);
  assert.equal(m.recall("be", "orders test").length, 2);
  assert.equal(m.recall("be", "không có gì", 5).length, 0);
});

test("memory: blocks respect the budget, keep the newest lines, hide the untouched SOUL template", () => {
  const m = fresh();
  assert.equal(m.blocks(be).soul, "");
  for (let i = 0; i < 100; i++) m.add("me", "be", "fact", `sự kiện số ${i} ${"x".repeat(40)}`);
  const b = m.blocks(be, 2000);
  assert.ok(b.mine.length <= 2000 * 0.4 + 120, `mine=${b.mine.length}`);
  assert.match(b.mine, /sự kiện số 99/);
  assert.doesNotMatch(b.mine, /sự kiện số 0 /);
  assert.match(b.mine, /dòng cũ hơn bị lược/);
  writeFileSync(m.soulFile("be"), "# Minh\nLuôn viết test trước.\n");
  assert.match(m.blocks(be).soul, /Luôn viết test trước/);
  assert.equal(fitTail("# h\na\nb", 1000), "# h\na\nb");
});

test("memory: ensureWorker never overwrites user files", () => {
  const m = fresh();
  writeFileSync(m.soulFile("be"), "# mine\n");
  m.ensureWorker(be);
  assert.equal(readFileSync(m.soulFile("be"), "utf8"), "# mine\n");
});

test("room: memory written in one session is in the persona of a brand-new session", async () => {
  const fake = new Fake((req) => {
    if (req.prompt.includes("T-first")) req.mcpUrl; // no-op, keep prompt referenced
    return "ok";
  });
  const { room } = makeRoom(fake);
  room.memory.add("me", "be", "lesson", "Chạy migrate trước khi test");
  room.post("user", "@be việc một", { taskId: "A" });
  await idle(room);
  room.post("user", "@be việc hai", { taskId: "B" });
  await idle(room);
  assert.equal(fake.calls.length, 2);
  assert.notEqual(fake.calls[1].sessionId, "s-be", "task B must start a new session");
  assert.match(fake.calls[1].systemAppend, /Chạy migrate trước khi test/);
  assert.match(fake.calls[1].systemAppend, /Trí nhớ của bạn/);
});

test("room: each turn writes a journal line with the files that were edited", async () => {
  const fake = new Fake((req) => { req.onActivity("Edit apps/api/src/orders.ts"); req.onActivity("Bash pnpm test"); return "Đã thêm endpoint orders"; });
  const { room, deps } = makeRoom(fake);
  room.post("user", "@be thêm endpoint", { taskId: "T1" });
  await idle(room);
  const day = deps.memory.journalDates("be")[0];
  const j = deps.memory.readJournal("be", day);
  assert.match(j, /\[T1\] Đã thêm endpoint orders \(sửa: src\/orders\.ts\)/);
  assert.ok(existsSync(deps.memory.soulFile("be")));
});

test("room: consolidating memory runs a dedicated turn in a fresh session", async () => {
  const fake = new Fake(() => "đã xoá 2, thêm 1");
  const { room } = makeRoom(fake);
  room.post("user", "@be chào");
  await idle(room);
  room.consolidateMemory("be");
  await idle(room);
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1].sessionId, undefined);
  assert.match(fake.calls[1].prompt, /KHÔNG xoá mục kind=decision/);
});
