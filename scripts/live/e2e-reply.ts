// REAL Claude: a worker asks the user to choose with ask_user, the user picks (or replies with text), and the answer
// comes back to the SAME session of that worker.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
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

const ws = mkdtempSync(join(tmpdir(), "reply-ws-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
const root = join(ws, ".agentroom"), state = join(root, "state");
mkdirSync(state, { recursive: true });
const config = parseConfig(`accounts: { c: { provider: claude, maxConcurrent: 2 } }
workers:
  - { id: dev, name: Dev, role: Developer, account: c, model: haiku, coordinator: true, allowedTools: [Read, Grep, Glob] }
`);
const holder: { mcp?: AgentRoomMcp } = {};
const inspector = new TurnInspector(state, 30);
const room = new Room({
  config, store: new RoomStore(state), adapters: { claude: new ClaudeAdapter(), codex: new CodexAdapter() }, scheduler: new Scheduler(),
  options: { maxAgentHops: 2, contextMessages: 10, memoryBudgetChars: 4000 }, memory: new MemoryStore(root),
  skills: new SkillRegistry(skillSources(ws, join(ws, "nohome"))), skillDrafts: new SkillDrafts(join(root, "skills")),
  pluginDir: join(root, ".plugin"), usage: new UsageStore(state), inspector, resolveCwd: async () => ws,
  mcpUrl: (id) => holder.mcp!.urlFor(id), home: join(ws, "nohome"),
});
holder.mcp = new AgentRoomMcp(room);
await holder.mcp.start();
const idle = () => new Promise<void>((res) => { const c = () => (room.snapshot().statuses.every((s) => s.state === "idle" || s.state === "error") ? res() : setTimeout(c, 400)); setTimeout(c, 1500); });
const msgs = () => room.snapshot().messages;

// 1. the worker asks with options
room.post("user", "@dev Mình cần chọn ngôn ngữ cho script nhỏ. Hãy dùng tool ask_user để hỏi mình chọn giữa đúng 3 phương án: Python, Node, Bash. Sau khi gọi ask_user thì kết thúc lượt, đừng làm gì thêm.");
await idle();
const q = msgs().find((m) => m.from === "dev" && m.options);
check("1. the worker asked with ask_user (a message with options exists)", !!q, q ? q.options!.items.map((i) => i.label).join("/") : msgs().filter((m) => m.from === "dev").map((m) => m.text.slice(0, 60)).join(" | "));
if (!q) { console.log(results.join("\n")); process.exit(1); }
check("1b. it carries 3 options and woke nobody", q.options!.items.length === 3 && q.to.length === 0);
const asking = inspector.load(msgs().find((m) => m.from === "dev" && m.turnId)?.turnId ?? "");

// 2. the user picks an option; the worker continues in the same session
const pick = q.options!.items.find((i) => /node/i.test(i.label)) ?? q.options!.items[1];
room.answerOption(q.id, pick.id);
await idle();
const after = [...msgs()].reverse().find((m) => m.from === "dev" && !m.options);
check("2. the worker answered after the pick", !!after && after.ts > q.ts, after?.text.slice(0, 80).replace(/\n/g, " "));
const turn = after?.turnId ? inspector.load(after.turnId) : undefined;
check("2b. …in the SAME Claude session (resumed)", turn?.resumed === true, `resumed=${turn?.resumed}`);
check("2c. …and its prompt quoted the question and the pick", !!turn && /trả lời tin/.test(turn.prompt) && new RegExp(pick.label, "i").test(turn.prompt));
check("2d. …and the answer shows it knows the choice", !!after && new RegExp(pick.label.split(/\s+/)[0], "i").test(after.text), after?.text.slice(0, 80).replace(/\n/g, " "));
void asking;

// 3. a free-text reply to a specific worker message
const target = after!;
room.post("user", "Cảm ơn. Nhắc lại giúp mình: ban nãy mình đã chọn ngôn ngữ nào? Trả lời đúng một từ.", { replyTo: target.id });
await idle();
const last = [...msgs()].reverse().find((m) => m.from === "dev");
check("3. a reply (no @mention) reached the worker who wrote that message", !!last && last.ts > target.ts && /node/i.test(last.text), last?.text.slice(0, 60));

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
