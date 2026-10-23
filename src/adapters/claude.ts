import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { RateLimitError } from "../core/scheduler";
import { AgentAdapter, TurnRequest, TurnResult, accountEnv, summarizeInput } from "./types";

type Sdk = typeof import("@anthropic-ai/claude-agent-sdk");
let sdk: Promise<Sdk> | undefined;
const load = () => (sdk ??= import("@anthropic-ai/claude-agent-sdk"));

/** Runs one worker turn as a Claude Code session via the Claude Agent SDK. */
export class ClaudeAdapter implements AgentAdapter {
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const { query } = await load();
    const abortController = new AbortController();
    req.signal.addEventListener("abort", () => abortController.abort(), { once: true });

    const options: Options = {
      cwd: req.cwd,
      resume: req.sessionId,
      model: req.worker.model,
      systemPrompt: { type: "preset", preset: "claude_code", append: req.systemAppend },
      // Load the repo's CLAUDE.md / .claude settings so workers follow project conventions.
      settingSources: ["project"],
      allowedTools: [...req.worker.allowedTools, "mcp__agentroom"],
      mcpServers: { agentroom: { type: "http", url: req.mcpUrl } },
      env: accountEnv(req.account, "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY"),
      abortController,
      canUseTool: async (toolName, input) =>
        (await req.approve(toolName, input))
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "Người dùng đã từ chối thao tác này." },
    };

    let sessionId = req.sessionId;
    let lastText = "";
    for await (const m of query({ prompt: req.prompt, options }) as AsyncIterable<SDKMessage>) {
      if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
      else if (m.type === "assistant") {
        for (const block of m.message.content) {
          if (block.type === "tool_use") req.onActivity(`${block.name} ${summarizeInput(block.input)}`.trim());
          else if (block.type === "text" && block.text.trim()) lastText = block.text;
        }
      } else if (m.type === "rate_limit_event" && m.rate_limit_info.status === "rejected") {
        const at = m.rate_limit_info.resetsAt;
        const ms = at ? (at < 1e12 ? at * 1000 : at) - Date.now() : undefined;
        throw new RateLimitError(`Claude rate limit (${m.rate_limit_info.rateLimitType ?? "unknown"})`, ms && ms > 0 ? ms : undefined);
      } else if (m.type === "result") {
        sessionId = m.session_id;
        if (m.subtype === "success") return { sessionId, text: m.result || lastText };
        throw new Error(`Claude: ${m.subtype}: ${m.errors.join("; ")}`);
      }
    }
    return { sessionId, text: lastText };
  }
}
