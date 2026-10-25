import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeUsage } from "../src/adapters/claude";
import { codexUsage } from "../src/adapters/codex";
import { TurnInspector, TurnRecord, estimateTokens, renderTurn } from "../src/core/inspector";
import { parseConfig } from "../src/core/config";
import { UsageRecord, UsageStore, nextMidnight } from "../src/core/usage";
import { Fake, idle, makeRoom } from "./helpers";

const rec = (o: Partial<UsageRecord> = {}): UsageRecord => ({
  ts: Date.now(), turnId: "t", worker: "be", account: "claude-main", provider: "claude", model: "m1", sessionKey: "be:main",
  input: 100, output: 50, cacheRead: 300, cacheWrite: 50, costUsd: 0.5, estimated: false, durationMs: 1, tools: { Edit: 2 }, error: null, ...o,
});

test("usage: Claude result is normalised using the CLI's own cost and the dominant model", () => {
  const u = claudeUsage({
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    total_cost_usd: 0.25, num_turns: 3,
    modelUsage: { "claude-haiku": { costUSD: 0.01 }, "claude-opus": { costUSD: 0.24 } },
  });
  assert.deepEqual(u, { model: "claude-opus", input: 10, output: 5, cacheRead: 100, cacheWrite: 20, costUsd: 0.25, estimated: false, numTurns: 3 });
});

test("usage: Codex cost is estimated from the price table and missing for unknown models", () => {
  const prices = { "gpt-x": { input: 2, cachedInput: 0.5, output: 8 } };
  const u = codexUsage({ input_tokens: 1_000_000, cached_input_tokens: 600_000, output_tokens: 100_000, cache_write_input_tokens: 0 }, "gpt-x", prices);
  assert.equal(u.input, 400_000);
  assert.equal(u.cacheRead, 600_000);
  assert.equal(u.estimated, true);
  assert.ok(Math.abs(u.costUsd! - (0.4 * 2 + 0.6 * 0.5 + 0.1 * 8)) < 1e-9);
  assert.equal(codexUsage({ input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 }, "unknown", prices).costUsd, undefined);
  assert.equal(codexUsage({ input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 }, undefined, prices).costUsd, undefined);
});

test("usage: summaries group by worker/account/model/task and respect the range", () => {
  const now = new Date(2026, 9, 23, 15, 0).getTime();
  const store = new UsageStore(mkdtempSync(join(tmpdir(), "u-")), () => now);
  store.append(rec({ ts: now - 1000, worker: "be", taskId: "T1", costUsd: 1 }));
  store.append(rec({ ts: now - 2000, worker: "be", taskId: "T1", costUsd: 2, error: "x" }));
  store.append(rec({ ts: now - 3000, worker: "fe", account: "codex-main", provider: "codex", model: undefined, costUsd: undefined, estimated: true, tools: { Bash: 1 } }));
  store.append(rec({ ts: now - 3 * 86_400_000, worker: "qa", costUsd: 10 }));
  store.append(rec({ ts: now - 40 * 86_400_000, worker: "old", costUsd: 99 }));
  const today = store.summarize("today");
  assert.equal(today.totals.turns, 3);
  assert.equal(today.totals.costUsd, 3);
  assert.equal(today.totals.errors, 1);
  assert.equal(today.totals.unpriced, 1);
  assert.deepEqual(today.byWorker.map((r) => [r.key, r.costUsd]), [["be", 3], ["fe", 0]]);
  assert.deepEqual(today.byTask.map((r) => r.key), ["T1"]);
  assert.ok(today.byModel.some((r) => r.key === "(không rõ)"));
  assert.deepEqual(today.tools, { Edit: 4, Bash: 1 });
  assert.equal(today.totals.cacheHitRate, 900 / (300 + 900 + 150));
  assert.equal(store.summarize("7d").totals.turns, 4);
  assert.equal(store.summarize("30d").totals.costUsd, 13);
  assert.equal(store.costToday("claude-main"), 3);
  assert.equal(store.costToday("codex-main"), 0);
  assert.deepEqual(store.todayByWorker(), { be: 3, fe: 0 });
});

test("usage: records survive a restart and a corrupt line is skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "u-"));
  new UsageStore(dir).append(rec());
  require("node:fs").appendFileSync(join(dir, "usage.jsonl"), "{not json\n");
  assert.equal(new UsageStore(dir).all().length, 1);
});

test("usage: nextMidnight is local midnight", () => {
  const t = new Date(2026, 9, 23, 22, 30).getTime();
  assert.equal(new Date(nextMidnight(t)).getHours(), 0);
  assert.equal(new Date(nextMidnight(t)).getDate(), 24);
});

