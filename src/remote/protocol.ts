import type { Provider, TurnUsage } from "../core/types";

/**
 * Hub ⇄ runner protocol: one JSON object per line on the runner's stdin/stdout (i.e. through
 * the ssh channel). Every protocol line starts with PREFIX so banners or stray output that a
 * remote shell prints are ignored instead of corrupting the stream.
 */
export const PREFIX = "@AR ";
export const PROTOCOL_VERSION = 1;
/** Written by the bootstrap script when the runner file is not on the host yet. */
export const NEED_RUNNER = "AR_NEED";
export const OLD_NODE = "AR_OLDNODE";
export const MIN_NODE_MAJOR = 20;

export interface WireWorker {
  id: string;
  name: string;
  role: string;
  model?: string;
  allowedTools: string[];
  tools?: string[];
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  useSkills: string[];
  worktree: boolean;
}

export interface WireAccount {
  id: string;
  provider: Provider;
  /** CLAUDE_CONFIG_DIR / CODEX_HOME *on the host*. */
  home?: string;
  /** Name of an environment variable *on the host* that holds an API key. */
  apiKeyEnv?: string;
  baseUrl?: string;
  windowsSandbox?: "elevated" | "unelevated";
  /** Name of an environment variable *on the host* that holds the endpoint's token. */
  authTokenEnv?: string;
}

export interface WireSkillFile {
  path: string;
  b64: string;
}

export interface WireSkill {
  name: string;
  files: WireSkillFile[];
}

export interface PriceEntry { input: number; cachedInput?: number; output: number }

export interface TurnMessage {
  t: "turn";
  id: string;
  worker: WireWorker;
  account: WireAccount;
  /** Checkout on the host (`~` allowed). The runner adds a worktree under it when worker.worktree. */
  base: string;
  systemAppend: string;
  prompt: string;
  sessionId?: string;
  readOnly?: boolean;
  /** The worker's autonomy; the runner only uses it to size the Codex sandbox (approvals are decided on the hub). */
  autonomy?: "manual" | "auto" | "full";
  /** limits.maxModelTurns for Claude turns. */
  maxTurns?: number;
  /** Claude reasoning effort for the turn (from the task's level). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  skills: WireSkill[];
  claudePath?: string;
  codexPath?: string;
  pricing?: Record<string, PriceEntry>;
}

export type HubToRunner =
  | TurnMessage
  | { t: "approval"; reqId: string; allow: boolean; reason?: string }
  | { t: "abort"; id: string }
  | { t: "mcp-res"; reqId: string; status: number; headers: Record<string, string>; b64: string }
  | { t: "ping"; n: number };

export interface ReadyInfo {
  v: number;
  node: string;
  platform: string;
  arch: string;
  hostname: string;
  home: string;
  claude?: string;
  codex?: string;
}

export type RunnerToHub =
  | ({ t: "ready" } & ReadyInfo)
  | { t: "started"; id: string; cwd: string }
  | { t: "activity"; id: string; text: string }
  | { t: "approve"; id: string; reqId: string; tool: string; input: unknown }
  | { t: "mcp"; id: string; reqId: string; method: string; headers: Record<string, string>; b64: string }
  | { t: "result"; id: string; sessionId?: string; text: string; usage?: TurnUsage; cwd?: string }
  | { t: "error"; id: string; message: string; rateLimit?: boolean; retryAfterMs?: number }
  | { t: "pong"; n: number }
  | { t: "log"; text: string };

export const encode = (msg: HubToRunner | RunnerToHub): string => PREFIX + JSON.stringify(msg) + "\n";

/** Splits a byte stream into lines; protocol lines are parsed, the rest is reported as noise. */
export class LineDecoder {
  private buf = "";

  constructor(private onMessage: (m: unknown) => void, private onOther: (line: string) => void = () => undefined) {}

  push(chunk: Buffer | string) {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      if (line.startsWith(PREFIX)) {
        try { this.onMessage(JSON.parse(line.slice(PREFIX.length))); } catch { this.onOther(line); }
      } else this.onOther(line);
    }
    // A host that never sends a newline must not make us buffer forever.
    if (this.buf.length > 16_000_000) this.buf = "";
  }
}

export const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
export const unb64 = (s: string) => Buffer.from(s, "base64");
