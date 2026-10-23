// Multi-machine end-to-end over REAL ssh (sshd on 127.0.0.1:2222, TCP forwarding disabled) with the REAL runner
// bundle and the REAL Claude CLI on the "remote" side. Set up by `scripts/live/ssh-sandbox.sh up`; run via
// `npm run test:ssh`. Build first (`npm run build`) so dist/runner.mjs exists.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteAdapter } from "../../src/adapters/remote";
import { ClaudeAdapter } from "../../src/adapters/claude";
import { CodexAdapter } from "../../src/adapters/codex";
import { parseConfig } from "../../src/core/config";
import { TurnInspector } from "../../src/core/inspector";
import { MemoryStore } from "../../src/core/memory";
import { Room } from "../../src/core/room";
import { Scheduler } from "../../src/core/scheduler";
import { SkillDrafts, SkillRegistry, skillSources } from "../../src/core/skills";
import { RoomStore } from "../../src/core/store";
import { UsageStore } from "../../src/core/usage";
import { HostDef } from "../../src/core/types";
import { HostManager, ProcessLike, runnerHash, sshSpawner } from "../../src/remote/host";
import { AgentRoomMcp } from "../../src/mcp/server";

const KEY = "/tmp/agentroom-ssh/id_ed25519";
// The "remote" shares this user's home, so forget a runner installed by an earlier run: the first connect must upload.
const installedRunner = (r: Buffer) => join(process.env.HOME ?? "/root", ".agentroom", "runner", `${runnerHash(r)}.mjs`);
const runner = readFileSync("dist/runner.mjs");
rmSync(installedRunner(runner), { force: true });
const results: string[] = [];
const check = (name: string, ok: boolean, extra = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); };
const sh = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const remoteRepo = mkdtempSync(join(tmpdir(), "remote-clone-"));
sh("git", ["init", "-q", "-b", "main"], remoteRepo);
sh("git", ["config", "user.email", "t@t"], remoteRepo); sh("git", ["config", "user.name", "t"], remoteRepo);
writeFileSync(join(remoteRepo, "README.md"), "remote clone\n");
sh("git", ["add", "."], remoteRepo); sh("git", ["commit", "-qm", "init"], remoteRepo);

const ws = mkdtempSync(join(tmpdir(), "hub-ws-"));
sh("git", ["init", "-q", "-b", "main"], ws);
const root = join(ws, ".agentroom"), state = join(root, "state");
mkdirSync(state, { recursive: true });

const base: HostDef = { name: "box", ssh: "root@127.0.0.1", port: 2222, identityFile: KEY, repo: remoteRepo, connectTimeoutSec: 10 };
const ssh = (over: Partial<HostDef>): HostDef => ({ ...base, ...over });

// ---- A. host key not trusted yet: must fail with advice, not hang or prompt ----
{
  const m = new HostManager([base], { runner });
  const st = (await m.check())[0];
  check("A. untrusted host key → clear advice", st.state === "error" && /Chưa xác nhận host key/.test(st.error ?? "") && /ssh root@127\.0\.0\.1/.test(st.error ?? ""), st.error);
  m.closeAll();
}
execFileSync("sh", ["scripts/live/ssh-sandbox.sh", "trust"]);

// ---- B. wrong node path → specific advice ----
{
  const m = new HostManager([ssh({ node: "/nonexistent/node" })], { runner });
  const st = (await m.check())[0];
  check("B. missing node → advice to set hosts.<name>.node", st.state === "error" && /Không tìm thấy node/.test(st.error ?? "") && /hosts\.box\.node/.test(st.error ?? ""), st.error);
  m.closeAll();
}

// ---- C. real connection, runner deployed once, remote facts reported ----
let uploads = 0;
const procs: ProcessLike[] = [];
const spec = ssh({ claudePath: "/opt/node22/bin/claude" });
const manager = new HostManager([spec], {
  runner,
  spawnerFor: (s) => ({ spawn: () => { const p = sshSpawner(s, runner)(); procs.push(p); return p; }, runner }),
  onRunnerUpload: () => { uploads++; },
});
const installed = installedRunner(runner);
{
  const st = (await manager.check())[0];
  check("C. ssh connect + runner deployed + facts", st.state === "ready" && /^22\./.test(st.node ?? "") && existsSync(installed) && uploads === 1, JSON.stringify({ state: st.state, node: st.node, host: st.hostname, claudeInPath: st.claude ?? null, uploads }));
  check("C. host has the exact runner bytes", existsSync(installed) && readFileSync(installed).equals(runner));
}

