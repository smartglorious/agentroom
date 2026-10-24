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

export interface TurnResult {
  sessionId?: string;
  text: string;
  usage?: TurnUsage;
  /** Where the turn actually ran (remote hosts decide this themselves). */
  cwd?: string;
}

export interface AgentAdapter {
  runTurn(req: TurnRequest): Promise<TurnResult>;
}

/** Env for a CLI child process, pointing it at the shared account's login. */
export function accountEnv(account: Account, homeVar: string, keyVar: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  if (account.home) env[homeVar] = account.home;
  if (account.apiKeyEnv && process.env[account.apiKeyEnv]) env[keyVar] = process.env[account.apiKeyEnv]!;
  return env;
}

export function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const v = o.file_path ?? o.path ?? o.command ?? o.pattern ?? o.url ?? o.query;
  const s = typeof v === "string" ? v : "";
  return s.length > 80 ? s.slice(0, 77) + "..." : s;
}

export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite"];
