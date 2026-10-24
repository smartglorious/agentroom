import { tr } from "../core/i18n";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { AgentAdapter, TurnRequest, TurnResult, approvalAllowed, approvalReason } from "../adapters/types";
import { RateLimitError } from "../core/scheduler";
import { packSkills } from "../core/skills";
import { Account, HostDef, SSH_TARGET, Worker } from "../core/types";
import { LineDecoder, MIN_NODE_MAJOR, NEED_RUNNER, OLD_NODE, PriceEntry, ReadyInfo, RunnerToHub, TurnMessage, b64, encode, unb64 } from "./protocol";

export class HostConnectionError extends Error {}
export class HostDeniedError extends Error {}

/** The subset of a child process the connection needs (so tests can substitute their own). */
export interface ProcessLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(): unknown;
  on(event: "exit", cb: (code: number | null) => void): unknown;
  on(event: "error", cb: (e: Error) => void): unknown;
}

// ---------- building the ssh command ----------

export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const runnerHash = (runner: Buffer) => createHash("sha256").update(runner).digest("hex").slice(0, 16);

/**
 * Remote bootstrap, run through a login shell (so PATH comes from the user's profile):
 * check Node, ask the hub for the runner file only if this exact version is missing, run it.
 */
export function bootstrapScript(spec: Pick<HostDef, "node">, hash: string, size: number): string {
  const node = spec.node ? sq(spec.node) : "node";
  return [
    `f="$HOME/.agentroom/runner/${hash}.mjs"`,
    `mkdir -p "$HOME/.agentroom/runner" || exit 3`,
    `${node} -e "process.exit(parseInt(process.versions.node)>=${MIN_NODE_MAJOR}?0:42)"; c=$?`,
    `if [ $c -eq 42 ]; then echo ${OLD_NODE}; exit 42; fi`,
    `if [ $c -ne 0 ]; then exit $c; fi`,
    `if [ ! -f "$f" ]; then echo ${NEED_RUNNER}; head -c ${size} > "$f.part" && mv "$f.part" "$f" || exit 4; fi`,
    `exec ${node} "$f"`,
  ].join("\n");
}

/** One argument for `ssh <host> <arg>`: parsed by whatever the user's login shell is, so keep it to `sh -c '…'`. */
export function remoteCommand(script: string): string {
  const inner = `if command -v bash >/dev/null 2>&1; then exec bash -lc ${sq(script)}; else exec sh -lc ${sq(script)}; fi`;
  return `sh -c ${sq(inner)}`;
}

