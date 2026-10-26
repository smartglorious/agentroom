import type { ModelCallRequestV1, UsageReceiptV1 } from "./contracts";
import { requestLedgerMetadata, UsageReceiptV1Schema } from "./contracts";
import type { SqliteConnection } from "../storage/sqlite";

export type BudgetScope = "step" | "run" | "account_day" | "workspace_day" | "estimate";

export interface ModelBudgetPolicy {
  stepMicros?: number;
  runMicros?: number;
  accountDayMicros?: number;
  workspaceDayMicros?: number;
  dayStartsAt: number;
}

export class ModelBudgetExceededError extends Error {
  constructor(readonly scope: BudgetScope, readonly projectedMicros: number, readonly limitMicros: number) {
    super(scope === "estimate" ? "A cost estimate is required before dispatch under a hard budget"
      : `Model ${scope} budget exceeded (${projectedMicros} > ${limitMicros} micros)`);
  }
}

const validateLimit = (value: number | undefined, name: string) => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${name} must be non-negative integer micros`);
};

const effectiveCost = `CASE WHEN status = 'reserved' THEN COALESCE(estimated_cost_micros, 0) ELSE COALESCE(cost_micros, 0) END`;

export class ModelCostLedger {
  constructor(private readonly db: SqliteConnection) {}

  async reserve(input: { workspaceId: string; request: ModelCallRequestV1; estimatedCostMicros?: number; policy: ModelBudgetPolicy; routeReason?: string[] }): Promise<void> {
    const { request, policy } = input;
    for (const [name, value] of Object.entries({ stepMicros: policy.stepMicros, runMicros: policy.runMicros,
      accountDayMicros: policy.accountDayMicros, workspaceDayMicros: policy.workspaceDayMicros })) validateLimit(value, name);
    if (!Number.isSafeInteger(policy.dayStartsAt) || policy.dayStartsAt < 0) throw new Error("dayStartsAt must be a non-negative integer");
    if (input.estimatedCostMicros !== undefined && (!Number.isSafeInteger(input.estimatedCostMicros) || input.estimatedCostMicros < 0)) {
      throw new Error("estimatedCostMicros must be non-negative integer micros");
    }
    const metadata = requestLedgerMetadata(request);
    let blocked: ModelBudgetExceededError | undefined;
    await this.db.transaction(async (tx) => {
      const existing = await tx.get<{ status: string; block_reason: string | null }>(
        "SELECT status, block_reason FROM model_calls WHERE request_id = ?", [request.request_id],
      );
      if (existing) {
        if (existing.status === "blocked") blocked = new ModelBudgetExceededError("estimate", 0, 0);
        return;
      }
      const capped = [policy.stepMicros, policy.runMicros, policy.accountDayMicros, policy.workspaceDayMicros].some((value) => value !== undefined);
      if (capped && input.estimatedCostMicros === undefined) blocked = new ModelBudgetExceededError("estimate", 0, 0);
      const sum = async (where: string, params: (string | number)[]) => (await tx.get<{ total: number }>(
        `SELECT COALESCE(SUM(${effectiveCost}), 0) AS total FROM model_calls WHERE workspace_id = ? AND status IN ('reserved','completed','failed') AND ${where}`,
        [input.workspaceId, ...params],
      ))?.total ?? 0;
      const estimate = input.estimatedCostMicros ?? 0;
      const checks: Array<[BudgetScope, number | undefined, string, (string | number)[]]> = [
        ["step", policy.stepMicros, "step_id = ?", [request.step_id ?? ""]],
        ["run", policy.runMicros, "run_id = ?", [request.run_id ?? ""]],
        ["account_day", policy.accountDayMicros, "account_id = ? AND created_at >= ?", [request.account_id, policy.dayStartsAt]],
        ["workspace_day", policy.workspaceDayMicros, "created_at >= ?", [policy.dayStartsAt]],
      ];
      if (!blocked) for (const [scope, limit, where, params] of checks) {
        if (limit === undefined) continue;
        const projected = await sum(where, params) + estimate;
        if (projected > limit) { blocked = new ModelBudgetExceededError(scope, projected, limit); break; }
      }
      await tx.run(
        `INSERT INTO model_calls(request_id, workspace_id, run_id, step_id, task_id, worker_id, account_id, provider, model,
          attempt, prompt_sha256, input_token_budget, output_token_budget, estimated_cost_micros, retry_of, fallback_of,
          route_reason_json, status, block_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [request.request_id, input.workspaceId, request.run_id ?? null, request.step_id ?? null, request.task_id ?? null,
          request.worker_id, request.account_id, request.provider, request.model ?? null, request.attempt, metadata.prompt_sha256,
          request.input_token_budget, request.output_token_budget, input.estimatedCostMicros ?? null, request.retry_of ?? null,
          request.fallback_of ?? null, JSON.stringify(input.routeReason ?? []), blocked ? "blocked" : "reserved", blocked?.message ?? null, request.created_at],
      );
    });
    if (blocked) throw blocked;
  }

  async complete(workspaceId: string, receiptInput: UsageReceiptV1, at: number): Promise<void> {
    const receipt = UsageReceiptV1Schema.parse(receiptInput);
    const result = await this.db.run(
      `UPDATE model_calls SET status = 'completed', input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
        token_provenance = ?, cost_micros = ?, cost_provenance = ?, unit_price_version = ?, provider_request_id = ?, completed_at = ?
       WHERE workspace_id = ? AND request_id = ? AND status = 'reserved'`,
      [receipt.input_tokens ?? null, receipt.output_tokens ?? null, receipt.cache_read_tokens ?? null, receipt.cache_write_tokens ?? null, receipt.token_provenance,
        receipt.cost_micros ?? null, receipt.cost_provenance, receipt.unit_price_version ?? null, receipt.provider_request_id ?? null,
        at, workspaceId, receipt.request_id],
    );
    if (result.changes !== 1) throw new Error(`Model call ${receipt.request_id} is missing or not reserved`);
  }

  async fail(workspaceId: string, requestId: string, errorCode: string, at: number, receiptInput?: UsageReceiptV1): Promise<void> {
    const receipt = receiptInput ? UsageReceiptV1Schema.parse(receiptInput) : undefined;
    if (receipt && receipt.request_id !== requestId) throw new Error("Failure usage receipt belongs to another request");
    const result = await this.db.run(
      `UPDATE model_calls SET status = 'failed', error_code = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
        cache_write_tokens = ?, token_provenance = ?, cost_micros = ?, cost_provenance = ?, unit_price_version = ?,
        provider_request_id = ?, completed_at = ? WHERE workspace_id = ? AND request_id = ? AND status = 'reserved'`,
      [errorCode, receipt?.input_tokens ?? null, receipt?.output_tokens ?? null, receipt?.cache_read_tokens ?? null,
        receipt?.cache_write_tokens ?? null, receipt?.token_provenance ?? "unknown", receipt?.cost_micros ?? null,
        receipt?.cost_provenance ?? "unknown", receipt?.unit_price_version ?? null, receipt?.provider_request_id ?? null,
        at, workspaceId, requestId],
    );
    if (result.changes !== 1) throw new Error(`Model call ${requestId} is missing or not reserved`);
  }
}
