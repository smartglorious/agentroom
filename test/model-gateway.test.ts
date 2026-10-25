import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelCallErrorV1Schema, ModelCallRequestV1Schema, ModelCallResponseV1Schema, requestLedgerMetadata } from "../src/gateway/contracts";
import { selectModelRoute, type ModelCapabilityProfile } from "../src/gateway/router";

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