const turn = (id: string, over: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: id, ts: 1, worker: "be", account: "a", sessionKey: "be:main", resumed: false, cwd: "/w", readOnly: false, allowedTools: ["Read"], useSkills: [],
  systemSections: [{ name: "Trí nhớ cá nhân", chars: 400, tokens: 100 }], promptSections: [{ name: "Tin nhắn mới", chars: 40, tokens: 10 }],
  systemAppend: "SYS ````", prompt: "PROMPT", ...over,
});

test("inspector: keeps only the newest N turns, rejects path tricks, renders sections", () => {
  const dir = mkdtempSync(join(tmpdir(), "i-"));
  const insp = new TurnInspector(dir, 3);
  for (let i = 1; i <= 5; i++) insp.save(turn(`${1000 + i}-aaaaaa`));
  assert.deepEqual(readdirSync(join(dir, "turns")).sort(), ["1003-aaaaaa.json", "1004-aaaaaa.json", "1005-aaaaaa.json"]);
  assert.equal(insp.load("1001-aaaaaa"), undefined);
  assert.equal(insp.load("../../etc/passwd"), undefined);
  assert.equal(insp.load("1005-aaaaaa")!.worker, "be");
  const off = new TurnInspector(mkdtempSync(join(tmpdir(), "i-")), 0);
  off.save(turn("x-1"));
  assert.equal(off.load("x-1"), undefined);

  const md = renderTurn(turn("t-1", { usage: { input: 5000, output: 100, cacheRead: 95000, cacheWrite: 0, costUsd: 0.1234, estimated: false } }));
  assert.match(md, /System · Trí nhớ cá nhân \| 400 \| 100/);
  assert.match(md, /Tổng AgentRoom gửi\*\* \| \| \*\*110\*\*/);
  assert.match(md, /Token thực tế phía model: \*\*100,000\*\*/);
  assert.match(md, /≈ \*\*99,890\*\*/);
  assert.match(md, /\$0\.1234/);
  assert.doesNotMatch(md, /SYS ````/, "fence-breaking text is neutralised");
  assert.equal(estimateTokens("abcdefgh"), 2);
});

test("room: every turn is recorded — usage line, inspector file, turnId on the message, tool counts", async () => {
  const fake = new Fake((req) => {
    req.onActivity("Edit a.ts"); req.onActivity("Edit b.ts"); req.onActivity("Bash npm test");
    return { sessionId: "s1", text: "xong", usage: { model: "claude-opus", input: 10, output: 5, cacheRead: 90, cacheWrite: 0, costUsd: 0.2, estimated: false } };
  });
  const { room, deps } = makeRoom(fake);
  room.post("user", "@be làm", { taskId: "T9" });
  await idle(room);
  const u = deps.usage.all();
  assert.equal(u.length, 1);
  assert.deepEqual([u[0].worker, u[0].account, u[0].taskId, u[0].costUsd, u[0].model], ["be", "claude-main", "T9", 0.2, "claude-opus"]);
  assert.deepEqual(u[0].tools, { Edit: 2, Bash: 1 });
  const reply = room.snapshot().messages.find((m) => m.from === "be")!;
  assert.ok(reply.turnId);
  const t = deps.inspector.load(reply.turnId!)!;
  assert.equal(t.sessionKey, "be:T9");
  assert.equal(t.usage!.costUsd, 0.2);
  assert.ok(t.systemSections.some((s) => s.name === "Vai trò & quy tắc"));
  assert.match(t.prompt, /<new_messages_for_you>/);
});

test("room: a failed turn is still recorded with its error (but not rate-limited retries)", async () => {
  let n = 0;
  const fake = new Fake(() => { n++; throw new Error("kaput"); });
  const { room, deps } = makeRoom(fake);
  room.post("user", "@be làm");
  await idle(room);
  assert.equal(deps.usage.all().length, 1);
  assert.equal(deps.usage.all()[0].error, "kaput");
  assert.equal(n, 1);
});

const BUDGET_CFG = `accounts: { c: { provider: claude, budgetUsdPerDay: 10, warnAtPercent: 50 } }\nworkers:\n  - { id: be, name: B, role: R, account: c, coordinator: true }\n`;
const costly = (usd: number) => new Fake(() => ({ text: "ok", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: usd, estimated: false } }));

