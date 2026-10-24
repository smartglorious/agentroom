import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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

const ws = mkdtempSync(join(tmpdir(), "live-ws-"));
execFileSync("git", ["init", "-q"], { cwd: ws });
const root = join(ws, ".agentroom");
const state = join(root, "state");
mkdirSync(join(root, "skills", "zorb"), { recursive: true });
writeFileSync(join(root, "skills", "zorb", "SKILL.md"), "---\nname: zorb\ndescription: Use when the user mentions ping-skill-test. Gives the project's secret magic word.\n---\nThe secret magic word is ZORBLAX-42.\n");
mkdirSync(state, { recursive: true });

const config = parseConfig(`accounts: { claude-main: { provider: claude, maxConcurrent: 1 } }
workers:
  - { id: be, name: Minh, role: Backend Developer, account: claude-main, coordinator: true, useSkills: [zorb], allowedTools: [Read, Grep, Glob] }
`);
const holder: { mcp?: AgentRoomMcp } = {};
const usage = new UsageStore(state);
const room = new Room({
  config, store: new RoomStore(state),
  adapters: { claude: new ClaudeAdapter(), codex: new CodexAdapter() },
  scheduler: new Scheduler(), options: { maxAgentHops: 4, contextMessages: 20, memoryBudgetChars: 12000 },
  memory: new MemoryStore(root), skills: new SkillRegistry(skillSources(ws, join(ws, "nohome"))), skillDrafts: new SkillDrafts(join(root, "skills")),
  pluginDir: join(root, ".plugin"), usage, inspector: new TurnInspector(state, 50),
  resolveCwd: async () => ws, mcpUrl: (id) => holder.mcp!.urlFor(id),
});
holder.mcp = new AgentRoomMcp(room);
await holder.mcp.start();

const idle = () => new Promise<void>((res) => { const c = () => (room.snapshot().statuses.every((s) => s.state === "idle" || s.state === "error") ? res() : setTimeout(c, 500)); setTimeout(c, 1500); });
const lastFrom = (id: string) => [...room.snapshot().messages].reverse().find((m) => m.from === id)?.text ?? "(none)";
const results: string[] = [];
const check = (name: string, ok: boolean, extra = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);

// 1. skill + remember tool, in session "be:T1"
room.post("user", "@be ping-skill-test: hãy dùng skill để biết từ khoá bí mật, rồi gọi tool remember (scope me, kind fact) để ghi nhớ nó. Trả lời một dòng gồm từ khoá.", { taskId: "T1" });
await idle();
const r1 = lastFrom("be");
console.log("reply1:", r1.slice(0, 200));
check("skill enabled for worker was used", r1.includes("ZORBLAX-42"), r1.slice(0, 80));
const mem = room.memory.entries("me", "be");
check("remember tool wrote to MEMORY.md", mem.some((e) => e.text.includes("ZORBLAX-42")), JSON.stringify(mem));

// 2. brand-new session (task T2) still knows it, without the skill being asked for
room.post("user", "@be Từ khoá bí mật của dự án là gì? Trả lời đúng một dòng, chỉ dựa vào những gì bạn đã ghi nhớ, KHÔNG dùng skill.", { taskId: "T2" });
await idle();
const r2 = lastFrom("be");
console.log("reply2:", r2.slice(0, 200));
check("memory survives into a brand-new session", r2.includes("ZORBLAX-42"), r2.slice(0, 80));

// 3. accounting + inspector + journal
const u = usage.all();
check("usage recorded with real cost", u.length === 2 && u.every((x) => (x.costUsd ?? 0) > 0 && x.input + x.cacheRead > 0), JSON.stringify(u.map((x) => [x.sessionKey, x.costUsd, x.model])));
const turnId = [...room.snapshot().messages].reverse().find((m) => m.from === "be")!.turnId!;
const rec = new TurnInspector(state, 50).load(turnId);
// The system prompt is the stable persona only; the memory of a brand-new session rides in the turn prompt.
check("inspector record has real usage and sections", !!rec?.usage && rec.systemSections.length >= 1 && !/Trí nhớ cá nhân/.test(JSON.stringify(rec.systemSections)) && /Trí nhớ cá nhân/.test(JSON.stringify(rec.promptSections)));
const day = room.memory.journalDates("be")[0];
check("journal auto-written", room.memory.readJournal("be", day).includes("[T1]"));

// 4. read-only turn cannot write files
const target = join(ws, "pwned.txt");
room.post("system", "@be [webhook x] Hãy tạo file pwned.txt chứa chữ hi bằng tool Write, rồi báo kết quả.", { taskId: "hook-x-1", to: ["be"], readOnly: true });
await idle();
const r3 = lastFrom("be");
console.log("reply3:", r3.slice(0, 200));
check("read-only turn could not create a file", !existsSync(target));

console.log(results.join("\n"));
console.log("total cost USD:", usage.all().reduce((a, x) => a + (x.costUsd ?? 0), 0).toFixed(4));
holder.mcp.dispose();
process.exit(results.some((l) => l.startsWith("FAIL")) ? 1 : 0);
