import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/core/config";
import type { Room } from "../src/core/room";
import { Fake, idle, makeRoom } from "./helpers";

const CFG = `accounts: { c: { provider: claude, maxConcurrent: 2 } }
workers:
  - { id: lead, name: Lan, role: Lead, account: c, coordinator: true }
  - { id: be, name: Minh, role: Dev, account: c }
  - { id: qa, name: Hà, role: QA, account: c }
`;

test("assignment: a worker that gives a task to someone does not wake them a second time by @mentioning them in its answer", async () => {
  let room!: Room;
  const fake = new Fake((req) => {
    if (req.worker.id === "lead") { room.createTask("lead", { title: "Làm việc", assignee: "be" }); return "@be Nhận task nhé"; }
    return "[NOOP]";
  });
  const r = makeRoom(fake, { config: parseConfig(CFG) });
  room = r.room;
  room.post("user", "@lead nhờ be làm việc");
  await idle(room);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(fake.calls.filter((c) => c.worker.id === "be").length, 1, "be runs once (in the task session), not twice");
  const answer = room.snapshot().messages.find((m) => m.from === "lead" && /Nhận task/.test(m.text))!;
  assert.deepEqual(answer.to, [], "the answer is still posted, but wakes nobody");
});

test("assignment: somebody else mentioned in the same answer is still woken, and an unrelated @mention of the assignee in a later turn works", async () => {
  let room!: Room;
  let n = 0;
  const fake = new Fake((req) => {
    if (req.worker.id === "lead") {
      if (++n === 1) { room.createTask("lead", { title: "Làm việc", assignee: "be" }); return "@be nhận task. @qa chuẩn bị review"; }
      return "@be thêm một việc nữa";
    }
    return "[NOOP]";
  });
  const r = makeRoom(fake, { config: parseConfig(CFG) });
  room = r.room;
  room.post("user", "@lead bắt đầu");
  await idle(room);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(fake.calls.filter((c) => c.worker.id === "qa").length, 1, "qa was asked and runs");
  assert.equal(fake.calls.filter((c) => c.worker.id === "be").length, 1);
  room.post("user", "@lead tiếp");
  await idle(room);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(fake.calls.filter((c) => c.worker.id === "be").length, 2, "a new turn of the lead may wake be again");
});