test("budget: warns once at the threshold, then pauses the account until midnight", async () => {
  const fake = costly(6);
  const { room, deps } = makeRoom(fake, { config: parseConfig(BUDGET_CFG) });
  room.post("user", "một");
  await idle(room);
  const sys = () => room.snapshot().messages.filter((m) => m.from === "system").map((m) => m.text);
  assert.equal(sys().filter((t) => /60%/.test(t)).length, 1);
  assert.equal(deps.scheduler.stats("c").pausedUntil, 0);

  room.post("user", "hai");
  await idle(room);
  assert.equal(fake.calls.length, 2);
  assert.ok(sys().some((t) => /chạm ngân sách/.test(t)));
  assert.ok(deps.scheduler.stats("c").pausedUntil > Date.now());
  assert.equal(room.snapshot().accounts[0].paused, true);

  room.post("user", "ba");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fake.calls.length, 2, "no new turn while over budget");
  assert.equal(room.snapshot().statuses[0].state, "over_budget");

  room.allowBudgetToday("c");
  await idle(room);
  assert.equal(fake.calls.length, 3);
  assert.equal(sys().filter((t) => /chạm ngân sách/.test(t)).length, 1, "no repeat announcements after override");
});

test("budget: an account already over budget at startup starts paused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u-"));
  new UsageStore(dir).append(rec({ account: "c", costUsd: 50 }));
  const fake = costly(1);
  const { room, deps } = makeRoom(fake, { config: parseConfig(BUDGET_CFG), usage: new UsageStore(dir) });
  assert.ok(deps.scheduler.stats("c").pausedUntil > Date.now());
  room.post("user", "x");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fake.calls.length, 0);
  assert.equal(readFileSync(join(dir, "usage.jsonl"), "utf8").split("\n").filter(Boolean).length, 1);
});

import { READ_ONLY_DENY, buildClaudeOptions } from "../src/adapters/claude";
import { READ_ONLY_TOOLS } from "../src/adapters/types";

test("claude options: read-only turns drop the worker's tools and deny write tools; normal turns keep them", async () => {
  const w = parseConfig(`accounts: { c: { provider: claude } }\nworkers:\n  - { id: be, name: B, role: R, account: c, allowedTools: [Read, "Edit(apps/api/**)", "Bash(npm test:*)"] }\n`);
  const base = { worker: w.workers[0], cwd: "/w", systemAppend: "S", mcpUrl: "http://x", account: w.accounts[0], approve: async () => true };
  const normal = buildClaudeOptions({ ...base }, undefined, new AbortController());
  assert.deepEqual(normal.allowedTools, ["Read", "Edit(apps/api/**)", "Bash(npm test:*)", "mcp__agentroom"]);
  assert.equal(normal.disallowedTools, undefined);

  const ro = buildClaudeOptions({ ...base, readOnly: true }, undefined, new AbortController());
  assert.deepEqual(ro.allowedTools, [...READ_ONLY_TOOLS, "mcp__agentroom"]);
  assert.deepEqual(ro.disallowedTools, READ_ONLY_DENY);
  for (const t of ["Edit", "Write", "Bash", "WebFetch"]) assert.ok(ro.disallowedTools!.includes(t), t);
  assert.ok(!ro.allowedTools!.some((t) => /Edit|Bash/.test(t)));

  // second line of defence: the callback itself refuses non-read tools but lets room tools through
  const opts = { signal: new AbortController().signal, toolUseID: "1" } as never;
  const verdict = async (o: typeof ro, tool: string) => (await o.canUseTool!(tool, {}, opts))?.behavior;
  assert.equal(await verdict(ro, "Write"), "deny");
  assert.equal(await verdict(ro, "mcp__other__thing"), "deny");
  assert.equal(await verdict(ro, "mcp__agentroom__post_message"), "allow");
  let asked = 0;
  const gated = buildClaudeOptions({ ...base, approve: async () => { asked++; return false; } }, undefined, new AbortController());
  assert.equal(await verdict(gated, "Write"), "deny");
  assert.equal(asked, 1, "normal turns ask the human");
});

test("usage: Claude's reported cost is cumulative per session, so each turn is stored as the difference (also across a restart)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-usage-"));
  const a = new UsageStore(dir);
  a.append(rec({ sessionId: "s1", costUsd: 0.2 }));
  a.append(rec({ sessionId: "s1", costUsd: 0.5 }));
  a.append(rec({ sessionId: "s2", costUsd: 0.1 }));   // a new session starts from zero
  a.append(rec({ sessionId: "s1", costUsd: 0.9 }));
  assert.deepEqual(a.all().map((r) => Math.round(r.costUsd! * 100) / 100), [0.2, 0.3, 0.1, 0.4]);
  assert.equal(Math.round(a.summarize("today").totals.costUsd * 100) / 100, 1.0);
  const b = new UsageStore(dir);
  b.append(rec({ sessionId: "s1", costUsd: 1.0 }));
  assert.equal(Math.round(b.all()[4].costUsd! * 100) / 100, 0.1, "the running total survives a restart");
  assert.equal(Math.round(b.all().reduce((s, r) => s + r.costUsd!, 0) * 100) / 100, 1.1);
  // Codex estimates are per turn already
  a.append(rec({ provider: "codex", estimated: true, sessionId: "t1", costUsd: 0.3 }));
  a.append(rec({ provider: "codex", estimated: true, sessionId: "t1", costUsd: 0.3 }));
  assert.equal(a.all().slice(-2).every((r) => r.costUsd === 0.3), true);
});

