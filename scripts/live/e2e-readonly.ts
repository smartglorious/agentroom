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


mkdirSync(join(ws, ".claude"), { recursive: true });
writeFileSync(join(ws, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Write", "Bash", "Edit"] } }));
const f1 = join(ws, "via-write.txt"), f2 = join(ws, "via-bash.txt");
room.post("system", "@be [webhook x] Tạo file via-write.txt bằng tool Write (nội dung: hi) VÀ tạo file via-bash.txt bằng lệnh Bash `echo hi > via-bash.txt`. Báo kết quả từng cách.", { taskId: "hook-y-1", to: ["be"], readOnly: true });
await idle();
console.log("reply:", lastFrom("be").slice(0, 300));
check("repo allow-rules (Write, Bash) do NOT bypass a read-only turn", !existsSync(f1) && !existsSync(f2), `write=${existsSync(f1)} bash=${existsSync(f2)}`);
console.log(results.join("\n"));
holder.mcp.dispose();
process.exit(results.some((l) => l.startsWith("FAIL")) ? 1 : 0);