// ---- the room: local qa + lead, remote be ----
const config = parseConfig(`
hosts:
  box: { ssh: "root@127.0.0.1", port: 2222, identityFile: ${KEY}, repo: ${remoteRepo}, claudePath: /opt/node22/bin/claude }
accounts:
  local-c: { provider: claude, maxConcurrent: 2 }
  box-c: { provider: claude, host: box, maxConcurrent: 2 }
workers:
  - { id: lead, name: Lan, role: Tech Lead, account: local-c, coordinator: true, allowedTools: [Read, Grep, Glob] }
  - { id: qa, name: Tuan, role: QA, account: local-c, allowedTools: [Read, Grep, Glob] }
  - { id: be, name: Minh, role: Backend, account: box-c, worktree: true, allowedTools: [Read, Grep, Glob] }
`);
const holder: { mcp?: AgentRoomMcp } = {};
const usage = new UsageStore(state);
const room = new Room({
  config, store: new RoomStore(state), adapters: { claude: new ClaudeAdapter(), codex: new CodexAdapter() }, remote: new RemoteAdapter(manager),
  scheduler: new Scheduler(), options: { maxAgentHops: 4, contextMessages: 20, memoryBudgetChars: 12000 },
  memory: new MemoryStore(root), skills: new SkillRegistry(skillSources(ws, join(ws, "nohome"))), skillDrafts: new SkillDrafts(join(root, "skills")),
  pluginDir: join(root, ".plugin"), usage, inspector: new TurnInspector(state, 50),
  resolveCwd: async () => ws, mcpUrl: (id) => holder.mcp!.urlFor(id),
});
holder.mcp = new AgentRoomMcp(room);
await holder.mcp.start();
const idle = () => new Promise<void>((res) => { const c = () => (room.snapshot().statuses.every((s) => s.state === "idle" || s.state === "error") ? res() : setTimeout(c, 400)); setTimeout(c, 1500); });
const from = (id: string) => room.snapshot().messages.filter((m) => m.from === id);
const wtree = join(remoteRepo, ".agentroom", "worktrees", "be");

// ---- D. real Claude on the remote, MCP relayed through the ssh channel (forwarding is off) ----
room.post("user", "@be Gọi tool post_message của agentroom với text đúng là RELAY-OK (không @mention ai). Sau đó trả lời đúng một dòng: REMOTE-DONE-1.", { taskId: "R1" });
await idle();
const d1 = from("be");
console.log("D reply:", d1.map((m) => m.text.slice(0, 120)).join(" || "));
check("D. remote Claude answered", d1.some((m) => /REMOTE-DONE-1/.test(m.text)));
check("D. MCP tool call reached the hub through the channel (no port forwarding)", d1.some((m) => /RELAY-OK/.test(m.text) && m.turnId === undefined), `${d1.length} messages from be`);
check("D. worktree created on the remote side on branch agentroom/be", existsSync(wtree) && sh("git", ["branch", "--show-current"], wtree) === "agentroom/be");
check("D. cost and remote cwd recorded", usage.all().some((u) => u.worker === "be" && (u.costUsd ?? 0) > 0 && u.account === "box-c"));
const rec = new TurnInspector(state, 50).load(from("be").find((m) => m.turnId)?.turnId ?? "");
check("D. inspector shows the machine", !!rec && rec.cwd.startsWith("box:") && rec.sessionKey === "be:R1@box", rec?.cwd);

// ---- E. the host's session is resumed ----
room.post("user", "@be Từ khoá cuối cùng bạn viết ở câu trả lời trước là gì? Trả lời đúng một dòng.", { taskId: "R1" });
await idle();
const sessions = JSON.parse(readFileSync(join(state, "sessions.json"), "utf8"));
check("E. session stored per host and resumed on the remote", !!sessions["be:R1@box"] && /REMOTE-DONE-1/.test(from("be").at(-1)?.text ?? ""), from("be").at(-1)?.text.slice(0, 80));

