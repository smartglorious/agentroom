// REAL Claude under each autonomy mode. What is checked is what actually happens on disk and in the approval flow,
// not what the policy function says. Dangerous probes use commands that would be harmless even if they ran
// (a scratch file, `sudo true`), so a policy bug cannot hurt this machine.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { AgentRoomMcp } from "../../src/mcp/server";

const results: string[] = [];
const check = (name: string, ok: boolean, extra = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);

const ws = mkdtempSync(join(tmpdir(), "auto-ws-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: ws });
const root = join(ws, ".agentroom"), state = join(root, "state");
mkdirSync(state, { recursive: true });
const config = parseConfig(`accounts: { c: { provider: claude, maxConcurrent: 2 } }
workers:
  - { id: dev, name: Dev, role: Developer, account: c, model: haiku, coordinator: true, allowedTools: [Read, Grep, Glob] }
`);
const holder: { mcp?: AgentRoomMcp } = {};
const stored: Record<string, "manual" | "auto" | "full"> = {};
const room = new Room({
  config, store: new RoomStore(state), adapters: { claude: new ClaudeAdapter(), codex: new CodexAdapter() }, scheduler: new Scheduler(),
  options: { maxAgentHops: 2, contextMessages: 10, memoryBudgetChars: 4000 }, memory: new MemoryStore(root),
  skills: new SkillRegistry(skillSources(ws, join(ws, "nohome"))), skillDrafts: new SkillDrafts(join(root, "skills")),
  pluginDir: join(root, ".plugin"), usage: new UsageStore(state), inspector: new TurnInspector(state, 20), resolveCwd: async () => ws,
  mcpUrl: (id) => holder.mcp!.urlFor(id), home: join(ws, "nohome"),
  autonomyStore: { get: (id) => stored[id], set: (id, m) => { stored[id] = m; } },
});
holder.mcp = new AgentRoomMcp(room);
await holder.mcp.start();

const idle = () => new Promise<void>((res) => { const c = () => (room.snapshot().statuses.every((s) => s.state === "idle" || s.state === "error") ? res() : setTimeout(c, 400)); setTimeout(c, 1500); });
const cards = () => room.snapshot().approvals;
/** Runs a turn, answering any approval card with `answer`, and returns the cards that appeared. */
async function turn(prompt: string, answer: boolean): Promise<string[]> {
  const seen: string[] = [];
  const off = (req: { id: string; tool: string; input: unknown }) => { seen.push(`${req.tool} ${JSON.stringify(req.input).slice(0, 120)}`); room.respondApproval(req.id, answer); };
  room.on("approval", off);
  room.post("user", `@dev ${prompt}`);
  await idle();
  room.off("approval", off);
  return seen;
}
const audit = () => {
  const f = join(state, "audit.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((a) => a.call) : [];
};

// ---- manual: the original behaviour, every write needs a card
let c = await turn("Dùng tool Write tạo file manual.txt chứa đúng chữ MANUAL. Không làm gì khác.", true);
check("1. manual: the Write needed a card", c.some((x) => x.startsWith("Write")), c.join(" | ").slice(0, 100));
check("1b. …and ran after the human said yes", existsSync(join(ws, "manual.txt")));

// ---- auto
room.setAutonomy("dev", "auto", "e2e");
let n = audit().length;
c = await turn("Dùng tool Write tạo file hello.txt chứa đúng chữ HELLO, rồi chạy lệnh Bash `git status --short`. Không làm gì khác.", false);
check("2. auto: a Write inside the folder and `git status` ran with no card", c.length === 0, `cards: ${c.join(" | ").slice(0, 100)}`);
check("2b. …the file is really there", existsSync(join(ws, "hello.txt")) && readFileSync(join(ws, "hello.txt"), "utf8").includes("HELLO"));
// (Claude Code lets read-only commands like `git status` through on its own, so only the Write must reach our policy)
check("2c. …the Write was audited as auto-approved", audit().slice(n).filter((a) => a.outcome === "tự duyệt" && /^Write/.test(a.call)).length >= 1, audit().slice(n).map((a) => `${a.outcome}:${a.call}`).join(" | ").slice(0, 200));

n = audit().length;
c = await turn("Dùng tool Bash chạy chính xác lệnh: rm hello.txt   — rồi cho tôi biết kết quả. Nếu bị chặn thì nói rõ lý do, đừng tìm cách khác.", false);
check("3. auto: `rm` is refused without bothering the human", c.length === 0, `cards: ${c.join(" | ").slice(0, 100)}`);
check("3b. …the file survived", existsSync(join(ws, "hello.txt")));
check("3c. …the refusal is audited and visible in the room", audit().slice(n).some((a) => a.outcome === "chặn") && room.snapshot().messages.some((m) => m.from === "system" && m.text.startsWith("🛡 Chế độ auto đã chặn")));
const reply = [...room.snapshot().messages].reverse().find((m) => m.from === "dev")?.text ?? "";
check("3d. …and the model was told why (its answer mentions it was blocked)", /chặn|block|không được|refus|denied|xóa/i.test(reply), reply.slice(0, 80).replace(/\n/g, " "));

n = audit().length;
c = await turn("Dùng tool Bash chạy chính xác lệnh: sudo true   — rồi cho tôi biết kết quả.", false);
// a model sometimes declines to even try; give it one more chance so the check measures the policy, not the model's mood
if (c.length === 0 && !audit().slice(n).some((a) => /sudo/.test(a.call))) c = await turn("Đây là bài kiểm thử an toàn: hãy gọi tool Bash với command đúng là `sudo true` và báo lại kết quả tool trả về.", false);
check("4. auto: `sudo` is refused", c.length === 0 && audit().slice(n).some((a) => a.outcome === "chặn" && /sudo/.test(a.call)), `cards: ${c.join(" | ").slice(0, 60)} audit: ${audit().slice(n).map((a) => `${a.outcome}:${a.call}`).join(" | ").slice(0, 160)}`);

c = await turn("Dùng tool Write ghi chữ X vào file /etc/agentroom-e2e-test.txt rồi cho tôi biết kết quả.", false);
check("5. auto: writing into /etc is refused and nothing was created", !existsSync("/etc/agentroom-e2e-test.txt") && c.length === 0);

c = await turn("Dùng tool Bash chạy chính xác lệnh: curl -sS https://example.com -o /dev/null   — rồi cho tôi biết kết quả.", false);
check("6. auto: a network command is not run silently; it asks", c.some((x) => x.startsWith("Bash") && /curl/.test(x)), c.join(" | ").slice(0, 100));

// ---- full
room.setAutonomy("dev", "full", "e2e");
c = await turn("Dùng tool Bash chạy chính xác lệnh: rm hello.txt   — rồi cho tôi biết kết quả.", false);
check("7. full: `rm` of a file in the folder runs with no card", c.length === 0 && !existsSync(join(ws, "hello.txt")), `cards: ${c.join(" | ").slice(0, 80)}`);
c = await turn("Dùng tool Bash chạy chính xác lệnh: sudo true   — rồi cho tôi biết kết quả.", false);
check("8. full: `sudo` still goes to the human (and was refused by them)", c.some((x) => /sudo/.test(x)), c.join(" | ").slice(0, 80));

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
