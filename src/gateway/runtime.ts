import type { AgentAdapter, TurnRequest, TurnResult } from "../adapters/types";
import type { PriceTable } from "../adapters/codex";
import type { Provider, RoomConfig } from "../core/types";
import { ModelGateway } from "./dispatcher";
import { ModelCostLedger } from "./ledger";
import type { ModelCapabilityProfile } from "./router";
import type { SqliteConnection } from "../storage/sqlite";

const midnight = (at: number) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };
const toMicros = (usd: number | undefined) => usd === undefined ? undefined : Math.max(0, Math.round(usd * 1_000_000));

const estimate = (turn: TurnRequest, model: string | undefined, prices: PriceTable): number | undefined => {
  if (!model || !prices[model]) return undefined;
  const price = prices[model];
  const input = Math.max(1, Math.ceil((turn.systemAppend.length + turn.prompt.length) / 4));
  const usd = (input * price.input + 1_800 * price.output) / 1_000_000;
  return toMicros(usd);
};

export const capabilityCatalogFromConfig = (config: RoomConfig): ModelCapabilityProfile[] => {
  const seen = new Set<string>();
  return config.workers.flatMap((worker) => {
    const key = `${worker.provider}\0${worker.model ?? "default"}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      id: `${worker.provider}:${worker.model ?? "default"}`, provider: worker.provider, model: worker.model,
      modalities: ["text" as const], contextWindow: worker.contextLimit || 200_000, structuredOutput: true,
      toolCalling: true, codingTier: 1, reasoningTier: 1, local: false, regions: ["configured"],
      sensitivity: ["public" as const, "internal" as const], quality: 1, reliability: 1, latencyP95Ms: 1,
      estimatedCostMicros: undefined, available: true, schemaFamily: "agentroom-tools-v1", catalogVersion: "runtime-v1",
    }];
  });
};

/** Production bridge used by Room: every local provider call is routed and ledgered before its adapter runs. */
export class RoomGatewayRuntime {
  private readonly ledger: ModelCostLedger;
  private readonly profiles: ModelCapabilityProfile[];
  constructor(private readonly input: {
    db: SqliteConnection; workspaceId: string; config: RoomConfig; adapters: Record<Provider, AgentAdapter>; prices(): PriceTable;
  }) {
    this.ledger = new ModelCostLedger(input.db);
    this.profiles = capabilityCatalogFromConfig(input.config);
  }

  dispatch(meta: { turn: TurnRequest; runId?: string; stepId?: string; taskId?: string; attempt?: number }): Promise<TurnResult> {
    const prices = this.input.prices();
    // The worker's configured model is part of its identity: the router may pick among providers/accounts, never silently swap the model.
    const priced = this.profiles
      .filter((profile) => profile.provider === meta.turn.worker.provider && profile.model === meta.turn.worker.model)
      .map((profile) => ({ ...profile, estimatedCostMicros: estimate(meta.turn, profile.model, prices) }));
    const gateway = new ModelGateway(priced, this.ledger, (profile, turn) => this.input.adapters[profile.provider].runTurn(turn));
    const account = meta.turn.account;
    // A hard cap needs an estimate. Without a price entry the gateway cannot enforce it, so the Room's own after-the-fact
    // budget pause (usage store) stays the only guard instead of the cap blocking every turn.
    const estimated = priced.some((profile) => profile.estimatedCostMicros !== undefined);
    const cap = (usd: number | undefined) => estimated ? toMicros(usd) : undefined;
    return gateway.dispatch({ workspaceId: this.input.workspaceId, turn: meta.turn, runId: meta.runId, stepId: meta.stepId,
      taskId: meta.taskId, attempt: meta.attempt,
      requirements: { modalities: ["text"], contextTokens: Math.max(1, Math.ceil((meta.turn.systemAppend.length + meta.turn.prompt.length) / 4)),
        structuredOutput: false, toolCalling: meta.turn.worker.allowedTools.length > 0, minimumQuality: 0,
        sensitivity: meta.turn.readOnly ? "public" : "internal", allowedProviders: [meta.turn.worker.provider] },
      budget: { runMicros: meta.taskId ? cap(this.input.config.limits.usdPerTask) : undefined,
        accountDayMicros: cap(account.budgetUsdPerDay), dayStartsAt: midnight(Date.now()) },
    });
  }
}
