import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { plugins as bundled } from "agentroom:plugins";
import { AgentAdapter, ApprovalResult, TurnRequest, TurnResult } from "../src/adapters/types";
import type { Autonomy } from "../src/core/autonomy";
import { parseConfig } from "../src/core/config";
import { AgentRoomPlugin, Guard, PluginManager } from "../src/core/plugins";
import { idle, makeRoom } from "./helpers";

const CFG = `accounts: { c: { provider: claude, maxConcurrent: 3 } }
workers:
  - { id: be, name: Minh, role: Backend, account: c, coordinator: true }
ext:
  demo: { level: 3 }
`;

function rig(calls: [string, unknown][], guards: Guard[], mode?: Autonomy) {
  const log: ApprovalResult[] = [];
  const adapter: AgentAdapter = {
    async runTurn(req: TurnRequest): Promise<TurnResult> {
      for (const [tool, input] of calls) log.push(await req.approve(tool, input));
      return { text: "xong" };
    },
  };
  const manager = new PluginManager(guards.map((g, i) => ({ id: `g${i}`, activate: (h) => h.registerGuard(g) })));
  const r = makeRoom(adapter, { config: parseConfig(CFG), home: "/home/dev", plugins: manager, autonomyStore: mode ? { get: () => mode, set: () => {} } : undefined });
  manager.activate({ room: r.room, config: r.deps.config, root: r.dir, log: () => {} });
  return { ...r, log, manager };
}
const run = async (r: ReturnType<typeof rig>) => { r.room.post("user", "@be làm"); await new Promise((x) => setTimeout(x, 80)); };
const finish = async (r: ReturnType<typeof rig>) => { for (const a of r.room.snapshot().approvals) r.room.respondApproval(a.id, true); await idle(r.room); await new Promise((x) => setTimeout(x, 40)); };
const locked: Guard = (c) => (c.paths.some((p) => p.includes("/locked/")) ? { action: "ask", reason: "area of another team" } : undefined);
const audit = (r: ReturnType<typeof rig>) => { const f = join(r.dir, ".agentroom", "state", "audit.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []; };

test("guard: in Auto, a call the policy allows becomes a card when a guard says ask; other calls still run unasked", async () => {
  const r = rig([["Write", { file_path: "src/ok.ts", content: "x" }], ["Write", { file_path: "locked/x.ts", content: "x" }]], [locked], "auto");
  await run(r);
  const cards = r.room.snapshot().approvals;
  assert.equal(cards.length, 1, "only the guarded path asks");
  assert.match(cards[0].reason ?? "", /Plugin g0: area of another team/);
  assert.equal(r.log[0], true, "the unguarded write was auto-approved");
  await finish(r);
  assert.equal(r.log[1], true);
  assert.ok(audit(r).some((l) => l.outcome === "người dùng cho phép" && /another team/.test(l.reason)), "the human decision on the guarded call is audited");
});

test("guard: Full does not skip a guard's question either", async () => {
  const r = rig([["Write", { file_path: "locked/x.ts", content: "x" }]], [locked], "full");
  await run(r);
  assert.equal(r.room.snapshot().approvals.length, 1);
  await finish(r);
});

test("guard: deny blocks with a reason the model sees and a notice in the chat, even in Manual", async () => {
  const deny: Guard = () => ({ action: "deny", reason: "frozen by @lead" });
  const r = rig([["Write", { file_path: "src/a.ts", content: "x" }]], [deny]);
  await run(r);
  await idle(r.room);
  assert.equal(r.room.snapshot().approvals.length, 0, "no card: it is refused outright");
  const res = r.log[0] as { allow: boolean; reason: string };
  assert.equal(res.allow, false);
  assert.match(res.reason, /plugin g0.*frozen by @lead/);
  const sys = r.room.snapshot().messages.filter((m) => m.from === "system").map((m) => m.text).join("\n");
  assert.match(sys, /🧩 Plugin g0 đã chặn/);
  assert.ok(!/@lead/.test(sys), "system notices never carry an @ (rule 3)");
});

test("guard: it can only tighten — it cannot rescue a call the policy blocks, and 'ask' on a blocked call stays blocked", async () => {
  const askAll: Guard = () => ({ action: "ask", reason: "x" });
  const r = rig([["Bash", { command: "sudo rm -rf /" }]], [askAll], "auto");
  await run(r);
  await idle(r.room);
  assert.equal(r.room.snapshot().approvals.length, 0, "policy deny wins; no card is offered");
  assert.equal((r.log[0] as { allow: boolean }).allow, false);
});

test("guard: a guard that throws turns into a question, not a pass", async () => {
  const boom: Guard = () => { throw new Error("kaput"); };
  const r = rig([["Write", { file_path: "src/a.ts", content: "x" }]], [boom], "auto");
  await run(r);
  assert.match(r.room.snapshot().approvals[0].reason ?? "", /check failed \(kaput\)/);
  await finish(r);
});

test("PluginManager: deny beats ask; activation errors and bad ids do not stop the others; dispose runs cleanups in reverse", () => {
  const order: string[] = [];
  const logs: string[] = [];
  const mk = (id: string, fn: AgentRoomPlugin["activate"]): AgentRoomPlugin => ({ id, activate: fn });
  const m = new PluginManager([
    mk("one", (h) => { h.registerGuard(() => ({ action: "ask", reason: "a" })); return () => order.push("one"); }),
    mk("Bad Id", () => { order.push("never"); }),
    mk("broken", () => { throw new Error("nope"); }),
    mk("two", (h) => { h.registerGuard(() => ({ action: "deny", reason: "d" })); return () => order.push("two"); }),
    mk("one", () => { order.push("dup"); }),
  ]);
  m.activate({ room: undefined as never, config: undefined as never, root: "/x", log: (t) => logs.push(t) });
  assert.deepEqual(m.list(), ["one", "two"]);
  assert.equal(logs.length, 3, "bad id, failure and duplicate are each logged");
  const v = m.check({ workerId: "w", tool: "Write", input: {}, paths: [] });
  assert.deepEqual([v?.action, v?.by], ["deny", "two"]);
  m.dispose();
  assert.deepEqual(order, ["two", "one"]);
  assert.equal(m.check({ workerId: "w", tool: "Write", input: {}, paths: [] }), undefined, "no guards after dispose");
});

test("PluginManager: panels are namespaced, announce changes, and a broken panel is skipped", () => {
  const m = new PluginManager([{
    id: "demo",
    activate: (h) => {
      h.registerPanel({ id: "main", title: () => "Demo", sections: () => [{ title: "S", rows: [{ text: "row", tag: "t", level: "warn" }] }] });
      h.registerPanel({ id: "bad", title: () => { throw new Error("x"); }, sections: () => [] });
    },
  }]);
  let changes = 0;
  m.on("panels", () => changes++);
  m.activate({ room: undefined as never, config: undefined as never, root: "/x", log: () => {} });
  assert.equal(changes, 2);
  assert.deepEqual(m.panels(), [{ id: "demo-main", title: "Demo", sections: [{ title: "S", rows: [{ text: "row", tag: "t", level: "warn" }] }] }]);
});

test("config: `ext:` is passed through untouched, empty by default", () => {
  assert.deepEqual(parseConfig(CFG).ext, { demo: { level: 3 } });
  assert.deepEqual(parseConfig("accounts: { c: { provider: claude } }\nworkers:\n  - { id: a, name: A, role: r, account: c }\n").ext, {});
});

test("build: the bundled plugin list is available (empty in the public tree)", () => {
  assert.ok(Array.isArray(bundled));
  for (const p of bundled) assert.match(p.id, /^[a-z0-9-]{1,32}$/);
});
