import type { Autonomy } from "./autonomy";
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
  /** The machine this login lives on (a key of `hosts`); omitted = this machine. */
  host?: string;
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
  /** Built-in tools this worker may use at all (Claude). Every loaded tool costs prompt tokens on every turn; see claudeToolSet. */
  tools?: string[];
  /** Give this worker its own git worktree (recommended for anyone who edits code). */
  worktree: boolean;
  /** Receives messages that mention nobody; plans and delegates. */
  coordinator: boolean;
  /** Codex sandbox; ignored for Claude. */
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  /** Checkout this worker uses instead of the workspace (on its host's machine). */
  workdir?: string;
  /** #rrggbb used to tell this worker apart in the chat. Filled from a palette when not set. */
  color: string;
  /** What this worker may do without asking. `full` in workers.yaml is not honoured: it must be switched on by the user on their own machine. */
  autonomy: Autonomy;
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

/** user@host, host, alias or IPv4/IPv6 — never something that could be read as an ssh option. */
export const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9_.@:%+-]*$/;

/** A machine that can run workers, reached over ssh. */
export interface HostDef {
  name: string;
  /** user@host, host or an alias from ~/.ssh/config. */
  ssh: string;
  port?: number;
  identityFile?: string;
  /** Default checkout of the repo on that machine. */
  repo?: string;
  /** Path to node on that machine (default: `node` from the login shell). */
  node?: string;
  claudePath?: string;
  codexPath?: string;
  connectTimeoutSec: number;
}

export interface RoomConfig {
  hosts: HostDef[];
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
  /** Where a human message came from when it was not typed in VS Code (e.g. "telegram"). */
  source?: string;
  /** A system notice worth interrupting the user for: failures, budget stops, drafts waiting, tasks not started. */
  alert?: boolean;
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
  /** Folder the turn works in (on `host` when set); lets remote approvers check the path is inside it. */
  cwd?: string;
  host?: string;
  /** Why the worker's autonomy mode did not decide this itself. */
  reason?: string;
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
