import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelCallErrorV1Schema, ModelCallRequestV1Schema, ModelCallResponseV1Schema, requestLedgerMetadata } from "../src/gateway/contracts";
import { selectModelRoute, type ModelCapabilityProfile } from "../src/gateway/router";
import { ModelBudgetExceededError, ModelCostLedger } from "../src/gateway/ledger";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteConnection } from "../src/storage/sqlite";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { schemaMigrations } from "../src/storage/schema-v1";
import { ModelGateway } from "../src/gateway/dispatcher";
import { Fake, idle, makeRoom } from "./helpers";
import { RoomGatewayRuntime } from "../src/gateway/runtime";
import { parseConfig, SAMPLE_CONFIG } from "../src/core/config";

const request = ModelCallRequestV1Schema.parse({
  schema_version: 1, request_id: "req-1", provider: "claude", account_id: "a1", worker_id: "be", model: "strong",
  attempt: 1, system: "private system", prompt: "private prompt", allowed_tools: ["Read"], read_only: true,
  input_token_budget: 1_000, output_token_budget: 200, timeout_ms: 30_000, created_at: 10,
});

test("model gateway contract: versioned request/response/usage and safe ledger projection", () => {
  const usage = { schema_version: 1 as const, request_id: "req-1", provider: "claude" as const, model: "strong",
    input_tokens: 12, output_tokens: 3, cache_read_tokens: 5, cache_write_tokens: 0,
    token_provenance: "provider" as const, cost_micros: 42, cost_provenance: "provider" as const, currency: "USD" as const };
  assert.equal(ModelCallResponseV1Schema.parse({ schema_version: 1, request_id: "req-1", text: "ok", finish_reason: "completed", usage }).text, "ok");
  assert.throws(() => ModelCallResponseV1Schema.parse({ schema_version: 1, request_id: "wrong", text: "ok", finish_reason: "completed", usage }), /another request/);
  assert.throws(() => ModelCallErrorV1Schema.parse({ schema_version: 1, request_id: "req-1", code: "timeout", message: "late", retryable: true, outcome: "unknown", rawPrompt: "leak" }));
  const metadata = requestLedgerMetadata(request);
  assert.match(metadata.prompt_sha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(metadata).includes("private"), false);
  assert.throws(() => ModelCallResponseV1Schema.parse({ schema_version: 1, request_id: "req-1", text: "ok", finish_reason: "completed",
    usage: { ...usage, cost_provenance: "unknown", cost_micros: 0 } }), /unknown cost/);
  assert.throws(() => ModelCallResponseV1Schema.parse({ schema_version: 1, request_id: "req-1", text: "ok", finish_reason: "completed",
    usage: { ...usage, token_provenance: "unknown" } }), /unknown token usage/);
});

const profile = (over: Partial<ModelCapabilityProfile>): ModelCapabilityProfile => ({
  id: "small", provider: "codex", model: "small", modalities: ["text"], contextWindow: 20_000,
  structuredOutput: true, toolCalling: true, codingTier: 1, reasoningTier: 1, local: false, regions: ["us"],
  sensitivity: ["public", "internal"], quality: 0.75, reliability: 0.98, latencyP95Ms: 500,
  estimatedCostMicros: 100, available: true, schemaFamily: "tools-v1", catalogVersion: "2026-10-26", ...over,
});

test("model router: hard filters, quality floor and schema-compatible fallback are deterministic", () => {
  const route = selectModelRoute([
    profile({ id: "cheap", quality: 0.8, estimatedCostMicros: 80 }),
    profile({ id: "strong", provider: "claude", model: "strong", codingTier: 3, reasoningTier: 3, quality: 0.95, estimatedCostMicros: 300 }),
    profile({ id: "incompatible", schemaFamily: "plain", quality: 0.9, estimatedCostMicros: 90 }),
    profile({ id: "offline", available: false, quality: 1 }),
  ], { modalities: ["text"], contextTokens: 10_000, toolCalling: true, minimumCodingTier: 2, minimumQuality: 0.8,
    sensitivity: "internal" }, { quality: 3, cost: 0.2, latency: 0.1, reliability: 1 });
  assert.equal(route.primary.id, "strong");
  assert.equal(route.fallback, undefined, "models below the coding floor cannot become fallback");
  assert.match(route.routeReason.join(" "), /hard filters/);
  assert.throws(() => selectModelRoute([profile({ local: false })], { modalities: ["text"], contextTokens: 1,
    minimumQuality: 0, sensitivity: "restricted", localOnly: true }), /No model/);
});

