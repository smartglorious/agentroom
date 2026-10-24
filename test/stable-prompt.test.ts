import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/core/config";
import { Room } from "../src/core/room";
import { Fake, idle, makeRoom } from "./helpers";

const CFG = (extra = "") => `accounts: { c: { provider: claude, maxConcurrent: 3 } }
workers:
  - { id: lead, name: Lan, role: Lead, account: c, coordinator: true }
  - { id: be, name: Minh, role: Backend, account: c${extra} }
`;
const turnTo = async (room: Room, text: string) => { room.post("user", text); await idle(room); await new Promise((r) => setTimeout(r, 20)); };
const beCalls = (fake: Fake) => fake.calls.filter((c) => c.worker.id === "be");

test("stable prompt: the system prompt is byte-identical on every turn, whatever happens to memory, teammates or the journal", async () => {
  const fake = new Fake(() => "xong");
  const { room } = makeRoom(fake, { config: parseConfig(CFG()) });
  await turnTo(room, "@be một");
  room.memory.add("team", "lead", "decision", "Dùng pnpm, không dùng npm");
  room.memory.add("me", "be", "lesson", "Test cần DB chạy sẵn");
  room.memory.journal("be", "đã làm gì đó khác", {});
  await turnTo(room, "@be hai");
  await turnTo(room, "@be ba");
  const apps = beCalls(fake).map((c) => c.systemAppend);
  assert.equal(apps.length, 3);
  assert.ok(apps.every((a) => a === apps[0]), "system prompt never changes across turns");
  assert.ok(!/pnpm|Test cần DB|@lead — Lan/.test(apps[0]), "no memory, SOUL, journal or roster in it");
  assert.match(apps[0], /Bạn là Minh \(@be\)/);
});

test("stable prompt: the first turn carries teammates, SOUL, memory and journal; a resumed turn carries nothing it already has", async () => {
  const fake = new Fake(() => "xong");
  const { room } = makeRoom(fake, { config: parseConfig(CFG()) });
  room.memory.add("me", "be", "fact", "Cổng dev là 3001");
  room.memory.journal("be", "việc hôm qua", {});
  await turnTo(room, "@be một");
  await turnTo(room, "@be hai");
  const [first, second] = beCalls(fake);
  assert.match(first.prompt, /<your_context>/);
  assert.match(first.prompt, /@lead — Lan/);
  assert.match(first.prompt, /Cổng dev là 3001/);
  assert.match(first.prompt, /Nhật ký gần đây/);
  assert.equal(second.sessionId, "s-be", "the session is resumed");
  assert.ok(!/<your_context/.test(second.prompt), "unchanged memory is not sent again");
  assert.ok(!/Cổng dev là 3001|@lead — Lan/.test(second.prompt));
});

test("stable prompt: changed memory is sent once as an update, without the journal, and replaces the old copy", async () => {
  const fake = new Fake(() => "xong");
  const { room } = makeRoom(fake, { config: parseConfig(CFG()) });
  await turnTo(room, "@be một");
  room.memory.add("team", "lead", "decision", "Đổi sang Postgres 16");
  room.memory.journal("be", "dòng nhật ký mới", {});
  await turnTo(room, "@be hai");
  await turnTo(room, "@be ba");
  const [, second, third] = beCalls(fake);
  assert.match(second.prompt, /<your_context update="replaces any earlier version">/);
  assert.match(second.prompt, /Đổi sang Postgres 16/);
  assert.doesNotMatch(second.prompt, /Nhật ký gần đây/, "journal lines change every turn and are only sent with a new session");
  assert.ok(!/<your_context/.test(third.prompt), "…and only once");
});

test("stable prompt: a teammate joining reaches workers that already have a session", async () => {
  const fake = new Fake(() => "xong");
  const a = makeRoom(fake, { config: parseConfig(CFG()) });
  await turnTo(a.room, "@be một");
  const next = parseConfig(CFG() + `  - { id: qa, name: Hà, role: QA, account: c }\n`);
  const room2 = new Room({ ...a.deps, config: next });
  await turnTo(room2, "@be hai");
  const second = beCalls(fake)[1];
  assert.equal(second.sessionId, "s-be", "same session");
  assert.match(second.prompt, /update=/);
  assert.match(second.prompt, /@qa — Hà, QA/);
});

test("stable prompt: when the stable part changes (new instructions) the session restarts instead of running on a stale prompt", async () => {
  const fake = new Fake(() => "xong");
  const a = makeRoom(fake, { config: parseConfig(CFG()) });
  await turnTo(a.room, "@be một");
  await turnTo(a.room, "@be hai");
  assert.equal(beCalls(fake)[1].sessionId, "s-be");
  const room2 = new Room({ ...a.deps, config: parseConfig(CFG(", instructions: Luôn viết test trước")) });
  await turnTo(room2, "@be ba");
  const third = beCalls(fake)[2];
  assert.equal(third.sessionId, undefined, "fresh session");
  assert.match(third.systemAppend, /Luôn viết test trước/);
  assert.match(third.prompt, /<your_context>/, "and it gets its memory again");
  await turnTo(room2, "@be bốn");
  assert.equal(beCalls(fake)[3].sessionId, "s-be", "then it resumes normally");
});

test("stable prompt: a session from before this change resumes and is sent its memory once", async () => {
  const fake = new Fake(() => "xong");
  const a = makeRoom(fake, { config: parseConfig(CFG()) });
  await turnTo(a.room, "@be một");
  a.deps.store.saveSessionMeta({});                         // what an older version left behind: sessions without meta
  const room2 = new Room({ ...a.deps });
  await turnTo(room2, "@be hai");
  await turnTo(room2, "@be ba");
  const [, second, third] = beCalls(fake);
  assert.equal(second.sessionId, "s-be");
  assert.match(second.prompt, /<your_context/);
  assert.ok(!/<your_context/.test(third.prompt));
});

test("stable prompt: a failed turn does not mark the memory as delivered", async () => {
  let fail = true;
  const fake = new Fake((req) => { if (req.worker.id === "be" && fail) { fail = false; throw new Error("boom"); } return "xong"; });
  const { room } = makeRoom(fake, { config: parseConfig(CFG()) });
  await turnTo(room, "@be một");
  await turnTo(room, "@be hai");
  const calls = beCalls(fake);
  assert.ok(calls.length >= 2);
  assert.match(calls[calls.length - 1].prompt, /<your_context/, "the next attempt still carries it");
});
