// One goal given to the three-worker room (REAL Claude, haiku): did the work get done, and how much human help and quota did it take?
// BENCH_GOAL=auth|cart  BENCH_MODE=legacy|durable  BENCH_OUT=<dir>.  Output: one `RESULT {json}` line.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
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
import { FIXTURES } from "./goal-fixtures";

const fixture = FIXTURES[process.env.BENCH_GOAL ?? "auth"];
if (!fixture) throw new Error("BENCH_GOAL must be one of " + Object.keys(FIXTURES).join(", "));
const mode = process.env.BENCH_MODE === "durable" ? "durable" : "legacy";
const deadlineMs = Number(process.env.BENCH_DEADLINE_MIN ?? "10") * 60_000;

const ws = mkdtempSync(join(tmpdir(), "goal-ws-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
for (const [name, text] of Object.entries(fixture.files)) { mkdirSync(dirname(join(ws, name)), { recursive: true }); writeFileSync(join(ws, name), text); }
if (!fixture.zones) writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }));
for (const [k, v] of [["user.email", "bench@example.com"], ["user.name", "bench"]]) execFileSync("git", ["config", k, v], { cwd: ws });
execFileSync("git", ["add", "-A"], { cwd: ws }); execFileSync("git", ["commit", "-qm", "initial"], { cwd: ws });
const root = join(ws, ".agentroom"), state = join(root, "state");
mkdirSync(state, { recursive: true });

const THREE = `accounts: { c: { provider: claude, maxConcurrent: 3 } }
workers:
  - { id: lead, name: Lan, role: Tech Lead, account: c, model: haiku, coordinator: true, allowedTools: [Read, Grep, Glob] }
  - { id: be, name: Minh, role: Backend Developer, account: c, model: haiku, allowedTools: [Read, Grep, Glob, Write, Edit, Bash] }
  - { id: qa, name: Hà, role: QA, account: c, model: haiku, allowedTools: [Read, Grep, Glob, Bash] }
`;
const FOUR = `accounts: { c: { provider: claude, maxConcurrent: 4 } }
workers:
  - { id: lead, name: Lan, role: Tech Lead, account: c, model: haiku, coordinator: true, allowedTools: [Read, Grep, Glob] }
  - { id: fe, name: Phong, role: Frontend Developer, account: c, model: haiku, allowedTools: [Read, Grep, Glob, Write, Edit, Bash] }
  - { id: be, name: Minh, role: Backend Developer, account: c, model: haiku, allowedTools: [Read, Grep, Glob, Write, Edit, Bash] }
  - { id: qa, name: Hà, role: QA, account: c, model: haiku, allowedTools: [Read, Grep, Glob, Bash] }
`;
// BENCH_WORKERS_FILE: a real workers.yaml kept outside the repo (adapted to Claude only); the zone fixtures need it.
if (fixture.zones && !process.env.BENCH_WORKERS_FILE) throw new Error("this fixture needs BENCH_WORKERS_FILE=<workers.yaml>");
const config = parseConfig(process.env.BENCH_WORKERS_FILE ? readFileSync(process.env.BENCH_WORKERS_FILE, "utf8") : fixture.team ? FOUR : THREE);
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
  options: { maxAgentHops: 12, contextMessages: 30, memoryBudgetChars: 12000, agentDebounceMs: 1500 }, memory: new MemoryStore(root),
  skills: new SkillRegistry(skillSources(ws, join(ws, "nohome"))), skillDrafts: new SkillDrafts(join(root, "skills")),
  pluginDir: join(root, ".plugin"), usage, inspector: new TurnInspector(state, 50), resolveCwd: async () => ws,
  mcpUrl: (id) => holder.mcp!.urlFor(id), home: join(ws, "nohome"), ...(turnQueue ? { turnQueue } : {}),
});
holder.mcp = new AgentRoomMcp(room);
await holder.mcp.start();

