import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { RateLimitError } from "../core/scheduler";
import { TurnUsage } from "../core/types";
import { AgentAdapter, ContextBreakdown, READ_ONLY_TOOLS, approvalAllowed, approvalReason, claudeToolSet, TurnRequest, TurnResult, accountEnv, summarizeInput } from "./types";

type Sdk = typeof import("@anthropic-ai/claude-agent-sdk");
let sdk: Promise<Sdk> | undefined;
const load = () => (sdk ??= import("@anthropic-ai/claude-agent-sdk"));

const isRoomTool = (name: string) => name.startsWith("mcp__agentroom__");

/** Built-in tools that can change files, run commands or send data out. Denied outright in read-only turns. */
export const READ_ONLY_DENY = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch"];

/**
 * Options for one Claude turn. In a read-only turn (untrusted trigger) the worker's own
 * allowed tools are dropped and the write tools are *disallowed*: a deny rule beats any
 * allow rule a repo's .claude/settings.json might add, so the canUseTool callback is
 * only the second line of defence.
 */
export function buildClaudeOptions(
  req: Pick<TurnRequest, "worker" | "cwd" | "sessionId" | "systemAppend" | "mcpUrl" | "account" | "readOnly" | "claudeSkills" | "approve" | "maxTurns" | "effort">,
  executable: string | undefined,
  abortController: AbortController,
): Options {
  const allowed = req.readOnly ? READ_ONLY_TOOLS : req.worker.allowedTools;
  return {
    cwd: req.cwd,
    pathToClaudeCodeExecutable: executable,
    resume: req.sessionId,
    model: req.worker.model,
    systemPrompt: { type: "preset", preset: "claude_code", append: req.systemAppend },
    // Load the repo's CLAUDE.md / .claude settings so workers follow project conventions.
    settingSources: ["project"],
    tools: claudeToolSet(req.worker, req.readOnly),
    allowedTools: [...allowed, "mcp__agentroom"],
    ...(req.readOnly ? { disallowedTools: READ_ONLY_DENY } : {}),
    mcpServers: { agentroom: { type: "http", url: req.mcpUrl } },
    // A worker needs the room's MCP server and nothing else. Without this the CLI also connects the account's claude.ai connectors
    // (Figma, Docs, …) and loads their tool definitions into every session. Set AGENTROOM_KEEP_CONNECTORS=1 to keep them.
    ...(process.env.AGENTROOM_KEEP_CONNECTORS === "1" ? {} : { strictMcpConfig: true, settings: { disableClaudeAiConnectors: true } }),
    env: { BASH_MAX_OUTPUT_LENGTH: BASH_OUTPUT_CHARS, ...accountEnv(req.account, "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY") },
    abortController,
    ...(req.maxTurns ? { maxTurns: req.maxTurns } : {}),
    // Not for another endpoint (a gateway may not know the parameter).
    ...(req.effort && !req.account.baseUrl ? { effort: req.effort } : {}),
    ...(req.claudeSkills ? { plugins: req.claudeSkills.plugins, skills: req.claudeSkills.skills } : {}),
    canUseTool: async (toolName, input) => {
      if (req.readOnly && !READ_ONLY_TOOLS.includes(toolName) && !isRoomTool(toolName)) {
        return { behavior: "deny", message: "Lượt này chỉ có quyền đọc (nguồn kích hoạt không tin cậy)." };
      }
      const r = await req.approve(toolName, input);
      return approvalAllowed(r)
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: approvalReason(r) ?? "Người dùng đã từ chối thao tác này." };
    },
  };
}

/** Claude Code cuts the middle out of a Bash result longer than this (default 30000). Every kept character is paid for again on each later call of the session, so a lower cap saves a lot; a value the person already set in the environment wins. */
export const BASH_OUTPUT_CHARS = "15000";

/** Appended to what a turn had said when it was stopped at limits.maxModelTurns. No @, so it wakes nobody. */
export const MAX_TURNS_NOTE = (n: number) => `⚠️ Lượt này dừng ở giới hạn ${n} lần gọi model (limits.maxModelTurns). Nhắn "tiếp tục" để làm tiếp.`;

/** Reduces an SDK result message to normalised usage; the cost is the CLI's own number. */
export function claudeUsage(m: {
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  total_cost_usd: number;
  num_turns: number;
  modelUsage?: Record<string, { costUSD: number }>;
}): TurnUsage {
  const top = Object.entries(m.modelUsage ?? {}).sort((a, b) => b[1].costUSD - a[1].costUSD)[0]?.[0];
  return {
    model: top,
    input: m.usage.input_tokens ?? 0,
    output: m.usage.output_tokens ?? 0,
    cacheRead: m.usage.cache_read_input_tokens ?? 0,
    cacheWrite: m.usage.cache_creation_input_tokens ?? 0,
    costUsd: m.total_cost_usd,
    estimated: false,
    numTurns: m.num_turns,
    tokenProvenance: "provider",
    costProvenance: "provider",
  };
}

