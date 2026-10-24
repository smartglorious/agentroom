import { tr } from "../core/i18n";
import type { Autonomy } from "../core/autonomy";
import { Account, TurnUsage, Worker } from "../core/types";

export type ApprovalResult = boolean | { allow: boolean; reason?: string };
export const approvalAllowed = (r: ApprovalResult) => (typeof r === "boolean" ? r : r.allow);
export const approvalReason = (r: ApprovalResult) => (typeof r === "boolean" ? undefined : r.reason);

export interface TurnRequest {
  worker: Worker;
  account: Account;
  cwd: string;
  /** Persona prompt appended to the provider's system prompt. */
  systemAppend: string;
  prompt: string;
  /** Provider session/thread id to resume; undefined starts a new one. */
  sessionId?: string;
  /** AgentRoom MCP endpoint for this worker. */
  mcpUrl: string;
  /** Real skills to enable (Claude plugin) / directories the sandbox may read (Codex). */
  claudeSkills?: { plugins: { type: "local"; path: string }[]; skills: string[] };
  extraReadDirs?: string[];
  /** Only read-only tools allowed (untrusted triggers). */
  readOnly?: boolean;
  /** Set when the account lives on another machine: where and with which skills to run. */
  remote?: { host: string; base: string; skills: { name: string; dir: string }[] };
  signal: AbortSignal;
  /** The remote runner reports the folder the turn really runs in (after any worktree was made). */
  onCwd?(cwd: string): void;
  /** Claude reported a rate-limit status change: a good moment to re-read the plan numbers. */
  onRateLimit?(): void;
  /** Short progress lines ("Edit src/a.ts", "Bash npm test") for the UI. */
  onActivity(text: string): void;
  /** Decides a tool call: the human, or the worker's autonomy policy. A refusal may carry the reason, which the model is told. */
  approve(tool: string, input: unknown): Promise<ApprovalResult>;
  /** The worker's current autonomy (Codex maps it to its sandbox). */
  autonomy?: Autonomy;
}

export interface ContextBreakdown {
  categories: { name: string; tokens: number }[];
  total: number;
}

export interface TurnResult {
  sessionId?: string;
  text: string;
  usage?: TurnUsage;
  /** What fills the context window right after a NEW session's first turn (system prompt, tools, CLAUDE.md, skills…), as the CLI reports it. */
  context?: ContextBreakdown;
  /** Where the turn actually ran (remote hosts decide this themselves). */
  cwd?: string;
}

export interface AgentAdapter {
  runTurn(req: TurnRequest): Promise<TurnResult>;
  /** Claude: what would fill the window of a new session for this request, without sending any message to the model. */
  measureContext?(req: TurnRequest): Promise<ContextBreakdown | undefined>;
}

/** Env for a CLI child process, pointing it at the shared account's login. */
export function accountEnv(account: Account, homeVar: string, keyVar: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  if (account.home) env[homeVar] = account.home;
  if (account.apiKeyEnv && process.env[account.apiKeyEnv]) env[keyVar] = process.env[account.apiKeyEnv]!;
  if (account.provider === "claude" && account.baseUrl) {
    // Another endpoint: its token replaces any Anthropic key that happens to be in the environment, so the key is never sent there.
    env.ANTHROPIC_BASE_URL = account.baseUrl;
    delete env.ANTHROPIC_API_KEY;
    // Without this token the CLI would fall back to the person's own Claude login and send THAT to the other endpoint.
    const token = account.authTokenEnv ? process.env[account.authTokenEnv] : undefined;
    if (!token) throw new Error(tr("Account {id} dùng baseUrl nhưng biến môi trường {name} chưa có giá trị trong tiến trình này, nên không chạy (để không gửi phiên đăng nhập Claude của bạn sang endpoint khác). Đặt biến rồi khởi động lại VS Code.", { id: account.id, name: account.authTokenEnv ?? "authTokenEnv" }));
    env.ANTHROPIC_AUTH_TOKEN = token;
  }
  return env;
}

export function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const v = o.file_path ?? o.path ?? o.command ?? o.pattern ?? o.url ?? o.query;
  const s = typeof v === "string" ? v : "";
  return s.length > 80 ? s.slice(0, 77) + "..." : s;
}

/** The everyday coding set: what a worker gets, besides the tools named in its allowedTools, unless it lists `tools:` itself. */
export const CORE_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];

/**
 * The built-in tools Claude loads for a worker. `allowedTools` only pre-approves; it does not limit what is loaded, and
 * every loaded tool definition is sent on every request (≈33k tokens with all of them, ≈8k with the core set, measured
 * in docs/PLAN-v0.8-tokens.md). So the set is explicit:
 *  - read-only turns (untrusted triggers): Read, Grep, Glob;
 *  - `tools:` in workers.yaml, when given, exactly that;
 *  - otherwise the core set plus the tools named in allowedTools.
 * `Skill` is added whenever the worker has skills enabled.
 */
export function claudeToolSet(w: { allowedTools: string[]; tools?: string[]; useSkills: string[] }, readOnly?: boolean): string[] {
  const names = new Set<string>();
  if (readOnly) ["Read", "Grep", "Glob"].forEach((t) => names.add(t));
  else if (w.tools) w.tools.forEach((t) => names.add(t));
  else {
    CORE_TOOLS.forEach((t) => names.add(t));
    for (const a of w.allowedTools) { const base = a.replace(/\(.*$/, "").trim(); if (base && !base.startsWith("mcp__")) names.add(base); }
  }
  if (w.useSkills.length) names.add("Skill");
  return [...names];
}

export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite"];
