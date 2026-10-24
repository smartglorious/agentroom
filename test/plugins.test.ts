import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { plugins as bundled } from "agentroom:plugins";
import { AgentAdapter, ApprovalResult, TurnRequest, TurnResult } from "../src/adapters/types";
import type { Autonomy } from "../src/core/autonomy";
import { parseConfig } from "../src/core/config";
import { AgentRoomPlugin, Guard, PluginManager } from "../src/core/plugins";
import { Fake, idle, makeRoom } from "./helpers";

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

// ---- extension points II: chat commands, approved calls, branch names ----
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { ensureWorktree } from "../src/core/worktree";

const waitFor = async (f: () => boolean, ms = 1500) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 10)); };

test("chat command: a person's `/name args` goes to the plugin, never to a worker; the reply is a system notice without @", async () => {
  const fake = new Fake(() => "ok");
  const calls: string[] = [];
  const manager = new PluginManager([{ id: "demo", activate: (h) => { h.registerChatCommand({ name: "demo", help: "x", run: (a) => { calls.push(a); return `done for @lead: ${a}`; } }); } }]);
  const { room } = makeRoom(fake, { config: parseConfig(CFG), plugins: manager });
  manager.activate({ room, config: room.snapshot().workers as never, root: "/x", log: () => {} });
  const m = room.post("user", "/demo hello world");
  await waitFor(() => room.snapshot().messages.some((x) => x.from === "system"));
  await idle(room);
  assert.deepEqual(calls, ["hello world"]);
  assert.equal(fake.calls.length, 0, "no worker was woken");
  assert.deepEqual(m.to, []);
  const reply = room.snapshot().messages.find((x) => x.from === "system")!;
  assert.equal(reply.text, "done for (at)lead: hello world");
  assert.equal(reply.to.length, 0);
  // not registered → an ordinary message, routed as before
  room.post("user", "/nope something");
  await idle(room);
  assert.equal(fake.calls.length, 1);
});

test("chat command: errors become a notice, duplicates and bad names are refused, help lists them", async () => {
  const manager = new PluginManager([{
    id: "demo",
    activate: (h) => {
      h.registerChatCommand({ name: "boom", help: "explodes", run: () => { throw new Error("kaput"); } });
      assert.throws(() => h.registerChatCommand({ name: "boom", help: "", run: () => {} }));
      assert.throws(() => h.registerChatCommand({ name: "Bad Name", help: "", run: () => {} }));
    },
  }]);
  const { room } = makeRoom(new Fake(), { config: parseConfig(CFG), plugins: manager });
  manager.activate({ room, config: undefined as never, root: "/x", log: () => {} });
  room.post("user", "/boom");
  await waitFor(() => room.snapshot().messages.some((x) => x.from === "system"));
  assert.match(room.snapshot().messages.find((x) => x.from === "system")!.text, /\/boom lỗi: kaput/);
  assert.deepEqual(manager.commandHelp(), ["/boom — explodes"]);
});

test("onApproved: called once for a policy approval and for a human approval, with absolute paths; a throwing listener is harmless", async () => {
  const seen: string[] = [];
  const manager = new PluginManager([{ id: "demo", activate: (h) => { h.onApproved(() => { throw new Error("x"); }); h.onApproved((c) => { seen.push(`${c.by}:${c.tool}:${c.paths.join(",")}`); }); } }]);
  const adapter: AgentAdapter = { async runTurn(req: TurnRequest): Promise<TurnResult> { await req.approve("Write", { file_path: "src/a.ts", content: "x" }); await req.approve("Bash", { command: "curl -sS https://example.com -o /dev/null" }); return { text: "ok" }; } };
  const r = makeRoom(adapter, { config: parseConfig(CFG), home: "/home/dev", plugins: manager, autonomyStore: { get: () => "auto", set: () => {} } });
  manager.activate({ room: r.room, config: r.deps.config, root: r.dir, log: () => {} });
  r.room.post("user", "@be go");
  await new Promise((x) => setTimeout(x, 80));
  for (const a of r.room.snapshot().approvals) r.room.respondApproval(a.id, true);
  await idle(r.room);
  await new Promise((x) => setTimeout(x, 40));
  assert.equal(seen[0], `policy:Write:${join(r.dir, "src/a.ts")}`);
  assert.equal(seen.length, 2);
  assert.match(seen[1], /^user:Bash:/);
});