// A person would click through ordinary work inside the project; anything else is refused and counted as needing a person.
const inside = (p: unknown) => typeof p === "string" && (resolve(ws, p) + sep).startsWith(resolve(ws) + sep);
// A shell line is fine when every part is a plain read-only or test command that stays inside the project (no redirects other than 2>&1, no substitution).
const SAFE_PART = /^(node --test( [\w./-]+)*|npm (ci|test|run build)|npx jest( [\w./=-]+)*|cd [\w./-]+|git (status|diff|log|add|branch)( [\w./=-]+)*|git (checkout|switch)( -[qbBcC])*( [\w./=-]+)+|git commit -m ["\x27][^"\x27]*["\x27]|node --version|node [\w./-]+|tail( -n?\s?\d+)?|head( -n?\s?\d+)?|cat [\w./-]+|ls( -[la]+)?( [\w./-]+)?|pwd|echo [\w .-]*)( 2>&1)?$/;
const safeBash = (c: unknown) => typeof c === "string" && !/[`$()<>]/.test(c.replace(/2>&1/g, "")) && c.split(/&&|\|\||;|\|/).every((part) => SAFE_PART.test(part.trim().replace(new RegExp(resolve(ws).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), ".")));
let roleDenied = 0, approvalsTotal = 0, approvalsAllowed = 0, approvalsDenied = 0, questions = 0;
const denied: string[] = [];
room.on("approval", (req) => {
  approvalsTotal++;
  const input = (req.input ?? {}) as Record<string, unknown>;
  const target = String(input.file_path ?? input.path ?? "");
  const rel = inside(target) ? resolve(ws, target).slice(resolve(ws).length + 1).split(sep).join("/") : "";
  // In the team run every role writes only its own area; a write elsewhere is refused and counted as a role violation.
  const ZONES: Record<string, string[]> = { be: ["rules-service/", "integration-connectors/"], fe: ["play-frontend/", "frontend-dashboard/", "games/"], docs: ["docs/", "WORKING.md", "SNAPSHOT.md", "README.md"] };
  const roleOk = fixture.solo ? true : fixture.zones ? (ZONES[req.workerId] ?? []).some((z) => rel === z || rel.startsWith(z)) : !fixture.team ? true : req.workerId === "lead" ? false : req.workerId === "fe" ? rel.startsWith("web/") && !rel.endsWith(".test.js")
    : req.workerId === "be" ? !!rel && !rel.startsWith("web/") && !rel.endsWith(".test.js") : req.workerId === "qa" ? rel.endsWith(".test.js") : false;
  const write = ["Write", "Edit"].includes(req.tool);
  const ok = ["Read", "Grep", "Glob"].includes(req.tool) ? true
    : write ? inside(target) && roleOk
    : req.tool === "Bash" ? safeBash(input.command) : false;
  if (write && inside(target) && !roleOk) { roleDenied++; denied.push(`${req.workerId} wrote ${rel}`); }
  if (ok) approvalsAllowed++; else { approvalsDenied++; if (!(write && inside(target) && !roleOk)) denied.push(`${req.tool}:${JSON.stringify(input).slice(0, 80)}`); }
  room.respondApproval(req.id, ok);
});
room.on("message", (m) => {
  if (m.options) { questions++; setTimeout(() => { try { room.answerOption(m.id, m.options!.items[0].id, "bench"); } catch { /* already answered */ } }, 500); }
});

const startedAt = Date.now();
room.post("user", `@${process.env.BENCH_TARGET ?? "lead"} ${fixture.goal}`);
await new Promise<void>((res) => {
  const tick = () => {
    const quiet = room.snapshot().statuses.every((s) => s.state === "idle" || s.state === "error");
    if (quiet || Date.now() - startedAt > deadlineMs) return res();
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 4000);
});
const timedOut = Date.now() - startedAt > deadlineMs;
const wallS = (Date.now() - startedAt) / 1000;

// The checker: the workers' own tests must pass, then the hidden tests decide whether the real problems are solved.
const appDirs = fixture.zones ? ["rules-service", "play-frontend"] : ["."];
const runTests = (cwd = ".") => {
  const r = spawnSync("node", ["--test"], { cwd: join(ws, cwd), encoding: "utf8", timeout: 60_000 });
  return { pass: Number(/# pass (\d+)/.exec(r.stdout ?? "")?.[1] ?? 0), fail: Number(/# fail (\d+)/.exec(r.stdout ?? "")?.[1] ?? 0) };
};
const own = appDirs.map((d) => runTests(d)).reduce((a, b) => ({ pass: a.pass + b.pass, fail: a.fail + b.fail }), { pass: 0, fail: 0 });
for (const [name, text] of Object.entries(fixture.hidden)) { mkdirSync(dirname(join(ws, name)), { recursive: true }); writeFileSync(join(ws, name), text); }
const hiddenRuns = Object.keys(fixture.hidden).map((f) => spawnSync("node", ["--test", f.split("/").pop()!], { cwd: join(ws, f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "."), encoding: "utf8", timeout: 60_000 }));
const hidden = { stdout: hiddenRuns.map((r) => r.stdout ?? "").join("\n") };
const hiddenPass = hiddenRuns.reduce((n, r) => n + Number(/# pass (\d+)/.exec(r.stdout ?? "")?.[1] ?? 0), 0);
const hiddenFailed = [...(hidden.stdout ?? "").matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].slice(0, 100));

const summary = usage.summarize("today");
const t = summary.totals;
const byWorker = Object.fromEntries(summary.byWorker.map((w) => [w.key, { turns: w.turns, tokens: w.tokens }]));
const result = {
  goal: fixture.id, mode, timedOut, wallS: +wallS.toFixed(1),
  turns: t.turns, errors: t.errors, cacheWrite: t.cacheWrite, cacheRead: t.cacheRead, output: t.output, costUsd: +t.costUsd.toFixed(4),
  ownTestsPass: own.pass, ownTestsFail: own.fail, hiddenPass, hiddenTotal: fixture.hiddenTests, hiddenFailed, solved: hiddenPass === fixture.hiddenTests && own.fail === 0,
  approvalsTotal, approvalsAllowed, approvalsDenied, roleDenied, questions, byWorker, interventions: approvalsDenied + questions, denied,
  workerMessages: room.snapshot().messages.filter((m) => m.from !== "system" && m.from !== "user").length,
};
console.log(`RESULT ${JSON.stringify(result)}`);
if (process.env.BENCH_OUT) { mkdirSync(process.env.BENCH_OUT, { recursive: true }); copyFileSync(join(state, "usage.jsonl"), join(process.env.BENCH_OUT, "usage.jsonl")); }
process.exit(0);