test("model cost ledger: reservations enforce hard caps and preserve unknown versus actual usage", async () => {
  const db = await SqliteConnection.open(join(mkdtempSync(join(tmpdir(), "ar-gateway-")), "agentroom.db"));
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.run("INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'One', 'file:///one', 1, 1)");
  try {
    const ledger = new ModelCostLedger(db);
    const policy = { runMicros: 150, accountDayMicros: 500, workspaceDayMicros: 500, dayStartsAt: 0 };
    const first = { ...request, run_id: "run-1", step_id: "step-1" };
    await ledger.reserve({ workspaceId: "w1", request: first, estimatedCostMicros: 100, policy, routeReason: ["test route"] });
    await ledger.complete("w1", { schema_version: 1, request_id: "req-1", provider: "claude", input_tokens: 10,
      output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, token_provenance: "provider",
      cost_micros: 90, cost_provenance: "provider", currency: "USD" }, 20);
    const second = { ...first, request_id: "req-2", step_id: "step-2", created_at: 21 };
    await assert.rejects(ledger.reserve({ workspaceId: "w1", request: second, estimatedCostMicros: 70, policy }),
      (error: unknown) => error instanceof ModelBudgetExceededError && error.scope === "run");
    assert.deepEqual(await db.get("SELECT status, block_reason FROM model_calls WHERE request_id = 'req-2'"),
      { status: "blocked", block_reason: "Model run budget exceeded (160 > 150 micros)" });

    const uncapped = { ...first, request_id: "req-3", run_id: "run-2", step_id: "step-3", created_at: 22 };
    await ledger.reserve({ workspaceId: "w1", request: uncapped, policy: { dayStartsAt: 0 } });
    await ledger.fail("w1", "req-3", "timeout", 23);
    assert.deepEqual(await db.get("SELECT status, token_provenance, cost_provenance, cost_micros FROM model_calls WHERE request_id = 'req-3'"),
      { status: "failed", token_provenance: "unknown", cost_provenance: "unknown", cost_micros: null });
    assert.equal(JSON.stringify(await db.get("SELECT * FROM model_calls WHERE request_id = 'req-1'")).includes("private prompt"), false);
  } finally { await db.close(); }
});

test("model gateway: reserves before dispatch, records error usage and uses compatible fallback", async () => {
  const db = await SqliteConnection.open(join(mkdtempSync(join(tmpdir(), "ar-dispatch-")), "agentroom.db"));
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.run("INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'One', 'file:///one', 1, 1)");
  try {
    const profiles = [profile({ id: "primary", provider: "claude", model: "strong", quality: .9, estimatedCostMicros: 20 }),
      profile({ id: "fallback", provider: "codex", model: "safe", quality: .8, estimatedCostMicros: 30 })];
    const invoked: string[] = [];
    const gateway = new ModelGateway(profiles, new ModelCostLedger(db), async (selected) => {
      invoked.push(selected.id);
      if (selected.id === "primary") throw new Error("provider outage");
      return { text: "ok", usage: { model: selected.model, input: 8, output: 2, cacheRead: 0, cacheWrite: 0,
        costUsd: .00003, estimated: true, tokenProvenance: "provider", costProvenance: "catalog_estimate", unitPriceVersion: "test-v1" } };
    });
    const turn = { worker: { id: "be", provider: "claude", model: "strong", allowedTools: [], useSkills: [] },
      account: { id: "a1" }, systemAppend: "system", prompt: "prompt", signal: new AbortController().signal } as any;
    const result = await gateway.dispatch({ workspaceId: "w1", turn, requirements: { modalities: ["text"], contextTokens: 100,
      minimumQuality: .7, sensitivity: "internal" }, budget: { runMicros: 100, dayStartsAt: 0 } });
    assert.equal(result.text, "ok");
    assert.deepEqual(invoked, ["primary", "fallback"]);
    const calls = await db.all<any>("SELECT status, error_code, fallback_of, cost_provenance FROM model_calls ORDER BY created_at, rowid");
    assert.equal(calls[0].status, "failed"); assert.equal(calls[0].error_code, "provider");
    assert.equal(calls[1].status, "completed"); assert.ok(calls[1].fallback_of); assert.equal(calls[1].cost_provenance, "catalog_estimate");
  } finally { await db.close(); }
});