// ---- F. approvals travel hub ↔ remote (Write is not in allowedTools) ----
let approvals = 0;
let answer = true;
room.on("approval", (a) => { approvals++; setTimeout(() => room.respondApproval(a.id, answer), 100); });
room.post("user", "@be Dùng tool Write tạo file note1.txt trong thư mục hiện tại với nội dung hello. Rồi trả lời WROTE-1 hoặc DENIED-1 tuỳ kết quả.", { taskId: "R2" });
await idle();
check("F. approval asked on the hub and granted → file written in the remote worktree", approvals >= 1 && existsSync(join(wtree, "note1.txt")), `approvals=${approvals}`);
answer = false;
const before = approvals;
room.post("user", "@be Dùng tool Write tạo file note2.txt với nội dung no. Rồi trả lời WROTE-2 hoặc DENIED-2 tuỳ kết quả.", { taskId: "R3" });
await idle();
check("F. approval denied → nothing written", approvals > before && !existsSync(join(wtree, "note2.txt")));

// ---- G. a local worker and a remote worker at the same time ----
answer = true;
const t0 = Date.now();
const done: Record<string, number> = {};
room.on("message", (m) => { if ((m.from === "qa" || m.from === "be") && m.taskId === "P1" && !done[m.from]) done[m.from] = Date.now() - t0; });
room.post("user", "@qa Trả lời đúng một dòng: LOCAL-OK.", { taskId: "P1" });
room.post("user", "@be Trả lời đúng một dòng: REMOTE-OK.", { taskId: "P1" });
await idle();
check("G. local and remote workers both answered in one go", /LOCAL-OK/.test(from("qa").at(-1)?.text ?? "") && /REMOTE-OK/.test(from("be").at(-1)?.text ?? ""), JSON.stringify(done));

// ---- H. ssh dies in the middle of a turn that is waiting for an approval ----
answer = true;
const pending = new Promise<void>((resolve) => { const h = () => { room.off("approval", h as never); resolve(); }; room.on("approval", h as never); });
// swallow the auto-answer registered above for this one request: take the card away before it is answered
const autoOff = (a: { id: string }) => { clearTimeout((autoOff as unknown as { t?: NodeJS.Timeout }).t); void a; };
void autoOff;
room.removeAllListeners("approval");
room.on("approval", () => undefined);                 // nobody answers
room.post("user", "@be Dùng tool Write tạo file hang.txt với nội dung x.", { taskId: "R4" });
await sleep(1000);
const waitStart = Date.now();
while (room.snapshot().approvals.length === 0 && Date.now() - waitStart < 90_000) await sleep(500);
check("H. approval is pending while the turn waits", room.snapshot().approvals.length === 1);
void pending;
procs.at(-1)!.kill();                                  // the network dies
await idle();
await sleep(500);
check("H. dropped link: card withdrawn, one clear error, worker not re-woken", room.snapshot().approvals.length === 0
  && room.snapshot().messages.filter((m) => m.from === "system" && /Mất kết nối/.test(m.text)).length === 1
  && !existsSync(join(wtree, "hang.txt")));
/** Processes that belong to the remote side: running the runner file, or sitting in the remote clone. Scans /proc, no shell involved. */
function remoteProcesses(): string[] {
  const out: string[] = [];
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d) && Number(d) !== process.pid)) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      let cwd = "";
      try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* not ours to read */ }
      if (cmd.includes(`.agentroom/runner/${runnerHash(runner)}`) || cwd.startsWith(remoteRepo)) out.push(`${pid}: ${cmd.slice(0, 90)} (cwd ${cwd})`);
    } catch { /* process exited meanwhile */ }
  }
  return out;
}
let stale: string[] = [];
for (let i = 0; i < 20; i++) { stale = remoteProcesses(); if (!stale.length) break; await sleep(500); }
check("H. no runner / claude process left running on the remote after the link dropped", stale.length === 0, stale.join(" | ") || "none");

// ---- I. next turn reconnects without re-uploading the runner ----
room.post("user", "@be Trả lời đúng một dòng: BACK-ONLINE.", { taskId: "R5" });
await idle();
check("I. reconnects after the drop; runner was not uploaded again", /BACK-ONLINE/.test(from("be").at(-1)?.text ?? "") && uploads === 1, `uploads=${uploads}`);

console.log(results.join("\n"));
console.log("total cost USD:", usage.all().reduce((a, x) => a + (x.costUsd ?? 0), 0).toFixed(4));
manager.closeAll();
holder.mcp.dispose();
process.exit(results.some((l) => l.startsWith("FAIL")) ? 1 : 0);
