export type Provider = "claude" | "codex";

/** A shared login (Claude subscription / Codex login / API key) that many workers use. */
export interface Account {
  id: string;
  provider: Provider;
  /** Claude: CLAUDE_CONFIG_DIR. Codex: CODEX_HOME. Omit to use the default login. */
  home?: string;
  /** Env var holding an API key (ANTHROPIC_API_KEY / OPENAI_API_KEY style). */
  apiKeyEnv?: string;
  /** How many turns may run at once on this account. */
  maxConcurrent: number;
}

/** A persona: a role with skills, bound to a provider and a shared account. */
export interface Worker {
  id: string;
  name: string;
  role: string;
  skills: string[];
  provider: Provider;
  account: string;
  model?: string;
  instructions: string;
  /** Claude tool names pre-approved without asking. Others go through approval. */
  allowedTools: string[];
  /** Give this worker its own git worktree (recommended for anyone who edits code). */
  worktree: boolean;
  /** Receives messages that mention nobody; plans and delegates. */
  coordinator: boolean;
  /** Codex sandbox; ignored for Claude. */
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

export interface RoomConfig {
  accounts: Account[];
  workers: Worker[];
}

export const HUMAN = "user";
export const SYSTEM = "system";

export interface ChatMessage {
  id: string;
  ts: number;
  /** Worker id, HUMAN or SYSTEM. */
  from: string;
  text: string;
  /** Resolved recipient worker ids. */
  to: string[];
  /** Agent-to-agent hop count since the last human message. */
  depth: number;
  /** Optional task the message belongs to (selects which session of a worker answers). */
  taskId?: string;
}

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";

export interface Task {
  id: string;
  title: string;
  description: string;
  assignee?: string;
  status: TaskStatus;
  dependsOn: string[];
  createdBy: string;
  result?: string;
  updatedAt: number;
}

export type WorkerState = "idle" | "queued" | "working" | "waiting_approval" | "rate_limited" | "error";

export interface WorkerStatus {
  id: string;
  state: WorkerState;
  activity?: string;
}

export interface ApprovalRequest {
  id: string;
  workerId: string;
  tool: string;
  input: unknown;
}