test("Room runtime: local turns cannot bypass the configured model gateway", async () => {
  const adapter = new Fake(() => "through gateway");
  let dispatches = 0;
  const { room } = makeRoom(adapter, { modelGateway: { dispatch: async ({ turn }) => { dispatches += 1; return adapter.runTurn(turn); } } });
  room.post("user", "hello");
  await idle(room);
  assert.equal(dispatches, 1);
  assert.equal(room.snapshot().messages.at(-1)?.text, "through gateway");
});

test("production Room gateway: a real turn is reserved and completed in the model ledger", async () => {
  const db = await SqliteConnection.open(join(mkdtempSync(join(tmpdir(), "ar-room-gateway-")), "agentroom.db"));
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.run("INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'One', 'file:///one', 1, 1)");
  try {
    const config = parseConfig(SAMPLE_CONFIG); const adapter = new Fake(() => "ledgered");
    const runtime = new RoomGatewayRuntime({ db, workspaceId: "w1", config, adapters: { claude: adapter, codex: adapter }, prices: () => ({}) });
    const { room } = makeRoom(adapter, { config, modelGateway: runtime });
    room.post("user", "hello"); await idle(room);
    assert.deepEqual(await db.get("SELECT provider, status, token_provenance, input_tokens FROM model_calls"),
      { provider: "claude", status: "completed", token_provenance: "unknown", input_tokens: null });
  } finally { await db.close(); }
});

const twoModelConfig = (budget = "") => parseConfig(`
accounts:
  main:
    provider: claude${budget}
workers:
  - id: fw
    name: Tony
    role: dev
    account: main
    model: claude-sonnet-5-5
  - id: qafw
    name: Kevin
    role: qa
    account: main
    model: claude-haiku-5-5
`);

async function gatewayRoom(config: ReturnType<typeof parseConfig>, adapter: Fake) {
  const db = await SqliteConnection.open(join(mkdtempSync(join(tmpdir(), "ar-room-gateway-")), "agentroom.db"));
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.run("INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'One', 'file:///one', 1, 1)");
  const runtime = new RoomGatewayRuntime({ db, workspaceId: "w1", config, adapters: { claude: adapter, codex: adapter }, prices: () => ({}) });
  return { db, ...makeRoom(adapter, { config, modelGateway: runtime }) };
}

test("production Room gateway: each worker keeps its configured model", async () => {
  const adapter = new Fake(() => "ok");
  const { db, room } = await gatewayRoom(twoModelConfig(), adapter);
  try {
    room.post("user", "@fw hello"); await idle(room);
    room.post("user", "@qafw hello"); await idle(room);
    assert.deepEqual(adapter.calls.map((c) => [c.worker.id, c.worker.model]), [["fw", "claude-sonnet-5-5"], ["qafw", "claude-haiku-5-5"]]);
  } finally { await db.close(); }
});

test("production Room gateway: an account day budget without a price table does not block every turn", async () => {
  const adapter = new Fake(() => "ok");
  const { db, room } = await gatewayRoom(twoModelConfig("\n    budgetUsdPerDay: 20"), adapter);
  try {
    room.post("user", "@fw hello"); await idle(room);
    assert.equal(adapter.calls.length, 1);
  } finally { await db.close(); }
});

test("production Room gateway: with a price entry the account day budget is a hard cap before dispatch", async () => {
  const adapter = new Fake(() => "ok");
  const config = twoModelConfig("\n    budgetUsdPerDay: 0.000001");
  const db = await SqliteConnection.open(join(mkdtempSync(join(tmpdir(), "ar-room-gateway-")), "agentroom.db"));
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.run("INSERT INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'One', 'file:///one', 1, 1)");
  try {
    const runtime = new RoomGatewayRuntime({ db, workspaceId: "w1", config, adapters: { claude: adapter, codex: adapter },
      prices: () => ({ "claude-sonnet-5-5": { input: 3, output: 15 } }) });
    const { room } = makeRoom(adapter, { config, modelGateway: runtime });
    room.post("user", "@fw hello"); await idle(room);
    assert.equal(adapter.calls.length, 0, "the provider must not be called once the cap is projected to be exceeded");
    assert.equal((await db.get<{ status: string }>("SELECT status FROM model_calls"))?.status, "blocked");
  } finally { await db.close(); }
});
