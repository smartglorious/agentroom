import { createHash } from "node:crypto";
import { z } from "zod";
import type { Provider } from "../core/types";

export const MODEL_GATEWAY_SCHEMA_VERSION = 1 as const;

const TokenCount = z.number().int().nonnegative();

export const UsageReceiptV1Schema = z.object({
  schema_version: z.literal(MODEL_GATEWAY_SCHEMA_VERSION),
  request_id: z.string().min(1),
  provider: z.enum(["claude", "codex"]),
  model: z.string().min(1).optional(),
  provider_request_id: z.string().min(1).optional(),
  input_tokens: TokenCount,
  output_tokens: TokenCount,
  cache_read_tokens: TokenCount,
  cache_write_tokens: TokenCount,
  token_provenance: z.enum(["provider", "estimated", "unknown"]),
  cost_micros: z.number().int().nonnegative().optional(),
  cost_provenance: z.enum(["provider", "catalog_estimate", "unknown"]),
  currency: z.literal("USD"),
  unit_price_version: z.string().min(1).optional(),
  retry_of: z.string().min(1).optional(),
  fallback_of: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.cost_provenance === "unknown" && value.cost_micros !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cost_micros"], message: "unknown cost cannot carry a numeric value" });
  }
  if (value.cost_provenance === "catalog_estimate" && !value.unit_price_version) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unit_price_version"], message: "catalog estimates require a price version" });
  }
});

export type UsageReceiptV1 = z.infer<typeof UsageReceiptV1Schema>;

export const ModelCallRequestV1Schema = z.object({
  schema_version: z.literal(MODEL_GATEWAY_SCHEMA_VERSION),
  request_id: z.string().min(1),
  provider: z.enum(["claude", "codex"]),
  account_id: z.string().min(1),
  worker_id: z.string().min(1),
  model: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  step_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  attempt: z.number().int().positive(),
  system: z.string(),
  prompt: z.string(),
  allowed_tools: z.array(z.string().min(1)),
  read_only: z.boolean(),
  input_token_budget: TokenCount,
  output_token_budget: TokenCount,
  timeout_ms: z.number().int().positive(),
  created_at: z.number().int().nonnegative(),
  retry_of: z.string().min(1).optional(),
  fallback_of: z.string().min(1).optional(),
}).strict();

export type ModelCallRequestV1 = z.infer<typeof ModelCallRequestV1Schema>;

export const ModelCallResponseV1Schema = z.object({
  schema_version: z.literal(MODEL_GATEWAY_SCHEMA_VERSION),
  request_id: z.string().min(1),
  session_id: z.string().min(1).optional(),
  text: z.string(),
  finish_reason: z.enum(["completed", "length", "tool", "cancelled", "unknown"]),
  usage: UsageReceiptV1Schema,
}).strict().superRefine((value, ctx) => {
  if (value.usage.request_id !== value.request_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["usage", "request_id"], message: "usage receipt belongs to another request" });
  }
});

export type ModelCallResponseV1 = z.infer<typeof ModelCallResponseV1Schema>;

export const ModelCallErrorV1Schema = z.object({
  schema_version: z.literal(MODEL_GATEWAY_SCHEMA_VERSION),
  request_id: z.string().min(1),
  code: z.enum(["rate_limit", "timeout", "cancelled", "provider", "invalid_request", "budget_exceeded", "policy_denied", "unknown"]),
  message: z.string().min(1),
  retryable: z.boolean(),
  outcome: z.enum(["no_effect", "unknown", "completed"]),
  usage: UsageReceiptV1Schema.optional(),
}).strict();

export type ModelCallErrorV1 = z.infer<typeof ModelCallErrorV1Schema>;

export const promptFingerprint = (request: Pick<ModelCallRequestV1, "system" | "prompt">): string =>
  createHash("sha256").update(request.system).update("\0").update(request.prompt).digest("hex");

/** Safe ledger projection: deliberately excludes raw system and prompt content. */
export const requestLedgerMetadata = (request: ModelCallRequestV1) => ({
  schema_version: request.schema_version,
  request_id: request.request_id,
  provider: request.provider as Provider,
  account_id: request.account_id,
  worker_id: request.worker_id,
  model: request.model,
  run_id: request.run_id,
  step_id: request.step_id,
  task_id: request.task_id,
  attempt: request.attempt,
  prompt_sha256: promptFingerprint(request),
  input_token_budget: request.input_token_budget,
  output_token_budget: request.output_token_budget,
  created_at: request.created_at,
  retry_of: request.retry_of,
  fallback_of: request.fallback_of,
});
