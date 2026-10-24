import { explainSpawnError } from "../core/cli";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { codexSandbox } from "../core/autonomy";
import { TurnUsage } from "../core/types";
import { AgentAdapter, TurnRequest, TurnResult, accountEnv, summarizeInput } from "./types";

type Sdk = typeof import("@openai/codex-sdk");
let sdk: Promise<Sdk> | undefined;
const load = () => (sdk ??= import("@openai/codex-sdk"));

/** Pricing in USD per 1M tokens, keyed by model name. */
export type PriceTable = Record<string, { input: number; cachedInput?: number; output: number }>;

/**
 * Codex reports tokens only. `input_tokens` is treated as including the cached part,
 * so uncached input = input - cached. Cost is an estimate from the configured table;
 * unknown models get no cost rather than a guess.
 */
export function codexUsage(
  u: { input_tokens: number; cached_input_tokens: number; output_tokens: number; cache_write_input_tokens?: number },
  model: string | undefined,
  prices: PriceTable,
): TurnUsage {
  const cacheRead = u.cached_input_tokens ?? 0;
  const input = Math.max(0, (u.input_tokens ?? 0) - cacheRead);
  const p = model ? prices[model] : undefined;
  const costUsd = p ? (input * p.input + cacheRead * (p.cachedInput ?? p.input) + (u.output_tokens ?? 0) * p.output) / 1e6 : undefined;
  return { model, input, output: u.output_tokens ?? 0, cacheRead, cacheWrite: u.cache_write_input_tokens ?? 0, costUsd, estimated: true };
}

/**
 * Runs one worker turn as a Codex thread via the Codex SDK (wraps `codex exec`).
 * `codex exec` has no interactive approval hook, so safety comes from the sandbox
 * mode configured per worker instead of AgentRoom's approval cards.
 */
export class CodexAdapter implements AgentAdapter {
  /** `executable` returns the user's `codex` CLI path, or undefined to use the SDK's bundled one. */
  constructor(
    private executable: () => string | undefined = () => undefined,
    private prices: () => PriceTable = () => ({}),
  ) {}

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    try { return await this.run(req); } catch (e) {
      const hint = explainSpawnError(e, "codex");
      throw hint === (e instanceof Error ? e.message : String(e)) ? e : new Error(hint);
    }
  }

  private async run(req: TurnRequest): Promise<TurnResult> {
    const { Codex } = await load();
    const codex = new Codex({
      codexPathOverride: this.executable(),
      env: accountEnv(req.account, "CODEX_HOME", "OPENAI_API_KEY"),
      config: { mcp_servers: { agentroom: { url: req.mcpUrl } } },
    });
    const threadOpts: ThreadOptions = {
      workingDirectory: req.cwd,
      model: req.worker.model,
      sandboxMode: req.readOnly ? "read-only" : codexSandbox(req.autonomy ?? "manual", req.worker.sandbox),
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      additionalDirectories: req.extraReadDirs?.length ? req.extraReadDirs : undefined,
    };
    const thread = req.sessionId ? codex.resumeThread(req.sessionId, threadOpts) : codex.startThread(threadOpts);

    // Codex has no per-thread system prompt, so the persona opens the thread's first turn
    // and is remembered by the thread afterwards.
    const input = req.sessionId ? req.prompt : `<persona>\n${req.systemAppend}\n</persona>\n\n${req.prompt}`;
    const { events } = await thread.runStreamed(input, { signal: req.signal });
    let text = "";
    let usage: TurnUsage | undefined;
    for await (const e of events as AsyncGenerator<ThreadEvent>) {
      if (e.type === "item.started" || e.type === "item.completed") {
        const it = e.item;
        if (it.type === "command_execution" && e.type === "item.started") req.onActivity(`Bash ${it.command}`);
        else if (it.type === "file_change" && e.type === "item.completed") req.onActivity(`Edit ${it.changes.map((c) => c.path).join(", ")}`);
        else if (it.type === "mcp_tool_call" && e.type === "item.started") req.onActivity(`${it.tool} ${summarizeInput(it.arguments)}`.trim());
        else if (it.type === "agent_message" && e.type === "item.completed") text = it.text;
      } else if (e.type === "turn.completed") usage = codexUsage(e.usage, req.worker.model, this.prices());
      else if (e.type === "turn.failed") throw new Error(`Codex: ${e.error.message}`);
      else if (e.type === "error") throw new Error(`Codex: ${e.message}`);
    }
    return { sessionId: thread.id ?? req.sessionId, text, usage };
  }
}