test("branch namer: used for a new worktree, validated, and ignored when it returns junk", async () => {
  const manager = new PluginManager([{ id: "demo", activate: (h) => { h.setBranchNamer((id) => (id === "be" ? "team/alpha/be" : id === "evil" ? "../x" : undefined)); } }]);
  manager.activate({ room: undefined as never, config: undefined as never, root: "/x", log: () => {} });
  assert.equal(manager.branchName("be"), "team/alpha/be");
  assert.equal(manager.branchName("evil"), undefined);
  assert.equal(manager.branchName("other"), undefined);
  const repo = mkdtempSync(join(tmpdir(), "ar-wt-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  g("init", "-q", "-b", "main"); g("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");
  const dir = await ensureWorktree(repo, { id: "be", worktree: true }, manager.branchName("be"));
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(), "team/alpha/be");
  const dir2 = await ensureWorktree(repo, { id: "qa", worktree: true });
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir2, encoding: "utf8" }).trim(), "agentroom/qa");
});

import { validateForm } from "../src/core/plugins";

const FORM = { submit: "Gửi", fields: [
  { name: "team", label: "Đội", type: "select" as const, required: true, options: [{ value: "a" }, { value: "b" }] },
  { name: "title", label: "Tiêu đề", type: "text" as const, required: true, max: 10 },
  { name: "body", label: "Nội dung", type: "textarea" as const },
  { name: "areas", label: "Vùng", type: "multiselect" as const, options: [{ value: "src/**" }, { value: "docs/**" }] },
] };

test("validateForm: cleans text, keeps newlines only in textarea, enforces options, required and length", () => {
  const ok = validateForm(FORM, { team: "a", title: " hi\u0000 ", body: "l1\r\nl2\u0007", areas: ["src/**"] });
  assert.deepEqual(ok, { values: { team: "a", title: "hi", body: "l1\nl2", areas: ["src/**"] } });
  assert.ok("error" in validateForm(FORM, { team: "zzz", title: "x" }), "select outside options");
  assert.ok("error" in validateForm(FORM, { team: "a", title: "" }), "required empty");
  assert.ok("error" in validateForm(FORM, { team: "a", title: "x".repeat(11) }), "too long");
  assert.ok("error" in validateForm(FORM, { team: "a", title: "x", areas: ["/etc/**"] }), "multiselect outside options");
  assert.ok("error" in validateForm(FORM, { team: "a", title: { evil: 1 } }), "non-string value");
  assert.deepEqual(validateForm(FORM, { team: "a", title: "x", areas: "docs/**" }), { values: { team: "a", title: "x", body: "", areas: ["docs/**"] } });
});

function panelRig() {
  const calls: [string, unknown][] = [];
  let boom = false;
  const m = new PluginManager([{ id: "demo", activate: (h) => h.registerPanel({
    id: "main", title: () => "Demo", badge: () => 120,
    sections: () => [
      { title: "Items", rows: [
        { text: "one", actions: [{ id: "drop", label: "Drop", args: { item: "1" }, confirm: true }] },
        { text: "two", actions: [{ id: "drop", label: "Drop", args: { item: "2" } }] },
      ], form: { id: "send", submit: "Gửi", fields: FORM.fields } },
    ],
    onAction: (a, v) => { if (boom) throw new Error("hỏng rồi"); calls.push([a, v]); return a === "drop" ? undefined : "đã gửi"; },
  }) }]);
  m.activate({ room: undefined as never, config: undefined as never, root: "/x", log: () => {} });
  return { m, calls, boom: () => { boom = true; } };
}

test("invokePanelAction: unknown panel/action refused; row args picked by echo and host-owned", async () => {
  const { m, calls } = panelRig();
  assert.equal((await m.invokePanelAction("demo-main", "nope", {})).ok, false);
  assert.equal((await m.invokePanelAction("other", "drop", {})).ok, false);
  const r = await m.invokePanelAction("demo-main", "drop", { __args: { item: "2" } });
  assert.deepEqual(r, { ok: true, message: "Xong." });
  assert.deepEqual(calls[0], ["drop", { item: "2" }]);
  // The UI cannot inject args the panel did not declare.
  await m.invokePanelAction("demo-main", "drop", { __args: { item: "1" }, item: "999", admin: "1" });
  assert.deepEqual(calls[1], ["drop", { item: "1" }]);
});

test("invokePanelAction: form values validated before the plugin runs; plugin errors become a failed result; badge capped", async () => {
  const { m, calls, boom } = panelRig();
  const bad = await m.invokePanelAction("demo-main", "send", { team: "evil", title: "x" });
  assert.equal(bad.ok, false);
  assert.equal(calls.length, 0, "plugin not called with invalid values");
  const good = await m.invokePanelAction("demo-main", "send", { team: "b", title: "t", body: "hello", areas: ["docs/**"] });
  assert.deepEqual(good, { ok: true, message: "đã gửi" });
  assert.deepEqual(calls[0], ["send", { team: "b", title: "t", body: "hello", areas: ["docs/**"] }]);
  boom();
  const failed = await m.invokePanelAction("demo-main", "send", { team: "b", title: "t" });
  assert.deepEqual(failed, { ok: false, message: "hỏng rồi" });
  assert.equal(m.panels()[0].badge, 99);
});
