import { randomUUID } from "node:crypto";
import type { TurnResult, TurnRequest } from "../adapters/types";
import type { Provider, TurnUsage } from "../core/types";
import { ModelCallErrorV1Schema, type ModelCallErrorV1, type ModelCallRequestV1, type UsageReceiptV1 } from "./contracts";
import { ModelCostLedger, type ModelBudgetPolicy } from "./ledger";
import { selectModelRoute, type ModelCapabilityProfile, type RoutingRequirements, type RoutingWeights } from "./router";

export interface GatewayDispatchInput {
  workspaceId: string;
  turn: TurnRequest;
  runId?: string;
  stepId?: string;
  taskId?: string;
  attempt?: number;
  requirements: RoutingRequirements;
  budget: ModelBudgetPolicy;
  weights?: RoutingWeights;
}

export type GatewayInvoker = (profile: ModelCapabilityProfile, turn: TurnRequest) => Promise<TurnResult>;

export class ModelGatewayDispatchError extends Error {
  constructor(readonly detail: ModelCallErrorV1) { super(detail.message); }
}

const micros = (usage: TurnUsage | undefined) => usage?.costUsd === undefined ? undefined : Math.max(0, Math.round(usage.costUsd * 1_000_000));
const receipt = (request: ModelCallRequestV1, usage: TurnUsage | undefined): UsageReceiptV1 => ({
  schema_version: 1, request_id: request.request_id, provider: request.provider, model: usage?.model ?? request.model,
  ...(usage ? { input_tokens: usage.input, output_tokens: usage.output, cache_read_tokens: usage.cacheRead, cache_write_tokens: usage.cacheWrite } : {}),
  token_provenance: usage?.tokenProvenance ?? "unknown",
  ...(micros(usage) === undefined ? {} : { cost_micros: micros(usage) }),
  cost_provenance: usage?.costProvenance ?? "unknown", currency: "USD",
  unit_price_version: usage?.unitPriceVersion, provider_request_id: usage?.providerRequestId,
  retry_of: request.retry_of, fallback_of: request.fallback_of,
});

/** Provider-neutral dispatch with hard budget reservation and one schema-compatible fallback. */
export class ModelGateway {
  constructor(private readonly profiles: ModelCapabilityProfile[], private readonly ledger: ModelCostLedger, private readonly invoke: GatewayInvoker) {}

  async dispatch(input: GatewayDispatchInput): Promise<TurnResult> {
    const route = selectModelRoute(this.profiles, input.requirements, input.weights);
    const candidates = [route.primary, ...(route.fallback ? [route.fallback] : [])];
    let fallbackOf: string | undefined;
    let last: unknown;
    for (let index = 0; index < candidates.length; index += 1) {
      const profile = candidates[index];
      const request: ModelCallRequestV1 = {
        schema_version: 1, request_id: randomUUID(), provider: profile.provider, account_id: input.turn.account.id,
        worker_id: input.turn.worker.id, model: profile.model, run_id: input.runId, step_id: input.stepId,
        task_id: input.taskId, attempt: (input.attempt ?? 1) + index, system: input.turn.systemAppend, prompt: input.turn.prompt,
        allowed_tools: input.turn.worker.allowedTools, read_only: !!input.turn.readOnly,
        input_token_budget: input.requirements.contextTokens, output_token_budget: 1_800,
        timeout_ms: 15 * 60_000, created_at: Date.now(), fallback_of: fallbackOf,
      };
      await this.ledger.reserve({ workspaceId: input.workspaceId, request, estimatedCostMicros: profile.estimatedCostMicros,
        policy: input.budget, routeReason: route.routeReason });
      try {
        const result = await this.invoke(profile, { ...input.turn, worker: { ...input.turn.worker, provider: profile.provider, model: profile.model } });
        await this.ledger.complete(input.workspaceId, receipt(request, result.usage), Date.now());
        return result;
      } catch (error) {
        last = error;
        const detail = error instanceof ModelGatewayDispatchError ? error.detail : ModelCallErrorV1Schema.parse({
          schema_version: 1, request_id: request.request_id, code: input.turn.signal.aborted ? "cancelled" : "provider",
          message: error instanceof Error ? error.message : String(error), retryable: !input.turn.signal.aborted,
          outcome: "unknown",
        });
        await this.ledger.fail(input.workspaceId, request.request_id, detail.code, Date.now(), detail.usage);
        if (!detail.retryable || index + 1 >= candidates.length) throw error;
        fallbackOf = request.request_id;
      }
    }
    throw last instanceof Error ? last : new Error("Model gateway dispatch failed");
  }
}
