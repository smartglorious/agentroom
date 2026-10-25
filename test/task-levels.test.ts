import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeOptions } from "../src/adapters/claude";
import { parseConfig } from "../src/core/config";
import { Fake, idle, makeRoom } from "./helpers";

const CFG = `accounts: { c: { provider: claude, maxConcurrent: 3 }, g: { provider: claude, baseUrl: "https://x.example/anthropic", authTokenEnv: TOK, maxConcurrent: 1 } }
workers:
  - { id: lead, name: Lan, role: Lead, account: c, coordinator: true }
  - id: be
    name: Minh
    role: Backend
    account: c
    model: claude-sonnet-5-5
    levels:
      low: { model: claude-haiku-5-5, effort: low }
      mid: { effort: medium }
      high: { model: claude-opus-5-5, effort: high }
  - id: gw
    name: Gia
    role: Gateway
    account: g
    levels:
      high: { model: deepseek-big, effort: high }
`;
const run = async (assignee: string, level?: "low" | "mid" | "high") => {
  const fake = new Fake((req) => ({ sessionId: `s-${req.worker.id}-${Math.random()}`, text: "ok", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 100, costUsd: 0.1, estimated: false, numTurns: 1 } }));
  const r = makeRoom(fake, { config: parseConfig(CFG) });
  const t = r.room.createTask(assignee === "lead" ? "be" : "lead", { title: "x", assignee, ...(level ? { level } : {}) });
  await idle(r.room);
  return { fake, r, t };
};

test("levels: a task's level picks the model and effort of the assignee's turns", async () => {
  const hi = await run("be", "high");
  assert.equal(hi.t.level, "high");
  assert.equal(hi.fake.calls[0].worker.model, "claude-opus-5-5");
  assert.equal(hi.fake.calls[0].effort, "high");
  const lo = await run("be", "low");
  assert.equal(lo.fake.calls[0].worker.model, "claude-haiku-5-5");
  assert.equal(lo.fake.calls[0].effort, "low");
  const mid = await run("be", "mid");
  assert.equal(mid.fake.calls[0].worker.model, "claude-sonnet-5-5", "a level without a model keeps the worker's own");
  assert.equal(mid.fake.calls[0].effort, "medium");
});

test("levels: a task without a level, or a worker without levels, is unchanged", async () => {
  const none = await run("be");
  assert.equal(none.fake.calls[0].worker.model, "claude-sonnet-5-5");
  assert.equal(none.fake.calls[0].effort, undefined);
  const lead = await run("lead", "high");
  assert.equal(lead.fake.calls[0].worker.model, undefined);
  assert.equal(lead.fake.calls[0].effort, undefined);
});

test("levels: another endpoint gets its own model name for the level but never the effort parameter", async () => {
  process.env.TOK = "test-token";
  const gw = await run("gw", "high");
  assert.equal(gw.fake.calls[0].worker.model, "deepseek-big");
  assert.equal(gw.fake.calls[0].effort, undefined);
  const base = { worker: parseConfig(CFG).workers[1], cwd: "/x", systemAppend: "", mcpUrl: "http://x", approve: async () => true };
  const cfg = parseConfig(CFG);
  assert.equal(buildClaudeOptions({ ...base, account: cfg.accounts[0], effort: "low" }, undefined, new AbortController()).effort, "low");
  assert.equal(buildClaudeOptions({ ...base, account: cfg.accounts[1], effort: "low" }, undefined, new AbortController()).effort, undefined);
  delete process.env.TOK;
});

test("levels: a session never carries over to another model (each model has its own cache)", async () => {
  const fake = new Fake((req) => ({ sessionId: "s1", text: "ok", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 100, costUsd: 0.1, estimated: false, numTurns: 1 } }));
  const r = makeRoom(fake, { config: parseConfig(CFG) });
  const t = r.room.createTask("lead", { title: "x", assignee: "be", level: "high" });
  await idle(r.room);
  r.room.post("user", "@be tiếp", { taskId: t.id });
  await idle(r.room);
  assert.equal(fake.calls[1].sessionId, "s1", "same model: the session is resumed");
  const be = r.deps.config.workers.find((w) => w.id === "be")!;
  be.levels!.high!.model = "claude-sonnet-5-5";
  r.room.post("user", "@be tiếp nữa", { taskId: t.id });
  await idle(r.room);
  const last = fake.calls[fake.calls.length - 1];
  assert.equal(last.sessionId, undefined, "another model: a new session");
  assert.equal(last.worker.model, "claude-sonnet-5-5");
});

test("levels: config and validation", () => {
  assert.deepEqual(parseConfig(CFG).workers[1].levels, { low: { model: "claude-haiku-5-5", effort: "low" }, mid: { effort: "medium" }, high: { model: "claude-opus-5-5", effort: "high" } });
  assert.throws(() => parseConfig(CFG.replace("high: { model: claude-opus-5-5, effort: high }", "extreme: { effort: high }")));
  assert.throws(() => parseConfig(CFG.replace("effort: low", "effort: turbo")));
  const r = makeRoom(new Fake(), { config: parseConfig(CFG) });
  assert.throws(() => r.room.createTask("lead", { title: "x", level: "huge" as never }), /low, mid hoặc high/);
});
