import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/core/config";
import { IssueStore } from "../src/core/issues";
import { Fake, idle, makeRoom } from "./helpers";

const CFG = `accounts: { c: { provider: claude, maxConcurrent: 2 } }
workers:
  - { id: lead, name: Lan, role: Lead, account: c, coordinator: true }
  - { id: be, name: Minh, role: Backend, account: c }
limits: { chainTurns: 2 }
`;
const rig = (reply: ConstructorParameters<typeof Fake>[0]) => {
  const issues = new IssueStore(join(mkdtempSync(join(tmpdir(), "ar-iss-")), "issues.json"), { version: "9.9.9" });
  const { room } = makeRoom(new Fake(reply), { config: parseConfig(CFG), issues });
  return { room, issues };
};
const wait = (ms = 60) => new Promise<void>((r) => setTimeout(r, ms));

test("issues: a failing turn is recorded once per kind of failure, with the worker, and does not break the room", async () => {
  const { room, issues } = rig(() => { throw new Error("spawn claude ENOENT at /usr/bin/claude (pid 123)"); });
  room.post("user", "@be làm đi");
  await wait(); await idle(room);
  room.post("user", "@be làm lại");
  await wait(); await idle(room);
  const open = issues.list("open").filter((i) => i.kind === "error");
  assert.equal(open.length, 1, "same error → one issue");
  assert.equal(open[0].count, 2);
  assert.equal(open[0].worker, "be");
  assert.match(open[0].title, /ENOENT/);
});

test("issues: the chain limit is recorded as friction; the owner's own note is a user issue", async () => {
  let n = 0;
  const { room, issues } = rig((req) => `${req.worker.id === "lead" ? "@be" : "@lead"} bước ${++n}`);
  room.post("user", "@lead bắt đầu");
  await wait(150); await idle(room); await wait();
  assert.ok(issues.list().some((i) => i.kind === "friction" && i.source === "limit"));
  const it = room.reportIssue("Nút duyệt không hiện\nchi tiết thêm");
  assert.equal(it?.kind, "user");
  assert.equal(it?.title, "Nút duyệt không hiện");
  assert.equal(room.reportIssue("   "), undefined);
});

test("issues: a room without an issue store still works (reportIssue is a no-op)", async () => {
  const { room } = makeRoom(new Fake());
  assert.equal(room.reportIssue("x"), undefined);
  room.noteIssue({ kind: "error", source: "x", title: "y" });
});