test("usage: old logs with cumulative numbers (no sessionId) are corrected when loaded; the file is untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-usage-"));
  const raw = [0.17, 0.21, 0.75, 0.14, 0.92].map((c, i) => JSON.stringify(rec({ ts: i, costUsd: c }))).join("\n") + "\n";
  require("node:fs").writeFileSync(join(dir, "usage.jsonl"), raw);
  const s = new UsageStore(dir);
  // 0.17, +0.04, +0.54, the drop to 0.14 is a new session, +0.78
  assert.deepEqual(s.all().map((r) => Math.round(r.costUsd! * 100) / 100), [0.17, 0.04, 0.54, 0.14, 0.78]);
  assert.equal(readFileSync(join(dir, "usage.jsonl"), "utf8"), raw);
});

test("inspector: a new session's fixed context (as the CLI reports it) is saved and rendered, biggest first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-ctx-"));
  const fake = new Fake((req) => ({ sessionId: "s1", text: "ok", context: req.sessionId ? undefined : { categories: [{ name: "Tools", tokens: 8000 }, { name: "Memory files", tokens: 61000 }], total: 69000 } }));
  const r = makeRoom(fake, { config: parseConfig(`accounts: { c: { provider: claude, maxConcurrent: 2 } }\nworkers:\n  - { id: be, name: Minh, role: Dev, account: c, coordinator: true }\n`) });
  r.room.post("user", "@be a"); await idle(r.room);
  r.room.post("user", "@be b"); await idle(r.room);
  const recs = readdirSync(join(r.dir, ".agentroom", "state", "turns")).sort().map((f) => JSON.parse(readFileSync(join(r.dir, ".agentroom", "state", "turns", f), "utf8")) as TurnRecord);
  const withCtx = recs.filter((x) => x.context);
  assert.equal(withCtx.length, 1, "only the new session's first turn has it");
  const text = renderTurn(withCtx[0]);
  assert.ok(text.indexOf("Memory files") < text.indexOf("| Tools"), "biggest category first");
  assert.match(text, /\*\*Tổng\*\* \| \*\*69,?000|Tổng/);
  void dir;
});

import { renderContextReport } from "../src/core/inspector";

test("measureContext: Claude workers are measured without a turn, others and remote ones say why; the report lists the biggest first", async () => {
  const calls: string[] = [];
  const fake = Object.assign(new Fake(() => "ok"), {
    async measureContext(req: { worker: { id: string }; prompt: string; systemAppend: string }) { calls.push(req.worker.id); return { categories: [{ name: "System tools", tokens: 9000 }, { name: "Memory files", tokens: 3000 }], total: 12000 }; },
  });
  const r = makeRoom(fake, { config: parseConfig(`accounts: { c: { provider: claude, maxConcurrent: 2 }, x: { provider: codex, maxConcurrent: 1 } }\nworkers:\n  - { id: be, name: Minh, role: Dev, account: c, coordinator: true }\n  - { id: dx, name: Hà, role: Docs, account: x }\n`) });
  const rows = await r.room.measureContext();
  assert.deepEqual(calls, ["be"], "no worker was run; only the Claude one was probed");
  assert.equal(fake.calls.length, 0, "no turn ran");
  assert.equal(rows[0].breakdown?.total, 12000);
  assert.ok(rows[0].promptTokens > 0);
  assert.match(rows[1].note ?? "", /Claude/);
  const text = renderContextReport(rows);
  assert.ok(text.indexOf("System tools") < text.indexOf("Memory files"));
  assert.match(text, /@dx/);
});

import { codexConfig } from "../src/adapters/codex";

test("codex: the room's MCP server tools are approved up front (codex exec cannot ask)", () => {
  assert.deepEqual(codexConfig("http://x/1"), { mcp_servers: { agentroom: { url: "http://x/1", default_tools_approval_mode: "approve" } } });
});

import { explainCodexError } from "../src/adapters/codex";

test("codex: the Windows sandbox failure gets a hint; other errors pass through untouched", () => {
  const e = new Error("Codex: CreateProcess ... setup refresh had errors");
  const out = explainCodexError(e) as Error;
  assert.match(out.message, /setup refresh had errors/);
  assert.match(out.message, /unelevated/);
  const other = new Error("Codex: something else");
  assert.equal(explainCodexError(other), other, "same object, untouched");
});
