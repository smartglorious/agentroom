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
  /** Daily spend limit (API-equivalent USD). The account pauses at 100%. */
  budgetUsdPerDay?: number;
  warnAtPercent: number;
}

/** A persona: a role with skills, bound to a provider and a shared account. */
export interface Worker {
  id: string;
  name: string;
  role: string;
  skills: string[];
  /** Real SKILL.md skills enabled for this worker (names from the skill registry). */
  useSkills: string[];
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

export interface ScheduleDef {
  id: string;
  /** Worker id, or "*" for every worker. */
  worker: string;
  cron: string;
  timezone?: string;
  prompt?: string;
  builtin?: "consolidate-memory";
  /** fresh: new session each run. persistent: one shared session per schedule. */
  session: "fresh" | "persistent";
  skipIfRunning: boolean;
  catchUpHours: number;
  notify: boolean;
  enabled: boolean;
}

export interface WebhookDef {
  id: string;
  worker: string;
  /** Env var holding the HMAC secret. Required unless allowUnsigned. */
  secretEnv?: string;
  /** Accept unsigned requests (local testing only). */
  allowUnsigned: boolean;
  match: Record<string, string | number | boolean>;
  prompt: string;
  maxPerHour: number;
  readOnly: boolean;
}

export interface RoomConfig {
  accounts: Account[];
  workers: Worker[];
  schedules: ScheduleDef[];
  webhooks: WebhookDef[];
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
  /** Turn that produced this message (for the Context Inspector). */
  turnId?: string;
  /** Run the recipients' turn with read-only tools (untrusted triggers such as webhooks). */
  readOnly?: boolean;
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

export type WorkerState = "idle" | "queued" | "working" | "waiting_approval" | "rate_limited" | "over_budget" | "error";

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

/** Normalised token/cost numbers for one turn. */
export interface TurnUsage {
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Provider-reported (Claude) or estimated from the pricing table (Codex). */
  costUsd?: number;
  estimated: boolean;
  numTurns?: number;
}