/** Asks the CLI what fills the context window (no model call). Only for a new session: that is where the fixed part shows. Never fails the turn. */
async function contextOf(q: { getContextUsage?: (o?: { detail?: "summary" | "full" }) => Promise<{ categories: { name: string; tokens: number; kind?: string }[]; totalTokens: number }> }, detail: "summary" | "full" = "summary"): Promise<ContextBreakdown | undefined> {
  try {
    const r = await q.getContextUsage?.({ detail });
    if (!r) return undefined;
    return { categories: r.categories.filter((c) => c.kind === undefined || c.kind === "used").map((c) => ({ name: c.name, tokens: c.tokens })).filter((c) => c.tokens > 0), total: r.totalTokens };
  } catch { return undefined; }
}

/** Runs one worker turn as a Claude Code session via the Claude Agent SDK. */
export class ClaudeAdapter implements AgentAdapter {
  /** `executable` returns the user's `claude` CLI path, or undefined to use the SDK's bundled one. */
  constructor(private executable: () => string | undefined = () => undefined) {}

  /**
   * Starts the CLI with the same options as a real turn, but its input stream never delivers a message, so the model is never
   * called: the CLI only reports what would fill the window (system prompt, tools, CLAUDE.md, skills, MCP). Verified with the real CLI.
   */
  async measureContext(req: TurnRequest): Promise<ContextBreakdown | undefined> {
    const { query } = await load();
    const abortController = new AbortController();
    req.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    async function* input(): AsyncGenerator<never> { await gate; }
    const q = query({ prompt: input() as never, options: buildClaudeOptions(req, this.executable(), abortController) });
    const drain = (async () => { try { for await (const _ of q as AsyncIterable<unknown>) { /* only status messages arrive */ } } catch { /* closed below */ } })();
    try {
      const r = await Promise.race([
        q.getContextUsage({ detail: "full" }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 60_000)),
      ]);
      return { categories: r.categories.filter((c) => c.kind === undefined || c.kind === "used").map((c) => ({ name: c.name, tokens: c.tokens })).filter((c) => c.tokens > 0), total: r.totalTokens };
    } finally {
      abortController.abort();
      release();
      await Promise.race([drain, new Promise((r) => setTimeout(r, 2000))]);
    }
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const { query } = await load();
    const abortController = new AbortController();
    req.signal.addEventListener("abort", () => abortController.abort(), { once: true });

    const options = buildClaudeOptions(req, this.executable(), abortController);

    let sessionId = req.sessionId;
    let lastText = "";
    let context: ContextBreakdown | undefined;
    let measuredAfterReply = false;
    const q = query({ prompt: req.prompt, options });
    for await (const m of q as AsyncIterable<SDKMessage>) {
      if (m.type === "system" && m.subtype === "init") {
        sessionId = m.session_id;
        // The query is closed once the result arrives, so the fixed part is read now (a control request, no model call).
        if (!req.sessionId) context = await contextOf(q);
      }
      else if (m.type === "assistant") {
        // After the first reply of a NEW session the CLI knows what it really sent (the startup reading is much smaller on some setups).
        if (!req.sessionId && !measuredAfterReply) { measuredAfterReply = true; context = (await contextOf(q, "full")) ?? context; }
        for (const block of m.message.content) {
          if (block.type === "tool_use") req.onActivity(`${block.name} ${summarizeInput(block.input)}`.trim());
          else if (block.type === "text" && block.text.trim()) lastText = block.text;
        }
      } else if (m.type === "rate_limit_event" && m.rate_limit_info.status !== "rejected") {
        req.onRateLimit?.();
      } else if (m.type === "rate_limit_event" && m.rate_limit_info.status === "rejected") {
        req.onRateLimit?.();
        const at = m.rate_limit_info.resetsAt;
        const ms = at ? (at < 1e12 ? at * 1000 : at) - Date.now() : undefined;
        throw new RateLimitError(`Claude rate limit (${m.rate_limit_info.rateLimitType ?? "unknown"})`, ms && ms > 0 ? ms : undefined);
      } else if (m.type === "result") {
        sessionId = m.session_id;
        if (m.subtype === "success") return { sessionId, text: m.result || lastText, usage: claudeUsage(m), context };
        // The turn hit limits.maxModelTurns: keep what it did and what it paid, and say so, instead of throwing both away as an error.
        if (m.subtype === "error_max_turns") return { sessionId, text: `${lastText}${lastText ? "\n\n" : ""}${MAX_TURNS_NOTE(req.maxTurns ?? m.num_turns)}`, usage: claudeUsage(m), context };
        throw new Error(`Claude: ${m.subtype}: ${m.errors.join("; ")}`);
      }
    }
    return { sessionId, text: lastText };
  }
}
