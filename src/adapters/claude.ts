import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { RateLimitError } from "../core/scheduler";
import { TurnUsage } from "../core/types";
import { AgentAdapter, READ_ONLY_TOOLS, TurnRequest, TurnResult, accountEnv, summarizeInput } from "./types";

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
  req: Pick<TurnRequest, "worker" | "cwd" | "sessionId" | "systemAppend" | "mcpUrl" | "account" | "readOnly" | "claudeSkills" | "approve">,
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
    allowedTools: [...allowed, "mcp__agentroom"],
    ...(req.readOnly ? { disallowedTools: READ_ONLY_DENY } : {}),
    mcpServers: { agentroom: { type: "http", url: req.mcpUrl } },
    env: accountEnv(req.account, "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY"),
    abortController,
    ...(req.claudeSkills ? { plugins: req.claudeSkills.plugins, skills: req.claudeSkills.skills } : {}),
    canUseTool: async (toolName, input) => {
      if (req.readOnly && !READ_ONLY_TOOLS.includes(toolName) && !isRoomTool(toolName)) {
        return { behavior: "deny", message: "Lượt này chỉ có quyền đọc (nguồn kích hoạt không tin cậy)." };
      }
      return (await req.approve(toolName, input))
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "Người dùng đã từ chối thao tác này." };
    },
  };
}

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
  };
}

/** Runs one worker turn as a Claude Code session via the Claude Agent SDK. */
export class ClaudeAdapter implements AgentAdapter {
  /** `executable` returns the user's `claude` CLI path, or undefined to use the SDK's bundled one. */
  constructor(private executable: () => string | undefined = () => undefined) {}

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const { query } = await load();
    const abortController = new AbortController();
    req.signal.addEventListener("abort", () => abortController.abort(), { once: true });

    const options = buildClaudeOptions(req, this.executable(), abortController);

    let sessionId = req.sessionId;
    let lastText = "";
    for await (const m of query({ prompt: req.prompt, options }) as AsyncIterable<SDKMessage>) {
      if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
      else if (m.type === "assistant") {
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
        if (m.subtype === "success") return { sessionId, text: m.result || lastText, usage: claudeUsage(m) };
        throw new Error(`Claude: ${m.subtype}: ${m.errors.join("; ")}`);
      }
    }
    return { sessionId, text: lastText };
  }
}
