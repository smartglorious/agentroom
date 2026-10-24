import { spawn } from "node:child_process";
import { explainSpawnError, needsShell } from "../core/cli";
import { tmpdir } from "node:os";
import { PlanUsage, fromClaudeUsage, fromCodexLimits } from "../core/plan";
import type { Account } from "../core/types";
import { accountEnv } from "./types";

const TIMEOUT_MS = 20_000;

/** Never includes the account's secrets: an error message is shown in the UI and sent to Telegram. */
const scrub = (s: string) => s.replace(/(sk-[\w-]{10,}|\b\d{6,}:[\w-]{20,})/g, "<ẩn>").slice(0, 300);

/**
 * Claude: asks a CLI session for its `/usage` data. No prompt is sent, so no model call is made and
 * nothing is billed; the session is closed straight after. For API-key / cloud logins the CLI says
 * plan limits do not apply, which is reported as "unavailable" rather than as an error.
 */
export async function probeClaudePlan(account: Account, executable: string | undefined, now = Date.now): Promise<PlanUsage> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const abort = new AbortController();
  async function* idle(): AsyncGenerator<never> { await new Promise(() => undefined); }
  const q = query({
    prompt: idle(),
    options: { cwd: tmpdir(), settingSources: [], pathToClaudeCodeExecutable: executable, env: accountEnv(account, "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY"), abortController: abort },
  });
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const r = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    return fromClaudeUsage(account.id, r, now());
  } catch (e) {
    throw new Error(abort.signal.aborted ? `quá ${TIMEOUT_MS / 1000}s không có phản hồi` : scrub(e instanceof Error ? e.message : String(e)));
  } finally {
    clearTimeout(timer);
    try { q.close(); } catch { /* already closed */ }
    abort.abort();
  }
}

/**
 * Codex: speaks JSON-RPC to `codex app-server` over stdio (initialize, then account/rateLimits/read).
 * The server exits when we close stdin / kill it. ChatGPT-plan logins return windows; API-key logins
 * and logged-out homes return an error, reported as "unavailable".
 */
export function probeCodexPlan(account: Account, executable: string, now = Date.now, timeoutMs = TIMEOUT_MS): Promise<PlanUsage> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server"], { shell: needsShell(executable), env: accountEnv(account, "CODEX_HOME", "OPENAI_API_KEY"), stdio: ["pipe", "pipe", "ignore"] });
    let buf = "", done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`quá ${Math.round(timeoutMs / 1000)}s không có phản hồi`))), timeoutMs);
    const send = (o: object) => child.stdin.write(JSON.stringify(o) + "\n");
    child.on("error", (e) => finish(() => reject(new Error(scrub(explainSpawnError(e, "codex"))))));
    child.on("exit", () => finish(() => reject(new Error("codex app-server thoát đột ngột"))));
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m: { id?: number; result?: unknown; error?: { message?: string } };
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read", params: null });
        } else if (m.id === 2) {
          if (m.error) {
            const msg = m.error.message ?? "lỗi không rõ";
            const auth = /authentication|log ?in|sign ?in|chatgpt/i.test(msg);
            finish(() => resolve({ account: account.id, provider: "codex", state: auth ? "unavailable" : "error", windows: [], fetchedAt: now(), note: auth ? "Codex chưa đăng nhập bằng tài khoản ChatGPT (API key không có hạn mức gói). Chạy: codex login" : scrub(msg) }));
          } else finish(() => resolve(fromCodexLimits(account.id, m.result, now())));
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agentroom", title: "AgentRoom", version: "0.8.0" } } });
  });
}

/** Picks the probe for an account's provider. `claude` / `codex` resolve the user's CLI (and may throw if it is missing). */
export function makePlanProbe(cli: { claude: () => string | undefined; codex: () => string }): (account: Account) => Promise<PlanUsage> {
  return (account) => (account.provider === "claude" ? probeClaudePlan(account, cli.claude()) : probeCodexPlan(account, cli.codex()));
}
