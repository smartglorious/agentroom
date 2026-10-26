// Token benchmark: the same three-worker scenario with REAL Claude (haiku), numbers read from usage.jsonl.
// Compare runs before/after a change. LLM output varies, so the stable figures are the per-turn ones.
//   npm run bench:tokens            (costs a few cents)
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
import { SqliteMigrationRunner } from "../../src/storage/migrations";
import { schemaMigrations } from "../../src/storage/schema-v1";
import { SqliteConnection } from "../../src/storage/sqlite";
import { DurableTurnQueue } from "../../src/storage/turn-queue";

const ws = mkdtempSync(join(tmpdir(), "bench-ws-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
writeFileSync(join(ws, "notes.md"), "# notes\nProject uses plain JavaScript.\n");
const root = join(ws, ".agentroom"), state = join(root, "state");
mkdirSync(state, { recursive: true });

const config = parseConfig(`accounts: { c: { provider: claude, maxConcurrent: 3 } }
workers:
  - { id: lead, name: Lan, role: Tech Lead, account: c, model: haiku, coordinator: true, allowedTools: [Read, Grep, Glob] }
  - { id: be, name: Minh, role: Backend Developer, account: c, model: haiku, allowedTools: [Read, Grep, Glob, Write, Edit] }
  - { id: qa, name: Hà, role: QA, account: c, model: haiku, allowedTools: [Read, Grep, Glob] }
`);
// BENCH_MODE=durable runs the same scenario through the SQLite Run/Step queue; BENCH_OUT=<dir> keeps this run's usage.jsonl for scripts/bench-ab.mjs.
const mode = process.env.BENCH_MODE === "durable" ? "durable" : "legacy";
let turnQueue: DurableTurnQueue | undefined;
if (mode === "durable") {
  const db = await SqliteConnection.open(join(state, "agentroom.db"));
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.run("INSERT OR IGNORE INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'Workspace', 'file:///w1', 1, 1)");
  turnQueue = new DurableTurnQueue(db, "w1");
}
const holder: { mcp?: AgentRoomMcp } = {};
const usage = new UsageStore(state);
const room = new Room({
  config, store: new RoomStore(state), adapters: { claude: new ClaudeAdapter(), codex: new CodexAdapter() }, scheduler: new Scheduler(),
  options: { maxAgentHops: 4, contextMessages: 30, memoryBudgetChars: 12000, agentDebounceMs: 1500 }, memory: new MemoryStore(root),
  skills: new SkillRegistry(skillSources(ws, join(ws, "nohome"))), skillDrafts: new SkillDrafts(join(root, "skills")),
  pluginDir: join(root, ".plugin"), usage, inspector: new TurnInspector(state, 50), resolveCwd: async () => ws,
  mcpUrl: (id) => holder.mcp!.urlFor(id), home: join(ws, "nohome"), ...(turnQueue ? { turnQueue } : {}),
});
holder.mcp = new AgentRoomMcp(room);
await holder.mcp.start();

// Nobody is here to approve anything: refuse every card so a worker that tries an unlisted tool (say Bash) cannot stall the run.
if (process.env.BENCH_DEBUG) {
  const t0 = Date.now();
  const log = (m: string) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  room.on("status", (st) => log(`status ${st.id}=${st.state}${st.activity ? " " + st.activity.slice(0, 50) : ""}`));
  room.on("message", (m) => log(`msg ${m.from} -> ${(m.to ?? []).join(",")}: ${m.text.slice(0, 60).replace(/\n/g, " ")}`));
}
let refused = 0;
room.on("approval", (req) => { refused++; room.respondApproval(req.id, false); });
const idle = () => new Promise<void>((res) => { const c = () => (room.snapshot().statuses.every((s) => s.state === "idle" || s.state === "error") ? res() : setTimeout(c, 500)); setTimeout(c, 2500); });
const say = async (text: string) => { room.post("user", text); await idle(); };

const startedAt = Date.now();
await say("@lead Hãy giao @be tạo file add.js xuất hàm add(a, b), rồi nhờ @qa đọc file đó xác nhận. Mỗi người trả lời ngắn gọn.");
await say("@lead Cảm ơn. Nhờ @qa nhắc lại kết quả kiểm tra bằng một câu.");
await say("@be Thêm hàm sub(a, b) vào add.js rồi báo ngắn.");

const t = usage.summarize("today");
const tot = t.totals;
const all = tot.input + tot.cacheRead + tot.cacheWrite;
const out = (k: string, v: string | number) => console.log(`BENCH ${k.padEnd(34)} ${v}`);
out("mode", mode);
out("wall seconds", ((Date.now() - startedAt) / 1000).toFixed(1));
out("turns", tot.turns);
out("errors", tot.errors);
out("input tokens, all turns", all);
out("  of which cache write", tot.cacheWrite);
out("  of which cache read", tot.cacheRead);
out("  uncached", tot.input);
out("output tokens", tot.output);
out("input tokens per turn (avg)", Math.round(all / Math.max(1, tot.turns)));
out("cache write per turn (avg)", Math.round(tot.cacheWrite / Math.max(1, tot.turns)));
out("cost USD (CLI estimate)", tot.costUsd.toFixed(4));
for (const w of t.byWorker) out(`  ${w.key}: turns / tokens / cost`, `${w.turns} / ${w.tokens} / ${w.costUsd.toFixed(4)}`);
const msgs = room.snapshot().messages.filter((m) => m.from !== "system" && m.from !== "user");
out("worker messages", msgs.length);
out("approval cards refused", refused);
out("replies suppressed noop/repeat", `${room.suppressed.noop}/${room.suppressed.repeat}`);
out("final file exists with sub()", /sub/.test(execFileSync("cat", [join(ws, "add.js")], { encoding: "utf8" }).toString()) ? "yes" : "NO");
if (process.env.BENCH_OUT) { mkdirSync(process.env.BENCH_OUT, { recursive: true }); copyFileSync(join(state, "usage.jsonl"), join(process.env.BENCH_OUT, "usage.jsonl")); }
process.exit(0);