export function sshArgs(spec: HostDef, command: string): string[] {
  if (!SSH_TARGET.test(spec.ssh)) throw new Error(tr("Địa chỉ ssh không hợp lệ: \"{ssh}\"", { ssh: spec.ssh }));
  if (spec.identityFile?.startsWith("-")) throw new Error(tr("identityFile không hợp lệ: \"{identityFile}\"", { identityFile: spec.identityFile }));
  return [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${spec.connectTimeoutSec}`,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-T",
    ...(spec.port ? ["-p", String(spec.port)] : []),
    ...(spec.identityFile ? ["-i", spec.identityFile, "-o", "IdentitiesOnly=yes"] : []),
    "--", spec.ssh, command,
  ];
}

/** Turns what ssh / the remote shell printed into advice the user can act on. */
export function explainFailure(spec: HostDef, stderr: string, code: number | null, oldNode: boolean): string {
  const t = stderr.trim();
  const tail = t.split("\n").slice(-4).join(" | ").slice(0, 400);
  if (oldNode) return tr("Node trên máy \"{name}\" quá cũ (cần ≥ {MIN_NODE_MAJOR}). Cập nhật Node hoặc đặt hosts.{name}.node.", { name: spec.name, MIN_NODE_MAJOR });
  if (/Permission denied/i.test(t)) return tr("SSH từ chối đăng nhập vào {ssh}. AgentRoom dùng BatchMode (không hỏi mật khẩu): hãy dùng khoá SSH/ssh-agent và thử `ssh {ssh}` trong terminal.", { ssh: spec.ssh });
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(t)) return tr("Chưa xác nhận host key của {ssh}. Chạy `ssh {ssh}` một lần trong terminal để xác nhận, rồi thử lại.", { ssh: spec.ssh });
  if (/Could not resolve hostname|Name or service not known/i.test(t)) return tr("Không phân giải được tên máy \"{ssh}\". Kiểm tra lại hosts.{name}.ssh.", { ssh: spec.ssh, name: spec.name });
  if (/timed out|Connection refused|No route to host|Network is unreachable/i.test(t)) return tr("Không kết nối được tới {ssh}{p} ({tail}).", { ssh: spec.ssh, p: spec.port ? ":" + spec.port : "", tail });
  if (code === 127 || /: (command )?not found|No such file or directory/i.test(t)) return tr("Không tìm thấy node trên máy \"{name}\" (cần Node ≥ {MIN_NODE_MAJOR}). Cài Node hoặc đặt hosts.{name}.node = đường dẫn đầy đủ tới node.", { name: spec.name, MIN_NODE_MAJOR });
  return tr("Không khởi động được runner trên \"{name}\" (thoát mã {code}): {p}", { name: spec.name, code, p: tail || tr("không có thông báo") });
}

export function sshSpawner(spec: HostDef, runner: Buffer): () => ProcessLike {
  return () => {
    const args = sshArgs(spec, remoteCommand(bootstrapScript(spec, runnerHash(runner), runner.length)));
    return nodeSpawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] }) as unknown as ProcessLike;
  };
}

// ---------- one connection ----------

export type HostState = "idle" | "connecting" | "ready" | "error";

interface Pending {
  req: TurnRequest;
  resolve(r: TurnResult): void;
  reject(e: unknown): void;
  cleanup(): void;
}

export interface ConnectionDeps {
  spec: HostDef;
  spawn(): ProcessLike;
  /** Bytes sent when the host asks for the runner (ssh transport only). */
  runner?: Buffer;
  prices?: () => Record<string, PriceEntry>;
  readyTimeoutMs?: number;
  pingMs?: number;
  deadMs?: number;
  log?: (text: string) => void;
  /** Called when the runner file had to be copied to the host. */
  onRunnerUpload?: () => void;
}

export class HostConnection extends EventEmitter<{ change: [] }> {
  state: HostState = "idle";
  info?: ReadyInfo;
  error?: string;
  private proc?: ProcessLike;
  private pending = new Map<string, Pending>();
  private connecting?: Promise<void>;
  private stderrTail = "";
  private oldNode = false;
  private lastPong = 0;
  private pingTimer?: NodeJS.Timeout;
  private pingN = 0;

  constructor(private deps: ConnectionDeps) {
    super();
  }

  get name() { return this.deps.spec.name; }
  get inFlight() { return this.pending.size; }

  private set(state: HostState, error?: string) {
    this.state = state;
    this.error = error;
    this.emit("change");
  }

  connect(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    return (this.connecting ??= this.doConnect().finally(() => { this.connecting = undefined; }));
  }

  private doConnect(): Promise<void> {
    this.set("connecting");
    this.stderrTail = "";
    this.oldNode = false;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let proc: ProcessLike | undefined;

      /** Startup failed (reject the caller) or, once ready, the channel died (fail what is in flight). */
      const fail = (startup: string, afterReady: string) => {
        if (settled) { if (this.proc === proc) this.dropConnection(afterReady); return; }
        settled = true;
        if (timer) clearTimeout(timer);
        try { proc?.kill(); } catch { /* already gone */ }
        this.proc = undefined;
        this.set("error", startup);
        reject(new HostConnectionError(startup));
      };

      try { proc = this.deps.spawn(); } catch (e) { return fail(e instanceof Error ? e.message : String(e), ""); }
      const p = proc;
      this.proc = p;

      timer = setTimeout(() => fail(tr("Hết thời gian chờ runner trên \"{name}\". {p}", { name: this.name, p: this.stderrTail.trim().split("\n").slice(-2).join(" | ") }), ""), this.deps.readyTimeoutMs ?? 40_000);

      const decoder = new LineDecoder(
        (m) => this.onMessage(m as RunnerToHub, () => { if (!settled) { settled = true; clearTimeout(timer); this.set("ready"); this.startHeartbeat(); resolve(); } }),
        (line) => {
          if (line === NEED_RUNNER && this.deps.runner) { this.deps.log?.(tr("[{name}] cài runner ({p} MB)…", { name: this.name, p: (this.deps.runner.length / 1e6).toFixed(1) })); this.deps.onRunnerUpload?.(); p.stdin.write(this.deps.runner); }
          else if (line === OLD_NODE) this.oldNode = true;
          else this.deps.log?.(`[${this.name}] ${line}`);
        },
      );
      p.stdout.on("data", (c) => decoder.push(c));
      p.stderr.on("data", (c: Buffer) => { this.stderrTail = (this.stderrTail + c.toString("utf8")).slice(-4000); });
      p.stdin.on("error", () => undefined);
      p.on("error", (e) => {
        const msg = (e as NodeJS.ErrnoException).code === "ENOENT" ? tr("Không tìm thấy lệnh `ssh` trên máy này. Cài OpenSSH client.") : tr("Lỗi khởi động ssh: {message}", { message: e.message });
        fail(msg, msg);
      });
      p.on("exit", (code) => {
        const tail = this.stderrTail.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
        fail(explainFailure(this.deps.spec, this.stderrTail, code, this.oldNode), tr("kết nối SSH bị đóng (mã {code})", { code }) + (tail ? `: ${tail}` : ""));
      });
    });
  }

  private startHeartbeat() {
    this.lastPong = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPong > (this.deps.deadMs ?? 60_000)) return this.dropConnection(tr("Máy \"{name}\" không phản hồi (mất kết nối?).", { name: this.name }), true);
      this.send({ t: "ping", n: ++this.pingN });
    }, this.deps.pingMs ?? 20_000);
  }

  /** The channel is gone: fail everything in flight; the next turn reconnects. */
  private dropConnection(message: string, kill = false) {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    // Forget the process first: its own "exit" event must not be mistaken for a second failure.
    const dead = this.proc;
    this.proc = undefined;
    if (kill) { try { dead?.kill(); } catch { /* already gone */ } }
    const err = new HostConnectionError(tr("Mất kết nối tới \"{name}\": {message}", { name: this.name, message }));
    for (const p of [...this.pending.values()]) { p.cleanup(); p.reject(err); }
    this.pending.clear();
    this.set("error", message);
  }

  private send(msg: object) {
    const p = this.proc;
    if (!p || !p.stdin.writable) return;
    p.stdin.write(encode(msg as never));
  }

  private onMessage(m: RunnerToHub, onReady: () => void) {
    if (m.t === "ready") { this.info = m; onReady(); return; }
    if (m.t === "pong") { this.lastPong = Date.now(); return; }
    if (m.t === "log") { this.deps.log?.(`[${this.name}] ${m.text}`); return; }
    const p = this.pending.get(m.id);
    if (!p) return;
    switch (m.t) {
      case "started": p.req.onCwd?.(m.cwd); break;
      case "activity": p.req.onActivity(m.text); break;
      case "approve":
        Promise.resolve(p.req.approve(m.tool, m.input)).then(
          (r) => this.send({ t: "approval", reqId: m.reqId, allow: approvalAllowed(r), reason: approvalReason(r) }),
          () => this.send({ t: "approval", reqId: m.reqId, allow: false }),
        );
        break;
      case "mcp": void this.forwardMcp(p.req.mcpUrl, m); break;
      case "result": p.cleanup(); this.pending.delete(m.id); p.resolve({ sessionId: m.sessionId, text: m.text, usage: m.usage, cwd: m.cwd }); break;
      case "error":
        p.cleanup(); this.pending.delete(m.id);
        p.reject(m.rateLimit ? new RateLimitError(m.message, m.retryAfterMs) : new Error(m.message));
        break;
    }
  }

  /** Relays one MCP call from the remote agent to the hub's local MCP server. */
  private async forwardMcp(url: string, m: Extract<RunnerToHub, { t: "mcp" }>) {
    try {
      const body = m.method === "GET" || m.method === "HEAD" ? undefined : unb64(m.b64);
      const r = await fetch(url, { method: m.method, headers: m.headers, body });
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      this.send({ t: "mcp-res", reqId: m.reqId, status: r.status, headers, b64: b64(Buffer.from(await r.arrayBuffer())) });
    } catch (e) {
      this.send({ t: "mcp-res", reqId: m.reqId, status: 502, headers: { "content-type": "text/plain" }, b64: b64(String(e)) });
    }
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    if (!req.remote) throw new Error(tr("Thiếu thông tin remote cho lượt này"));
    const skills = packSkills(req.remote.skills);
    await this.connect();
    const id = randomUUID();
    const msg: TurnMessage = {
      t: "turn", id,
      worker: wireWorker(req.worker), account: wireAccount(req.account),
      base: req.remote.base, systemAppend: req.systemAppend, prompt: req.prompt, sessionId: req.sessionId, readOnly: req.readOnly, autonomy: req.autonomy,
      skills, claudePath: this.deps.spec.claudePath, codexPath: this.deps.spec.codexPath, pricing: this.deps.prices?.(),
    };
    return new Promise<TurnResult>((resolve, reject) => {
      const onAbort = () => this.send({ t: "abort", id });
      req.signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { req, resolve, reject, cleanup: () => req.signal.removeEventListener("abort", onAbort) });
      this.emit("change");
      if (req.signal.aborted) onAbort();
      this.send(msg);
    }).finally(() => this.emit("change"));
  }

  close() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    const err = new HostConnectionError(tr("Đã đóng kết nối tới \"{name}\".", { name: this.name }));
    for (const p of [...this.pending.values()]) { p.cleanup(); p.reject(err); }
    this.pending.clear();
    try { this.proc?.stdin.end(); } catch { /* ignore */ }
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.proc = undefined;
    this.state = "idle";
    this.emit("change");
  }
}

export const wireWorker = (w: Worker): TurnMessage["worker"] => ({
  id: w.id, name: w.name, role: w.role, model: w.model, allowedTools: w.allowedTools, tools: w.tools, sandbox: w.sandbox, useSkills: w.useSkills, worktree: w.worktree,
});

export const wireAccount = (a: Account): TurnMessage["account"] => ({ id: a.id, provider: a.provider, home: a.home, apiKeyEnv: a.apiKeyEnv });

// ---------- all hosts of a room ----------

export interface HostStatus {
  name: string;
  ssh: string;
  state: HostState;
  error?: string;
  inFlight: number;
  node?: string;
  platform?: string;
  hostname?: string;
  claude?: string;
  codex?: string;
  repo?: string;
}

export interface ManagerDeps {
  /** Builds the way to reach a host; defaults to ssh. */
  spawnerFor?: (spec: HostDef) => { spawn(): ProcessLike; runner?: Buffer };
  runner?: Buffer;
  /** Asked once per distinct host definition before the first connection. */
  confirm?: (spec: HostDef) => Promise<boolean>;
  prices?: () => Record<string, PriceEntry>;
  log?: (text: string) => void;
  timeouts?: Pick<ConnectionDeps, "readyTimeoutMs" | "pingMs" | "deadMs">;
  onRunnerUpload?: (host: string) => void;
}

/** The fingerprint a user approves: change any of it and they are asked again. */
export const fingerprint = (s: HostDef) => JSON.stringify([s.name, s.ssh, s.port ?? null, s.identityFile ?? null, s.node ?? null, s.repo ?? null, s.claudePath ?? null, s.codexPath ?? null]);

export class HostManager extends EventEmitter<{ change: [] }> implements AgentAdapter {
  private conns = new Map<string, HostConnection>();
  private allowed = new Set<string>();

  constructor(private specs: HostDef[], private deps: ManagerDeps) {
    super();
  }

  spec(name: string) { return this.specs.find((s) => s.name === name); }

  private connection(name: string): HostConnection {
    let c = this.conns.get(name);
    if (!c) {
      const spec = this.spec(name);
      if (!spec) throw new Error(tr("Không có host \"{name}\" trong hosts:", { name }));
      const t = this.deps.spawnerFor?.(spec) ?? { spawn: sshSpawner(spec, this.deps.runner ?? Buffer.alloc(0)), runner: this.deps.runner };
      c = new HostConnection({ spec, spawn: t.spawn, runner: t.runner, prices: this.deps.prices, log: this.deps.log, onRunnerUpload: () => this.deps.onRunnerUpload?.(name), ...this.deps.timeouts });
      c.on("change", () => this.emit("change"));
      this.conns.set(name, c);
    }
    return c;
  }

  private async allow(spec: HostDef) {
    const fp = fingerprint(spec);
    if (this.allowed.has(fp)) return;
    if (this.deps.confirm && !(await this.deps.confirm(spec))) throw new HostDeniedError(tr("Bạn chưa cho phép AgentRoom kết nối SSH tới \"{name}\" ({ssh}).", { name: spec.name, ssh: spec.ssh }));
    this.allowed.add(fp);
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const name = req.remote?.host;
    if (!name) throw new Error(tr("Lượt này không có host"));
    const spec = this.spec(name);
    if (!spec) throw new Error(tr("Không có host \"{name}\" trong hosts:", { name }));
    await this.allow(spec);
    return this.connection(name).runTurn(req);
  }

  /** Connects to one or all hosts (asking for permission first) and reports their state. */
  async check(name?: string): Promise<HostStatus[]> {
    const targets = this.specs.filter((s) => !name || s.name === name);
    await Promise.all(targets.map(async (s) => {
      try { await this.allow(s); await this.connection(s.name).connect(); } catch { /* the error is on the connection */ }
    }));
    return this.statuses();
  }

  statuses(): HostStatus[] {
    return this.specs.map((s) => {
      const c = this.conns.get(s.name);
      return {
        name: s.name, ssh: s.ssh, repo: s.repo,
        state: c?.state ?? "idle", error: c?.error, inFlight: c?.inFlight ?? 0,
        node: c?.info?.node, platform: c?.info ? `${c.info.platform}/${c.info.arch}` : undefined, hostname: c?.info?.hostname, claude: c?.info?.claude, codex: c?.info?.codex,
      };
    });
  }

  closeAll() {
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
  }
}
